import { onCleanup, onMount, type ParentProps } from "solid-js"
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
  }>,
) => {
  let box: HTMLDivElement | undefined
  const closing = useClosing()
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null
    box?.querySelector<HTMLElement>("button, input, textarea, select")?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !closing() && props.dismissible !== false) {
        event.stopPropagation()
        props.onClose()
      }
    }
    window.addEventListener("keydown", onKey, true)
    onCleanup(() => {
      window.removeEventListener("keydown", onKey, true)
      previous?.focus()
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
          data-testid={props.testId}
        >
          {props.children}
        </div>
      </div>
    </Portal>
  )
}
