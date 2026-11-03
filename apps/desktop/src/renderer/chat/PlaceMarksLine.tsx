import { markKinds, type PlaceMarks, type PlaceRef } from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { sensitiveLabelText } from "../lib/sensitive.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./marks.module.css"

/**
 * The muted line in the header of a place that holds marks (spec 007, "The mark of a place"). It
 * says "Holds a sensitive read" with the label of the first place that was read. "Clear" removes
 * the marks for the next turns, after a confirm that names each mark. A linked device sees the
 * line and cannot clear it (spec 012). A place with no mark shows nothing.
 */
export const PlaceMarksLine = (props: { place: PlaceRef; marks: PlaceMarks }) => {
  const { t } = useApp()
  const ui = useUi()
  const [confirming, setConfirming] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  const kinds = () => markKinds(props.marks)
  const close = () => {
    setConfirming(false)
    setError(undefined)
  }
  const clear = async () => {
    try {
      await call("placeMarks.clear", { place: props.place })
      close()
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <>
      <Show when={kinds().length > 0}>
        <div class={styles.line} role="note" data-testid="place-marks">
          <For each={kinds()}>
            {(kind) => (
              <span data-testid={`place-mark-${kind}`}>
                <strong>{t("sensitive.held")}</strong>
                <Show when={props.marks.sensitive}>
                  {(label) => (
                    <span data-testid="place-mark-first">
                      {" · "}
                      {t("sensitive.first", { label: sensitiveLabelText(t, label()) })}
                    </span>
                  )}
                </Show>
              </span>
            )}
          </For>
          <Show when={!ui.linked()}>
            <button
              type="button"
              class={styles.clear}
              onClick={() => setConfirming(true)}
              data-testid="place-marks-clear"
            >
              {t("marks.clear")}
            </button>
          </Show>
        </div>
      </Show>
      <Presence when={confirming()}>
        {() => (
          <Dialog
            label={t("marks.clearTitle", { marks: t("sensitive.held") })}
            onClose={close}
            testId="place-marks-dialog"
          >
            <h2 class={styles.title}>{t("marks.clearTitle", { marks: t("sensitive.held") })}</h2>
            <p>{t("marks.clearSensitive")}</p>
            <Show when={error()}>
              {(err) => <p class={styles.error}>{t(err().key, err().params)}</p>}
            </Show>
            <div class={styles.actions}>
              <Button onClick={close}>{t("marks.cancel")}</Button>
              <Button
                variant="primary"
                onClick={() => void clear()}
                data-testid="place-marks-confirm"
              >
                {t("marks.clear")}
              </Button>
            </div>
          </Dialog>
        )}
      </Presence>
    </>
  )
}
