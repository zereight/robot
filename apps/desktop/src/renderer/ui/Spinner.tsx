import { Show } from "solid-js"
import styles from "./spinner.module.css"

/**
 * The turning mark of a node, a step or a task that runs (specs/039, "Spinner"). Every spinner turns
 * with the same period (`--motion-spin`). With reduce motion on, the ring stands still and stays
 * visible, so the user can still see that work runs. The caller removes the mark when the work ends.
 * The ring is hidden from a screen reader. A caller whose place has no word for the state passes
 * `label` (the word "Running"): it is read as hidden text, also with reduce motion on.
 */
export const Spinner = (props: { testId?: string; label?: string }) => (
  <span class={styles.spinner} data-testid={props.testId ?? "spinner"}>
    <Show when={props.label}>
      <span class={styles.label}>{props.label}</span>
    </Show>
  </span>
)
