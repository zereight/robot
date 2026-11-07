import styles from "./spinner.module.css"

/**
 * The turning mark of a node, a step or a task that runs (specs/039, "Spinner"). Every spinner turns
 * with the same period (`--motion-spin`). With reduce motion on, the ring stands still and stays
 * visible, so the user can still see that work runs. The caller removes the mark when the work ends.
 */
export const Spinner = (props: { testId?: string }) => (
  <span class={styles.spinner} data-testid={props.testId ?? "spinner"} aria-hidden="true" />
)
