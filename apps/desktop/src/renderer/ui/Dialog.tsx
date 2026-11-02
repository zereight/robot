import { createEffect, onCleanup, onMount, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import styles from "../shell/shell.module.css"
import { useClosing } from "./Presence.tsx"

/** A modal box. Escape and a click outside close it, unless it is not dismissible. */
export const Dialog = (
  props: ParentProps<{
    label: string
    onClose: () => void
    testId?: string
    /** False keeps the box open on Escape and on a click outside. */
    dismissible?: boolean
    /** A wide box, for a page with two panes. */
    wide?: boolean
  }>,
) => {
  let box: HTMLDivElement | undefined
  let previous: HTMLElement | null = null
  const closing = useClosing()
  /**
   * Gives the focus back to what had it before the box opened. It leaves the focus alone when the
   * user moved it out of the box already, for example into the message box of a new chat.
   */
  const restoreFocus = () => {
    const active = document.activeElement
    if (active && active !== document.body && !box?.contains(active)) return
    previous?.focus()
  }
  // Do it when the exit motion starts, not when it ends: at the end, the user may have gone on.
  createEffect(() => {
    if (closing()) restoreFocus()
  })
  onMount(() => {
    previous = document.activeElement as HTMLElement | null
    // A field that asks for focus gets it. Else the first control does.
    const first =
      box?.querySelector<HTMLElement>("[autofocus]") ??
      box?.querySelector<HTMLElement>("button, input, textarea, select")
    first?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closing() && props.dismissible !== false) {
        event.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true)
      restoreFocus()
    })
  })
  return (
    <Portal>
      <div
        class={styles.dialogBackdrop}
        data-closing={closing()}
        onPointerDown={(e) =>
          e.target === e.currentTarget && props.dismissible !== false && props.onClose()
        }
      >
        <div
          ref={box}
          class={styles.dialog}
          role="dialog"
          aria-modal="true"
          aria-label={props.label}
          data-wide={props.wide ? "true" : undefined}
          data-testid={props.testId}
        >
          {props.children}
        </div>
      </div>
    </Portal>
  )
}
