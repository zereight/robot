import {
  clampPlaceListWidth,
  filterPlaces,
  type MessageKey,
  PLACE_LIST_MAX,
  PLACE_LIST_MIN,
  type Place,
  type SectionId,
} from "@robot/shared"
import { ChevronDown, Hash } from "lucide-solid"
import {
  createMemo,
  createSignal,
  For,
  type JSX,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
} from "solid-js"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { motionMs, Presence, useClosing } from "../ui/Presence.tsx"
import styles from "./shell.module.css"

/** Extra px while a drag is past a limit: it grows with the excess and tops out at 28. */
const stretchPast = (raw: number) => {
  const excess =
    raw > PLACE_LIST_MAX ? raw - PLACE_LIST_MAX : raw < PLACE_LIST_MIN ? raw - PLACE_LIST_MIN : 0
  const grown = (28 * Math.abs(excess)) / (Math.abs(excess) + 64)
  return Math.sign(excess) * grown
}

export interface PlaceListProps {
  /** Draws the face of an agent place. Later features supply it. */
  face?: (place: Place) => JSX.Element
  sectionAction?: (section: SectionId) => JSX.Element
}

const rowSelector = "[data-place-row]"

/** The rows of one section. Grows open and shrinks closed. */
const SectionBody = (props: ParentProps) => {
  const closing = useClosing()
  return (
    <div class={styles.sectionBody} data-closing={closing()}>
      {props.children}
    </div>
  )
}

export const PlaceList = (props: PlaceListProps) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const [query, setQuery] = createSignal("")
  let search: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined

  const sections = createMemo(() => filterPlaces(ui.sections(), query()))
  const searching = () => query().trim().length > 0
  const anyMatch = () => sections().some((s) => s.places.length > 0)

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault()
        search?.focus()
        search?.select()
      }
    }
    window.addEventListener("keydown", onKey)
    // Arrow keys move between rows, the way a list box works.
    list?.addEventListener("keydown", onListKey)
    onCleanup(() => {
      window.removeEventListener("keydown", onKey)
      list?.removeEventListener("keydown", onListKey)
    })
  })

  const rows = () => [...(list?.querySelectorAll<HTMLElement>(rowSelector) ?? [])]

  function onListKey(event: KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const all = rows()
    const index = all.indexOf(document.activeElement as HTMLElement)
    event.preventDefault()
    if (event.key === "ArrowDown") all[Math.min(all.length - 1, index + 1)]?.focus()
    else if (index <= 0) search?.focus()
    else all[index - 1]?.focus()
  }

  const onSearchKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setQuery("")
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      rows()[0]?.focus()
    } else if (event.key === "Enter") {
      rows()[0]?.click()
    }
  }

  const startResize = (event: PointerEvent) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = ui.ui.placeListWidth
    const target = event.currentTarget as HTMLElement
    target.setPointerCapture(event.pointerId)
    ui.setSnapping(false)
    const move = (e: PointerEvent) => {
      const raw = startWidth + e.clientX - startX
      ui.previewWidth(clampPlaceListWidth(raw))
      ui.setStretch(stretchPast(raw))
    }
    const end = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", end)
      ui.saveWidth()
      if (ui.stretch() !== 0) {
        ui.setSnapping(true)
        ui.setStretch(0)
        setTimeout(() => ui.setSnapping(false), motionMs("medium") + 40)
      }
    }
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", end)
  }

  const resizeByKey = (event: KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? -10 : event.key === "ArrowRight" ? 10 : 0
    if (!step) return
    event.preventDefault()
    // A key press is not animated.
    ui.setSnapping(false)
    ui.setStretch(0)
    ui.previewWidth(clampPlaceListWidth(ui.ui.placeListWidth + step))
    ui.saveWidth()
  }

  const accessibleName = (place: Place) =>
    [
      place.name,
      place.working ? t("places.working") : "",
      place.unread > 0 ? t("places.unread", { count: place.unread }) : "",
      place.lastMessage ? t("places.lastMessage", { message: place.lastMessage }) : "",
    ]
      .filter(Boolean)
      .join(", ")

  return (
    <aside
      class={styles.places}
      aria-label={t("places.label")}
      data-compact={app.settings.compactPlaces}
      data-testid="place-list"
    >
      <div class={styles.placesTop}>
        <input
          ref={search}
          class={styles.search}
          type="search"
          placeholder={t("places.search")}
          aria-label={t("places.search")}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={onSearchKey}
          data-testid="place-search"
        />
      </div>
      <div class={styles.placeScroll} ref={list}>
        <Show
          when={!searching() || anyMatch()}
          fallback={<div class={styles.sectionEmpty}>{t("places.noMatch")}</div>}
        >
          <For each={sections()}>
            {(section) => {
              const collapsed = () => ui.ui.collapsed.includes(section.id) && !searching()
              return (
                <Show when={!searching() || section.places.length > 0}>
                  <section data-testid={`section-${section.id}`}>
                    <div class={styles.sectionTop}>
                      <button
                        type="button"
                        class={styles.sectionHeader}
                        aria-expanded={!collapsed()}
                        onClick={() => ui.toggleSection(section.id)}
                        data-testid={`section-toggle-${section.id}`}
                      >
                        <span class={styles.chevron}>
                          <ChevronDown size={12} />
                        </span>
                        {t(`places.section.${section.id}` as MessageKey)}
                      </button>
                      {props.sectionAction?.(section.id)}
                    </div>
                    <Presence when={!collapsed()}>
                      {() => (
                        <SectionBody>
                          <Show
                            when={section.places.length > 0}
                            fallback={
                              <div class={styles.sectionEmpty}>
                                {t(`places.empty.${section.id}` as MessageKey)}
                              </div>
                            }
                          >
                            <For each={section.places}>
                              {(place) => {
                                const selected = () =>
                                  ui.ui.page === "chats" &&
                                  ui.place()?.kind === place.kind &&
                                  ui.place()?.id === place.id
                                return (
                                  <button
                                    type="button"
                                    class={styles.row}
                                    data-place-row
                                    data-testid={`place-${place.kind}-${place.id}`}
                                    data-unread={place.unread > 0}
                                    aria-current={selected()}
                                    aria-label={accessibleName(place)}
                                    onClick={() =>
                                      ui.selectPlace({ kind: place.kind, id: place.id })
                                    }
                                  >
                                    <span class={styles.mark}>
                                      {place.kind === "channel" ? (
                                        <Hash size={18} />
                                      ) : (
                                        props.face?.(place)
                                      )}
                                      <Show when={place.working}>
                                        <span class={styles.workingDot} data-testid="working-dot" />
                                      </Show>
                                    </span>
                                    <span class={styles.rowName}>{place.name}</span>
                                    <Show when={place.unread > 0}>
                                      <span class={styles.badge}>{place.unread}</span>
                                    </Show>
                                  </button>
                                )
                              }}
                            </For>
                          </Show>
                        </SectionBody>
                      )}
                    </Presence>
                  </section>
                </Show>
              )
            }}
          </For>
        </Show>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a focusable window splitter has no native element */}
      <div
        class={styles.resizer}
        role="separator"
        aria-orientation="vertical"
        aria-label={t("places.resize")}
        aria-valuemin={PLACE_LIST_MIN}
        aria-valuemax={PLACE_LIST_MAX}
        aria-valuenow={ui.ui.placeListWidth}
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeByKey}
        data-testid="place-list-resizer"
      />
    </aside>
  )
}
