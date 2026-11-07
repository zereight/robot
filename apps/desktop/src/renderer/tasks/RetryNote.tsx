import type { MessageKey, RetryNote, RetryResult } from "@robot/shared"
import { createSignal, For, type JSX, Show } from "solid-js"
import { describeError } from "../lib/errors.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./retry.module.css"

/** The note that shows before a task is tried again (spec 005, "Retry note"). */
const RetryNoteDialog = (props: { note: RetryNote; onRetry: () => void; onBack: () => void }) => {
  const { t } = useApp()
  return (
    <Dialog label={t("retryNote.title")} onClose={props.onBack} testId="retry-note">
      <div class={styles.note}>
        <h2 class={styles.title}>{t("retryNote.title")}</h2>
        <p class={styles.text}>{t("retryNote.body")}</p>
        <Show when={props.note.steps.length > 0}>
          <ul class={styles.steps} data-testid="retry-note-steps">
            <For each={props.note.steps}>
              {(step) => (
                <li class={styles.step} data-testid="retry-note-step">
                  <span class={styles.kind}>{t(`retryNote.kind.${step.kind}` as MessageKey)}</span>
                  <span class={styles.target}>{step.target}</span>
                  <span class={styles.result}>
                    {t(`retryNote.result.${step.result}` as MessageKey)}
                  </span>
                </li>
              )}
            </For>
          </ul>
          <Show when={props.note.more > 0}>
            <p class={styles.muted} data-testid="retry-note-more">
              {t("retryNote.more", { count: props.note.more })}
            </p>
          </Show>
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onBack} data-testid="retry-back">
            {t("retryNote.back")}
          </Button>
          <Button variant="primary" onClick={props.onRetry} data-testid="retry-anyway">
            {t("retryNote.anyway")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

type Run = (confirmed: boolean) => Promise<RetryResult>

/**
 * Starts a retry. When the first try ran steps that may have changed things, the main process
 * answers with the note instead. The note holds the dialog until the user picks "Retry anyway",
 * which asks again with `confirmed`, or "Back", which changes nothing. A "Retry anyway" that fails
 * shows the error. `onDone` runs after it, whatever the result, so the page can read its data again.
 */
export const useRetry = (options: { onDone?: () => void } = {}) => {
  const [pending, setPending] = createSignal<{ note: RetryNote; run: Run }>()
  const start = async (run: Run) => {
    const result = await run(false)
    if (!result.started) setPending({ note: result.note, run })
  }
  const dialog = (): JSX.Element => (
    <Presence when={pending()}>
      {(p) => (
        <RetryNoteDialog
          note={p.note}
          onBack={() => setPending(undefined)}
          onRetry={() => {
            setPending(undefined)
            void p
              .run(true)
              .catch((error: unknown) => {
                const text = describeError(error)
                showToast("error", text.key, text.params)
              })
              .finally(() => options.onDone?.())
          }}
        />
      )}
    </Presence>
  )
  return { start, dialog }
}
