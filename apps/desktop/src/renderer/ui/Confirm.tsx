import { type JSX, onMount } from "solid-js"
import styles from "./controls.module.css"
import { Button } from "./controls.tsx"

/**
 * The question that a danger step asks in place, in the row or the panel that the step belongs to
 * (spec 000, "Danger buttons"). The words say what goes away. "Keep it" leaves everything as it
 * is, so a step that the user cannot undo has a way back. It scrolls into view when it opens, so
 * both buttons show together.
 */
export const Confirm = (props: {
  /** What the question says, from the catalogue: a line or a short text. */
  ask: JSX.Element
  /** The label of the button that goes on, and it is a danger button. */
  confirm: string
  /** The label of the button that keeps the data. */
  keep: string
  onConfirm: () => void
  onKeep: () => void
  /** The id of the line that asks. The row carries the same words as an alert. */
  testId?: string
  confirmTestId?: string
  keepTestId?: string
  disabled?: boolean
}) => {
  let box: HTMLDivElement | undefined
  onMount(() => box?.scrollIntoView({ block: "nearest" }))
  return (
    <div class={styles.confirm} ref={box} data-testid={props.testId} data-confirm>
      <span class={styles.confirmAsk} role="alert">
        {props.ask}
      </span>
      <div class={styles.confirmBtns}>
        <Button onClick={props.onKeep} data-testid={props.keepTestId}>
          {props.keep}
        </Button>
        <Button
          variant="danger"
          onClick={props.onConfirm}
          disabled={props.disabled}
          data-testid={props.confirmTestId}
        >
          {props.confirm}
        </Button>
      </div>
    </div>
  )
}
