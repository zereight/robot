import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import styles from "./controls.module.css"
import { IconButton } from "./controls.tsx"

export interface MenuItem {
  readonly label: string
  readonly onSelect: () => void
  readonly testId?: string
  /** A small mark before the label, for example the play mark of a setup action. */
  readonly icon?: JSX.Element
  /** Extra text for the pointer, for example the command of a setup action. */
  readonly title?: string
  /** A line of text with no action, above a group of items. */
  readonly heading?: boolean
  /** Set on items of a group where one is current. The current one shows a check mark. */
  readonly checked?: boolean
  readonly disabled?: boolean
  /** An item that takes data away shows its text in the colour of danger (spec 000). */
  readonly danger?: boolean
  /**
   * Why the item is off, as a muted line under it. It shows only on an item that is `disabled`,
   * and the screen reader reads it with the item.
   */
  readonly reason?: string
}

/** The id of the line that tells why an item is off. Only an item with a test id has one. */
const reasonId = (item: MenuItem) =>
  item.disabled && item.reason && item.testId ? `${item.testId}-reason` : undefined

const MENU_WIDTH = 220
/** About the height of one item. It keeps a menu that opens low inside the window. */
const ITEM_HEIGHT = 32

/** The list of a menu. It closes on Escape, on a click outside, and when an item is chosen. */
export const PopupMenu = (props: {
  items: readonly MenuItem[]
  top: number
  left: number
  onClose: (refocus: boolean) => void
  label?: string
  testId?: string
  /** The width of the menu, in px. The short menus stay at the default. */
  width?: number
}) => {
  let list: HTMLDivElement | undefined
  const entries = () => [
    ...(list?.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)") ?? []),
  ]
  const width = () => props.width ?? MENU_WIDTH
  const top = () =>
    Math.max(8, Math.min(props.top, window.innerHeight - props.items.length * ITEM_HEIGHT - 16))
  const left = () => Math.max(8, Math.min(props.left, window.innerWidth - width() - 8))

  onMount(() => {
    // A menu with no item to choose takes the focus itself, so that Escape still closes it.
    ;(entries()[0] ?? list)?.focus()
    const onPointer = (event: PointerEvent) => {
      if (!list?.contains(event.target as Node)) props.onClose(false)
    }
    const onBlur = () => props.onClose(false)
    window.addEventListener("pointerdown", onPointer, true)
    window.addEventListener("blur", onBlur)
    onCleanup(() => {
      window.removeEventListener("pointerdown", onPointer, true)
      window.removeEventListener("blur", onBlur)
    })
  })

  const onKey = (event: KeyboardEvent) => {
    const all = entries()
    const index = all.indexOf(document.activeElement as HTMLElement)
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      props.onClose(true)
    } else if (event.key === "ArrowDown") {
      event.preventDefault()
      all[(index + 1) % all.length]?.focus()
    } else if (event.key === "ArrowUp") {
      event.preventDefault()
      all[(index - 1 + all.length) % all.length]?.focus()
    } else if (event.key === "Tab") {
      props.onClose(true)
    }
  }

  return (
    <Portal>
      <div
        ref={list}
        class={styles.menu}
        role="menu"
        aria-label={props.label}
        data-testid={props.testId}
        tabIndex={-1}
        style={{ top: `${top()}px`, left: `${left()}px`, width: `${width()}px` }}
        onKeyDown={onKey}
      >
        <For each={props.items}>
          {(item) => (
            <Show
              when={!item.heading}
              fallback={
                <div class={styles.menuHeading} role="presentation" data-testid={item.testId}>
                  {item.label}
                </div>
              }
            >
              {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: the role is menuitemradio exactly when `checked` is set */}
              <button
                type="button"
                class={item.icon ? `${styles.menuItem} ${styles.menuItemIcon}` : styles.menuItem}
                role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                aria-checked={item.checked}
                aria-describedby={reasonId(item)}
                disabled={item.disabled}
                title={item.title}
                data-testid={item.testId}
                data-danger={item.danger ? "true" : undefined}
                onClick={() => {
                  props.onClose(false)
                  item.onSelect()
                }}
              >
                <Show when={item.icon}>
                  {(icon) => <span class={styles.menuIcon}>{icon()}</span>}
                </Show>
                {item.label}
              </button>
              <Show when={item.disabled && item.reason}>
                <div
                  class={styles.menuReason}
                  role="presentation"
                  id={reasonId(item)}
                  data-testid={reasonId(item)}
                >
                  {item.reason}
                </div>
              </Show>
            </Show>
          )}
        </For>
      </div>
    </Portal>
  )
}

/** An icon button that opens a short list of actions. */
export const Menu = (props: {
  label: string
  icon: JSX.Element
  items: readonly MenuItem[]
  testId?: string
}) => {
  const [position, setPosition] = createSignal<{ top: number; left: number }>()
  let trigger: HTMLButtonElement | undefined

  const toggle = () => {
    if (position()) return setPosition(undefined)
    const box = trigger?.getBoundingClientRect()
    if (!box) return
    setPosition({
      top: box.bottom + 4,
      left: Math.max(8, Math.min(box.left, window.innerWidth - MENU_WIDTH - 8)),
    })
  }

  return (
    <>
      <IconButton
        ref={trigger}
        label={props.label}
        aria-haspopup="menu"
        aria-expanded={position() !== undefined}
        onClick={toggle}
        data-testid={props.testId}
      >
        {props.icon}
      </IconButton>
      <Show when={position()}>
        {(at) => (
          <PopupMenu
            items={props.items}
            top={at().top}
            left={at().left}
            onClose={(refocus) => {
              setPosition(undefined)
              if (refocus) trigger?.focus()
            }}
          />
        )}
      </Show>
    </>
  )
}
