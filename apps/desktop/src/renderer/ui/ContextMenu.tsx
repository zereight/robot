import { For, onCleanup, onMount } from "solid-js"
import { Portal } from "solid-js/web"
import styles from "./controls.module.css"

export interface MenuItem {
  readonly label: string
  readonly run: () => void
  readonly testId?: string
  /** An item that takes data away shows its text in the colour of danger (spec 000). */
  readonly danger?: boolean
}

/** A small menu at the place of a right click. Escape, a click outside or a choice closes it. */
export const ContextMenu = (props: {
  x: number
  y: number
  label: string
  items: readonly MenuItem[]
  onClose: () => void
}) => {
  let box: HTMLDivElement | undefined
  onMount(() => {
    box?.querySelector<HTMLElement>("button")?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation()
        props.onClose()
      }
    }
    const onDown = (e: PointerEvent) => {
      if (!box?.contains(e.target as Node)) props.onClose()
    }
    window.addEventListener("keydown", onKey, true)
    window.addEventListener("pointerdown", onDown, true)
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true)
      window.removeEventListener("pointerdown", onDown, true)
    })
  })
  return (
    <Portal>
      <div
        ref={box}
        class={styles.menu}
        role="menu"
        aria-label={props.label}
        style={{
          left: `${Math.min(props.x, window.innerWidth - 180)}px`,
          top: `${Math.min(props.y, window.innerHeight - 20 - props.items.length * 34)}px`,
        }}
        data-testid="context-menu"
      >
        <For each={props.items}>
          {(item) => (
            <button
              type="button"
              role="menuitem"
              class={styles.menuItem}
              data-testid={item.testId}
              data-danger={item.danger ? "true" : undefined}
              onClick={() => {
                props.onClose()
                item.run()
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
