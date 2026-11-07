import type { NodeHold } from "@robot/shared"
import { createSignal, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { formatDateTime } from "../lib/format.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./graph.module.css"

/**
 * "Backup until <time>" and the button "Use <main model> now" of a node whose main model is held
 * (spec 006, "Backup model"). The editor and the run view show it. The button ends the hold: the
 * next task tries the main model. A linked device and the phone never get a hold, so they never show
 * this line (spec 012, 011).
 */
export const BackupHold = (props: { hold: NodeHold; testId: string }) => {
  const { t, locale } = useApp()
  const [problem, setProblem] = createSignal<ErrorText>()
  const release = async () => {
    setProblem(undefined)
    try {
      await call("workflows.hold.release", { nodeId: props.hold.nodeId })
    } catch (e) {
      setProblem(describeError(e))
    }
  }
  return (
    <div class={styles.field} data-testid={props.testId}>
      <span class={styles.hintText} data-testid={`${props.testId}-until`}>
        {t("node.backup.until", { time: formatDateTime(locale(), props.hold.until) })}
      </span>
      <div>
        <Button onClick={() => void release()} data-testid={`${props.testId}-use-main`}>
          {t("node.backup.useMain", { model: props.hold.main })}
        </Button>
      </div>
      <Show when={problem()}>
        {(p) => (
          <p class={styles.errorText} role="alert">
            {t(p().key, p().params)}
          </p>
        )}
      </Show>
    </div>
  )
}
