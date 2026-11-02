import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import styles from "./controls.module.css"
import { IconButton } from "./controls.tsx"

export interface MenuItem {
  readonly label: string
  readonly onSelect: () => void
  readonly testId?: string
}

const MENU_WIDTH = 220

/** The list of a menu. It closes on Escape, on a click outside, and when an item is chosen. */
const MenuList = (props: {
  items: readonly MenuItem[]
  top: number
  left: number
  onClose: (refocus: boolean) => void
}) => {
  let list: HTMLDivElement | undefined
  const entries = () => [...(list?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])]

  onMount(() => {
    entries()[0]?.focus()
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
        style={{ top: `${props.top}px`, left: `${props.left}px`, width: `${MENU_WIDTH}px` }}
        onKeyDown={onKey}
      >
        <For each={props.items}>
          {(item) => (
            <button
              type="button"
              class={styles.menuItem}
              role="menuitem"
              data-testid={item.testId}
              onClick={() => {
                props.onClose(false)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
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
          <MenuList
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
