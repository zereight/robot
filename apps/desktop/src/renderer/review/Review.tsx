import { REVIEW_CHANGES_MAX, validChanges } from "@robot/shared"
import { createSignal, type JSX, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./review.module.css"

/** The text field of "Request changes": 1 to 2000 characters (spec 005). */
const ChangesDialog = (props: { taskId: string; onClose: () => void }) => {
  const { t } = useApp()
  const [text, setText] = createSignal("")
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  const send = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!validChanges(text()) || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await call("tasks.requestChanges", { id: props.taskId, text: text().trim() })
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog label={t("review.changes.title")} onClose={props.onClose} testId="changes-dialog">
      <form class={styles.box} onSubmit={send}>
        <h2 class={styles.title}>{t("review.changes.title")}</h2>
        <label>
          <span class={styles.text}>{t("review.changes.label")}</span>
          <textarea
            class={styles.input}
            value={text()}
            maxLength={REVIEW_CHANGES_MAX}
            onInput={(e) => setText(e.currentTarget.value)}
            data-testid="changes-text"
          />
        </label>
        <p class={styles.muted}>{t("review.changes.hint")}</p>
        <Show when={error()}>
          {(err) => (
            <p class={styles.error} role="alert" data-testid="changes-error">
              {t(err().key, err().params)}
            </p>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose} data-testid="changes-back">
            {t("review.changes.back")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!validChanges(text()) || busy()}
            data-testid="changes-send"
          >
            {t("review.changes.send")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/**
 * The two decisions on a part in review (spec 004, 005): "Accept", and "Request changes", which
 * asks for the text first. The dialog belongs to the caller, who puts `dialog()` in its tree.
 */
export const useReview = (onError: (error: ErrorText) => void) => {
  const [changing, setChanging] = createSignal<string>()
  const accept = async (taskId: string) => {
    try {
      await call("tasks.accept", { id: taskId })
    } catch (e) {
      onError(describeError(e))
    }
  }
  const dialog = (): JSX.Element => (
    <Presence when={changing()}>
      {(id) => <ChangesDialog taskId={id} onClose={() => setChanging(undefined)} />}
    </Presence>
  )
  return { accept, requestChanges: (taskId: string) => setChanging(taskId), dialog }
}

/** The confirm of "End the request". Its second button says "Back" (spec 004, flow 8). */
const EndDialog = (props: { onEnd: () => void; onBack: () => void }) => {
  const { t } = useApp()
  return (
    <Dialog label={t("endRequest.title")} onClose={props.onBack} testId="end-request-dialog">
      <div class={styles.box}>
        <h2 class={styles.title}>{t("endRequest.title")}</h2>
        <p class={styles.text}>{t("endRequest.body")}</p>
        <div class={styles.actions}>
          <Button onClick={props.onBack} data-testid="end-request-back">
            {t("endRequest.back")}
          </Button>
          <Button variant="primary" onClick={props.onEnd} data-testid="end-request-confirm">
            {t("endRequest.confirm")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/** "End the request" with its confirm. The caller puts `dialog()` in its tree. */
export const useEndRequest = (onError: (error: ErrorText) => void) => {
  const [pending, setPending] = createSignal<string>()
  const dialog = (): JSX.Element => (
    <Presence when={pending()}>
      {(id) => (
        <EndDialog
          onBack={() => setPending(undefined)}
          onEnd={() => {
            setPending(undefined)
            void call("tasks.endRequest", { id }).catch((e) => onError(describeError(e)))
          }}
        />
      )}
    </Presence>
  )
  return { start: (taskId: string) => setPending(taskId), dialog }
}
