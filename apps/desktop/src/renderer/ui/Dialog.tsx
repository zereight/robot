import { onCleanup, onMount, type ParentProps } from "solid-js"
import { Portal } from "solid-js/web"
import styles from "../shell/shell.module.css"

/** A modal box. Escape and a click outside close it. */
export const Dialog = (
  props: ParentProps<{ label: string; onClose: () => void; testId?: string }>,
) => {
  let box: HTMLDivElement | undefined
  onMount(() => {
    const previous = document.activeElement as HTMLElement | null
    box?.querySelector<HTMLElement>("button, input, textarea, select")?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
        onPointerDown={(e) => e.target === e.currentTarget && props.onClose()}
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
