import {
  allPlaces,
  builtInSection,
  canMoveSection,
  clampPlaceListWidth,
  filterPlaces,
  type MessageKey,
  markedParts,
  PLACE_LIST_MAX,
  PLACE_LIST_MIN,
  type Place,
  type PlaceKind,
  type PlaceSection,
  SECTION_NAME_MAX,
  type SearchHit,
  type SectionId,
  type SectionSummary,
  searchWords,
  sectionKind,
  summarize,
  type UserSectionView,
} from "@robot/shared"
import { ChevronDown, Ellipsis, Hash } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  type ParentProps,
  Show,
} from "solid-js"
import { formatHitTime } from "../chat/format.ts"
import { openThread } from "../chat/threads.ts"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { AgentName } from "../orgs/AgentName.tsx"
import { useApp } from "../state/app.tsx"
import { setFocusMessage, setSearchOrigin } from "../state/focus.ts"
import { linkEpoch } from "../state/link.ts"
import { useOrgs } from "../state/orgs.tsx"
import { useUi } from "../state/ui.tsx"
import { AvatarMark } from "../ui/AvatarMark.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { type MenuItem, PopupMenu } from "../ui/Menu.tsx"
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

/** The rows that the arrow keys move through: places first, then the hits of message search. */
const rowSelector = "[data-place-row], [data-hit-row]"

/** The rows of one section. Grows open and shrinks closed. */
const SectionBody = (props: ParentProps) => {
  const closing = useClosing()
  return (
    <div class={styles.sectionBody} data-closing={closing()}>
      {props.children}
    </div>
  )
}

/** The box for the name of a new section, or for the new name of one. Enter saves. Escape cancels. */
const NameBox = (props: {
  initial?: string
  label: string
  /** Saves the name. A refused name throws, and the box stays open and tells why. */
  onSave: (name: string) => Promise<void>
  onCancel: () => void
  testId: string
}) => {
  const { t } = useApp()
  const [value, setValue] = createSignal(props.initial ?? "")
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  let input: HTMLInputElement | undefined
  onMount(() => {
    input?.focus()
    input?.select()
  })
  const save = async () => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await props.onSave(value())
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class={styles.nameBox}>
      <input
        ref={input}
        class={styles.nameInput}
        value={value()}
        maxLength={SECTION_NAME_MAX}
        aria-label={props.label}
        aria-invalid={error() !== undefined}
        onInput={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            void save()
          } else if (e.key === "Escape") {
            e.preventDefault()
            e.stopPropagation()
            props.onCancel()
          }
        }}
        // A box that was left with no text goes away. Text that the user typed stays.
        onBlur={() => value().trim() === "" && props.onCancel()}
        data-testid={props.testId}
      />
      <Show when={error()}>
        {(err) => (
          <div class={styles.nameError} role="alert" data-testid="section-name-error">
            {t(err().key, err().params)}
          </div>
        )}
      </Show>
    </div>
  )
}

interface MenuState {
  readonly items: readonly MenuItem[]
  readonly label: string
  readonly top: number
  readonly left: number
  /** Gets the focus back when the menu closes with Escape. */
  readonly returnTo?: HTMLElement
}

/** What the user drags: a place row. */
interface Dragged {
  readonly kind: PlaceKind
  readonly id: string
  readonly sectionId: string | null
}

export const PlaceList = (props: PlaceListProps) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const orgs = useOrgs()
  const [query, setQuery] = createSignal("")
  const [menu, setMenu] = createSignal<MenuState>()
  const [renaming, setRenaming] = createSignal<string>()
  const [deleting, setDeleting] = createSignal<{ id: string; name: string }>()
  const [dragging, setDragging] = createSignal<Dragged>()
  /** The header under the pointer while a place is dragged: a user section id, or `built-in:id`. */
  const [dropKey, setDropKey] = createSignal<string>()
  let dragCancelled = false
  let search: HTMLInputElement | undefined
  let list: HTMLDivElement | undefined

  /**
   * A linked server shows its sections and where its places are, and that is all (spec 001, 012):
   * a client makes, renames, orders and deletes no section, and moves no place.
   */
  const readOnly = () => ui.linked()

  // The search also matches the whole name of the organization of an agent, with the prefix on (spec 036).
  const sections = createMemo(() =>
    filterPlaces(ui.sections(), query(), (place) =>
      place.kind === "agent" ? orgs.prefixOrg(place.id) : null,
    ),
  )
  const searching = () => query().trim().length > 0
  const anyMatch = () => sections().some((s) => allPlaces(s).length > 0)

  // Message search (spec 001) ------------------------------------------------------------------

  const [hits, setHits] = createSignal<readonly SearchHit[]>([])
  const [more, setMore] = createSignal(false)
  const [capped, setCapped] = createSignal(false)
  /** True when the hits come from the saved messages of a linked server that is offline. */
  const [cached, setCached] = createSignal(false)
  /** A search is on its way: it waits for the typing to stop, or for the answer. */
  const [pending, setPending] = createSignal(false)
  /** The search runs for more than 300 ms. */
  const [slow, setSlow] = createSignal(false)
  const [loadingMore, setLoadingMore] = createSignal(false)
  let searchRun = 0
  let searchedServer: string | undefined

  /** The text is long enough to look in the messages too. */
  const messageSearch = () => searchWords(query()) !== null
  const clearHits = () => {
    setHits([])
    setMore(false)
    setCapped(false)
    setCached(false)
  }
  const takePage = (
    page: { hits: readonly SearchHit[]; more: boolean; capped: boolean; cached: boolean },
    append: boolean,
  ) => {
    if (append) {
      const known = new Set(hits().map((h) => h.messageId))
      setHits([...hits(), ...page.hits.filter((h) => !known.has(h.messageId))])
    } else setHits(page.hits)
    setMore(page.more)
    setCapped(page.capped)
    setCached(page.cached)
  }

  createEffect(
    on(
      () => [query(), ui.server()?.id, ui.server()?.state, linkEpoch.value()] as const,
      ([text, serverId]) => {
        const run = ++searchRun
        setLoadingMore(false)
        // Hits of another server must not stay on screen while the new answer is on its way.
        if (serverId !== searchedServer) clearHits()
        searchedServer = serverId
        if (!serverId || searchWords(text) === null) {
          clearHits()
          setPending(false)
          setSlow(false)
          return
        }
        setPending(true)
        // The user may still type: the request goes out when the typing pauses.
        const wait = setTimeout(() => {
          const late = setTimeout(() => run === searchRun && setSlow(true), 300)
          call("messages.search", { serverId, query: text, offset: 0 })
            .then((page) => run === searchRun && takePage(page, false))
            .catch(() => run === searchRun && clearHits())
            .finally(() => {
              clearTimeout(late)
              if (run !== searchRun) return
              setPending(false)
              setSlow(false)
            })
        }, 150)
        onCleanup(() => clearTimeout(wait))
      },
    ),
  )

  const showMore = async () => {
    const serverId = ui.server()?.id
    if (!serverId || loadingMore()) return
    const run = searchRun
    setLoadingMore(true)
    try {
      const page = await call("messages.search", {
        serverId,
        query: query(),
        offset: hits().length,
      })
      if (run === searchRun) takePage(page, true)
    } catch {
      // The hits that show stay as they are.
    } finally {
      if (run === searchRun) setLoadingMore(false)
    }
  }

  /** Opens the place of a hit, and shows the message there. "Back" there returns to this place. */
  const openHit = (hit: SearchHit) => {
    const from = ui.place()
    const to = { kind: hit.kind, id: hit.placeId }
    const here = ui.ui.page === "chats" && from?.kind === to.kind && from.id === to.id
    setSearchOrigin(from && !here ? { serverId: ui.server()?.id, from, to } : undefined)
    // A hit in a thread opens that thread (spec 001, 003).
    if (hit.kind === "agent") openThread(hit.placeId, hit.threadId)
    ui.selectPlace(to)
    setFocusMessage(hit.messageId)
  }
  /** The user sections of a built-in section in their true order, also when search hides some. */
  const userSectionsOf = (id: SectionId) => ui.sections().find((s) => s.id === id)?.sections ?? []

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

  /** The rows that show, in the order shown. A section that is closing has none. */
  const rows = () =>
    [...(list?.querySelectorAll<HTMLElement>(rowSelector) ?? [])].filter(
      (row) => !row.closest('[data-closing="true"]'),
    )

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

  /** The role line that a row shows: an agent with one has it. A channel never does. */
  const roleOf = (place: Place) =>
    place.kind === "agent" && place.role?.trim() ? place.role.trim() : undefined

  /** The name of a row for a screen reader: the prefix adds the whole organization name (spec 036). */
  const labelOf = (place: Place) =>
    place.kind === "agent" ? orgs.shown(place.id, place.name).label : place.name

  const accessibleName = (place: Place) =>
    [
      labelOf(place),
      // The whole role line is part of the name of an agent row (spec 001).
      roleOf(place) ? t("places.role", { role: roleOf(place) ?? "" }) : "",
      place.working ? t("places.working") : "",
      place.unread > 0 ? t("places.unread", { count: place.unread }) : "",
      place.lastMessage ? t("places.lastMessage", { message: place.lastMessage }) : "",
    ]
      .filter(Boolean)
      .join(", ")

  /** The name of a collapsed header for a screen reader: the name, then what the badge tells. */
  const headerName = (name: string, summary: SectionSummary) =>
    [
      name,
      summary.working ? t("places.working") : "",
      summary.unread > 0 ? t("places.unread", { count: summary.unread }) : "",
    ]
      .filter(Boolean)
      .join(", ")

  // Menus ---------------------------------------------------------------------------------

  const openMenu = (state: MenuState) => setMenu(state)

  /** Opens a menu where the pointer is. A key press has no pointer, so it opens under the element. */
  const menuAt = (event: MouseEvent, element: HTMLElement) => {
    if (event.clientX === 0 && event.clientY === 0) {
      const box = element.getBoundingClientRect()
      return { top: box.bottom, left: box.left + 16 }
    }
    return { top: event.clientY, left: event.clientX }
  }

  const placeMenu = (event: MouseEvent, place: Place) => {
    event.preventDefault()
    const row = event.currentTarget as HTMLElement
    const kind = place.kind
    const mine = userSectionsOf(builtInSection(kind))
    const pick = (sectionId: string | null) => () =>
      ui.movePlace({ kind: place.kind, id: place.id }, sectionId)
    openMenu({
      label: place.name,
      returnTo: row,
      ...menuAt(event, row),
      items: [
        {
          label: t("sections.moveTo"),
          heading: true,
          onSelect: () => {},
          testId: "move-to-section",
        },
        ...mine.map(
          (s): MenuItem => ({
            label: s.name,
            checked: place.sectionId === s.id,
            onSelect: pick(s.id),
            testId: `move-to-${s.id}`,
          }),
        ),
        {
          label: t("sections.none"),
          checked: place.sectionId === null,
          onSelect: pick(null),
          testId: "move-to-none",
        },
      ],
    })
  }

  const sectionMenu = (
    at: { top: number; left: number },
    builtIn: SectionId,
    section: UserSectionView,
    returnTo: HTMLElement | undefined,
  ) => {
    const all = userSectionsOf(builtIn)
    const ids = all.map((s) => s.id)
    // Search can hide some places of the view. The real section tells if it holds any.
    const holdsPlaces = (all.find((s) => s.id === section.id) ?? section).places.length > 0
    openMenu({
      label: section.name,
      ...at,
      ...(returnTo ? { returnTo } : {}),
      items: [
        {
          label: t("sections.rename"),
          onSelect: () => setRenaming(section.id),
          testId: "section-rename",
        },
        {
          label: t("sections.moveUp"),
          disabled: !canMoveSection(ids, section.id, "up"),
          onSelect: () => void ui.moveSection(section.id, "up"),
          testId: "section-move-up",
        },
        {
          label: t("sections.moveDown"),
          disabled: !canMoveSection(ids, section.id, "down"),
          onSelect: () => void ui.moveSection(section.id, "down"),
          testId: "section-move-down",
        },
        {
          label: t("sections.delete"),
          onSelect: () =>
            holdsPlaces
              ? setDeleting({ id: section.id, name: section.name })
              : void ui.deleteSection(section.id),
          testId: "section-delete",
        },
      ],
    })
  }

  // Drag and drop ---------------------------------------------------------------------------

  const endDrag = () => {
    setDragging(undefined)
    setDropKey(undefined)
    window.removeEventListener("keydown", onDragKey, true)
  }
  onCleanup(() => window.removeEventListener("keydown", onDragKey, true))
  // Escape cancels the drag. The system cancels it too, but a drop that follows must do nothing.
  function onDragKey(event: KeyboardEvent) {
    if (event.key !== "Escape") return
    dragCancelled = true
    setDropKey(undefined)
  }

  const startDrag = (event: DragEvent, place: Place) => {
    dragCancelled = false
    setDragging({ kind: place.kind, id: place.id, sectionId: place.sectionId })
    window.addEventListener("keydown", onDragKey, true)
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move"
      // Some systems start no drag without data. The name is not used.
      event.dataTransfer.setData("text/plain", place.name)
    }
  }

  /** The handlers of a header that takes dropped rows. A header of the other kind refuses them. */
  const dropTarget = (key: string, kind: PlaceKind, sectionId: string | null) => {
    const over = (event: DragEvent) => {
      const drag = dragging()
      if (!drag || drag.kind !== kind || dragCancelled) {
        if (event.dataTransfer) event.dataTransfer.dropEffect = "none"
        if (dropKey() === key) setDropKey(undefined)
        return
      }
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      setDropKey(key)
    }
    return {
      onDragEnter: over,
      onDragOver: over,
      onDragLeave: (event: DragEvent) => {
        const to = event.relatedTarget as Node | null
        if (!to || !(event.currentTarget as HTMLElement).contains(to))
          setDropKey((current) => (current === key ? undefined : current))
      },
      onDrop: (event: DragEvent) => {
        event.preventDefault()
        const drag = dragging()
        const accepted = drag && drag.kind === kind && !dragCancelled
        endDrag()
        if (accepted && drag.sectionId !== sectionId)
          void ui.movePlace({ kind: drag.kind, id: drag.id }, sectionId)
      },
    }
  }

  // Parts of the list ---------------------------------------------------------------------

  const renderRow = (place: Place) => {
    const selected = () =>
      ui.ui.page === "chats" && ui.place()?.kind === place.kind && ui.place()?.id === place.id
    return (
      <button
        type="button"
        class={styles.row}
        draggable={readOnly() ? "false" : "true"}
        data-place-row
        data-place-name={place.name}
        data-testid={`place-${place.kind}-${place.id}`}
        data-unread={place.unread > 0}
        data-dragging={dragging()?.id === place.id}
        aria-current={selected()}
        aria-label={accessibleName(place)}
        onClick={() => ui.selectPlace({ kind: place.kind, id: place.id })}
        onContextMenu={(event) => {
          if (!readOnly()) placeMenu(event, place)
        }}
        onDragStart={(event) => {
          if (readOnly()) event.preventDefault()
          else startDrag(event, place)
        }}
        onDragEnd={endDrag}
      >
        <span class={styles.mark}>
          {/* The window draws a channel with its picture, or the mark with the `#`. */}
          {place.kind === "channel"
            ? (props.face?.(place) ?? <AvatarMark icon={Hash} size={24} testId="channel-mark" />)
            : props.face?.(place)}
          <Show when={place.working}>
            <span class={styles.workingDot} data-testid="working-dot" />
          </Show>
        </span>
        <span class={styles.rowName} data-with-badge={roleOf(place) ? "true" : undefined}>
          {place.kind === "agent" ? <AgentName id={place.id} name={place.name} /> : place.name}
        </span>
        {/* The badge is the role line of an agent. A channel never has one. The name comes first:
            the slot is what is left of the row, the badge is cut with an ellipsis inside it, and
            it hides when less than 4 characters of it fit (the sheet does that). */}
        <Show when={roleOf(place)}>
          {(role) => (
            <span class={styles.roleSlot}>
              <span class={styles.roleBadge} title={role()} data-testid="role-badge" data-user-data>
                {role()}
              </span>
            </span>
          )}
        </Show>
        <Show when={place.unread > 0}>
          <span class={styles.badge}>{place.unread}</span>
        </Show>
      </button>
    )
  }

  /** The chevron, the name, and on a collapsed header the working dot and the unread sum. */
  const headerContent = (name: JSX.Element, collapsed: boolean, summary: SectionSummary) => (
    <>
      <span class={styles.chevron}>
        <ChevronDown size={12} />
      </span>
      <span class={styles.headerName}>{name}</span>
      <Show when={collapsed && summary.working}>
        <span class={styles.headerDot} data-testid="section-working-dot" />
      </Show>
      <Show when={collapsed && summary.unread > 0}>
        <span class={styles.badge} data-testid="section-badge">
          {summary.unread}
        </span>
      </Show>
    </>
  )

  const renderUserSection = (builtIn: SectionId, section: UserSectionView) => {
    const kind = sectionKind(builtIn)
    const collapsed = () => ui.ui.collapsed.includes(section.id) && !searching()
    const summary = () => summarize(section.places)
    let toggle: HTMLButtonElement | undefined
    let more: HTMLButtonElement | undefined
    return (
      <div
        class={styles.userSection}
        data-testid="user-section"
        data-section-id={section.id}
        data-kind={kind}
        data-readonly={readOnly() ? "true" : undefined}
      >
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a right click is a shortcut; the menu button of the header does the same with the keyboard */}
        <div
          class={styles.sectionTop}
          data-drop={dropKey() === section.id}
          data-testid="user-section-header"
          onContextMenu={(event) => {
            if (readOnly()) return
            event.preventDefault()
            sectionMenu(menuAt(event, event.currentTarget), builtIn, section, toggle)
          }}
          {...(readOnly() ? {} : dropTarget(section.id, kind, section.id))}
        >
          <Show
            when={renaming() !== section.id}
            fallback={
              <NameBox
                initial={section.name}
                label={t("sections.name")}
                testId="section-rename-input"
                onSave={async (name) => {
                  if (name.trim() !== section.name) await ui.renameSection(section.id, name)
                  setRenaming(undefined)
                }}
                onCancel={() => setRenaming(undefined)}
              />
            }
          >
            <button
              ref={toggle}
              type="button"
              class={styles.sectionHeader}
              aria-expanded={!collapsed()}
              aria-label={collapsed() ? headerName(section.name, summary()) : undefined}
              onClick={() => ui.toggleSection(section.id)}
              data-testid="user-section-toggle"
            >
              {headerContent(<span data-user-data>{section.name}</span>, collapsed(), summary())}
            </button>
            <Show when={!readOnly()}>
              <IconButton
                ref={more}
                class={styles.sectionAction}
                label={t("sections.menu", { name: section.name })}
                aria-haspopup="menu"
                onClick={() => {
                  const box = more?.getBoundingClientRect()
                  if (box)
                    sectionMenu({ top: box.bottom + 4, left: box.left }, builtIn, section, more)
                }}
                data-testid="section-menu"
              >
                <Ellipsis size={14} />
              </IconButton>
            </Show>
          </Show>
        </div>
        <Presence when={!collapsed()}>
          {() => (
            <SectionBody>
              <Show
                when={section.places.length > 0}
                fallback={
                  <div class={styles.sectionEmpty} data-testid="user-section-empty">
                    {t(readOnly() ? "sections.emptyLinked" : "sections.empty")}
                  </div>
                }
              >
                <For each={section.places}>{renderRow}</For>
              </Show>
            </SectionBody>
          )}
        </Presence>
      </div>
    )
  }

  /** The face, picture or mark of the place of a hit, as the window draws it. */
  const hitFace = (hit: SearchHit) =>
    props.face?.({
      kind: hit.kind,
      id: hit.placeId,
      name: hit.placeName,
      unread: 0,
      working: false,
      lastMessage: null,
      sectionId: null,
    })

  const renderHit = (hit: SearchHit) => {
    const time = () => formatHitTime(app.locale(), hit.createdAt)
    return (
      <button
        type="button"
        class={styles.hit}
        data-hit-row
        data-testid="search-hit"
        data-message-id={hit.messageId}
        data-hit-place={hit.placeName}
        aria-label={t("search.hit", {
          place:
            hit.kind === "agent" ? orgs.shown(hit.placeId, hit.placeName).label : hit.placeName,
          time: time(),
          text: hit.snippet,
        })}
        onClick={() => openHit(hit)}
      >
        <span class={styles.hitHead}>
          <span class={styles.hitMark}>
            {hit.kind === "channel"
              ? (hitFace(hit) ?? <AvatarMark icon={Hash} size={24} />)
              : hitFace(hit)}
          </span>
          <span class={styles.hitPlace} data-user-data>
            {hit.kind === "agent" ? (
              <AgentName id={hit.placeId} name={hit.placeName} />
            ) : (
              hit.placeName
            )}
          </span>
          <span class={styles.hitTime}>{time()}</span>
        </span>
        <span class={styles.hitText} data-user-data data-testid="search-hit-text">
          <For each={markedParts(hit.snippet, hit.marks)}>
            {(part) => (part.marked ? <mark>{part.text}</mark> : part.text)}
          </For>
        </span>
      </button>
    )
  }

  const renderSection = (section: PlaceSection) => {
    const kind = sectionKind(section.id)
    const collapsed = () => ui.ui.collapsed.includes(section.id) && !searching()
    const summary = () => summarize(allPlaces(section))
    return (
      <Show when={!searching() || allPlaces(section).length > 0}>
        <section data-testid={`section-${section.id}`} data-kind={kind}>
          <div
            class={styles.sectionTop}
            data-drop={dropKey() === `built-in:${section.id}`}
            data-testid={`section-header-${section.id}`}
            {...(readOnly() ? {} : dropTarget(`built-in:${section.id}`, kind, null))}
          >
            <button
              type="button"
              class={styles.sectionHeader}
              aria-expanded={!collapsed()}
              aria-label={
                collapsed()
                  ? headerName(t(`places.section.${section.id}` as MessageKey), summary())
                  : undefined
              }
              onClick={() => ui.toggleSection(section.id)}
              data-testid={`section-toggle-${section.id}`}
            >
              {headerContent(
                t(`places.section.${section.id}` as MessageKey),
                collapsed(),
                summary(),
              )}
            </button>
            {props.sectionAction?.(section.id)}
          </div>
          <Presence when={!collapsed()}>
            {() => (
              <SectionBody>
                <Show
                  when={section.places.length > 0 || section.sections.length > 0}
                  fallback={
                    <div class={styles.sectionEmpty}>
                      {t(`places.empty.${section.id}` as MessageKey)}
                    </div>
                  }
                >
                  <For each={section.places}>{renderRow}</For>
                  <For each={section.sections}>{(user) => renderUserSection(section.id, user)}</For>
                </Show>
                <Show when={!readOnly() && ui.newSectionKind() === kind}>
                  <div class={styles.userSection}>
                    <NameBox
                      label={t("sections.name")}
                      testId="section-new-input"
                      onSave={(name) => ui.createSection(kind, name)}
                      onCancel={ui.cancelNewSection}
                    />
                  </div>
                </Show>
              </SectionBody>
            )}
          </Presence>
        </section>
      </Show>
    )
  }

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
        <Show when={messageSearch() && cached()}>
          <div class={styles.sectionEmpty} role="status" data-testid="search-offline">
            {t("search.offline", { name: ui.server()?.name ?? "" })}
          </div>
        </Show>
        {/* A section with no match hides itself while the user searches. */}
        <For each={sections()}>{renderSection}</For>
        <Show when={messageSearch() && (hits().length > 0 || slow())}>
          <section data-testid="search-messages" aria-label={t("search.messages")}>
            <div class={styles.sectionTop}>
              <span class={styles.groupHeader}>{t("search.messages")}</span>
            </div>
            <For each={hits()}>{renderHit}</For>
            <Show when={more()}>
              <button
                type="button"
                class={styles.showMore}
                aria-busy={loadingMore()}
                disabled={loadingMore()}
                onClick={() => void showMore()}
                data-testid="search-more"
              >
                {t("search.more")}
              </button>
            </Show>
            <Show when={!more() && capped()}>
              <div class={styles.sectionEmpty} data-testid="search-capped">
                {t("search.capped")}
              </div>
            </Show>
            <Show when={slow()}>
              <div class={styles.sectionEmpty} role="status" data-testid="search-searching">
                {t("search.searching")}
              </div>
            </Show>
          </section>
        </Show>
        <Show when={searching() && !anyMatch() && hits().length === 0 && !pending()}>
          <div class={styles.sectionEmpty} data-testid="search-nothing">
            {t("places.noMatch")}
          </div>
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
      <Show when={menu()}>
        {(open) => (
          <PopupMenu
            items={open().items}
            label={open().label}
            top={open().top}
            left={open().left}
            testId="place-menu"
            onClose={(refocus) => {
              const back = open().returnTo
              setMenu(undefined)
              if (refocus) back?.focus()
            }}
          />
        )}
      </Show>
      <Presence when={deleting()}>
        {(target) => (
          <Dialog
            label={t("sections.delete.title")}
            onClose={() => setDeleting(undefined)}
            testId="section-delete-dialog"
          >
            <h2>{t("sections.delete.title")}</h2>
            <p>{t("sections.delete.body", { name: target.name })}</p>
            <div class={styles.dialogActions}>
              <Button onClick={() => setDeleting(undefined)} data-testid="section-delete-back">
                {t("sections.delete.back")}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  setDeleting(undefined)
                  void ui.deleteSection(target.id)
                }}
                data-testid="section-delete-confirm"
              >
                {t("sections.delete")}
              </Button>
            </div>
          </Dialog>
        )}
      </Presence>
    </aside>
  )
}
