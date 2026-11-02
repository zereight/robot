import type { CutNotice, MessageKey } from "@robot/shared"
import { createSignal, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useRetry } from "../retry/RetryNote.tsx"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./chat.module.css"

/**
 * The notice above the message box after a restart cut off the last request (spec 003, "Rules").
 * A request that never reached the model has "Send again", which does what Retry does for the
 * task. A request that reached the model shows how far it went, and has "Continue", which sends
 * a short new message and does not send the old request again.
 */
export const RestartNotice = (props: { agentId: string; cut: CutNotice }) => {
  const { t } = useApp()
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  const act = async (run: () => Promise<unknown>) => {
    setError(undefined)
    setBusy(true)
    try {
      await run()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  // A request that never reached the model ran no step, so no retry note shows (spec 005). The
  // same path as Retry holds the note anyway if the server answers with one.
  const retry = useRetry()
  const sendAgain = () =>
    act(() =>
      retry.start((confirmed) =>
        call("chat.retry", {
          agentId: props.agentId,
          messageId: props.cut.messageId,
          ...(confirmed ? { confirmed } : {}),
        }),
      ),
    )
  const goOn = () =>
    act(() =>
      call("chat.send", {
        agentId: props.agentId,
        text: t("chat.restart.continueMessage"),
        replyTo: null,
      }),
    )
  return (
    <div
      class={styles.restart}
      role="status"
      data-testid="restart-notice"
      data-progress={props.cut.progress}
    >
      {retry.dialog()}
      <div class={styles.restartText}>
        <span>{t("chat.restart.notice")}</span>{" "}
        <span data-testid="progress-line">
          {t(`progress.line.${props.cut.progress}` as MessageKey)}
        </span>
        <Show when={error()}>
          {(err) => (
            <span class={styles.restartError} role="alert">
              {" "}
              {t(err().key, err().params)}
            </span>
          )}
        </Show>
      </div>
      <Show
        when={props.cut.progress === "not_sent"}
        fallback={
          <Button disabled={busy()} onClick={goOn} data-testid="restart-continue">
            {t("chat.restart.continue")}
          </Button>
        }
      >
        <Button disabled={busy()} onClick={sendAgain} data-testid="restart-send-again">
          {t("chat.restart.sendAgain")}
        </Button>
      </Show>
    </div>
  )
}
