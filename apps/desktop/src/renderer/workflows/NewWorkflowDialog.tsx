import { createSignal, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import shell from "../shell/shell.module.css"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./workflows.module.css"

/**
 * The dialog "New workflow" (spec 010, flow 1): the name only. The app makes the responsible
 * document with a short default text, and the new workflow opens at once.
 */
export const NewWorkflowDialog = (props: { serverId: string; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const [name, setName] = createSignal("")
  const [problem, setProblem] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  const create = async () => {
    if (busy() || name().trim() === "") return
    setBusy(true)
    try {
      const made = await call("workflows.create", { serverId: props.serverId, name: name() })
      props.onClose()
      ui.selectPlace({ kind: "workflow", id: made.id })
    } catch (e) {
      setProblem(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog label={t("workflows.new")} onClose={props.onClose} testId="new-workflow-dialog">
      <h2>{t("workflows.new")}</h2>
      <p class={styles.hint}>{t("workflows.new.hint")}</p>
      <input
        class={styles.input}
        value={name()}
        placeholder={t("workflows.name")}
        aria-label={t("workflows.name")}
        aria-invalid={problem() ? "true" : undefined}
        data-testid="new-workflow-name"
        onInput={(e) => {
          setName(e.currentTarget.value)
          setProblem(undefined)
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void create()
        }}
      />
      <Show when={problem()}>
        {(p) => (
          <p class={styles.error} role="alert" data-testid="new-workflow-error">
            {t(p().key, p().params)}
          </p>
        )}
      </Show>
      <div class={shell.dialogActions}>
        <Button onClick={props.onClose}>{t("workflows.cancel")}</Button>
        <Button
          variant="primary"
          disabled={busy() || name().trim() === ""}
          onClick={() => void create()}
          data-testid="new-workflow-create"
        >
          {t("workflows.create")}
        </Button>
      </div>
    </Dialog>
  )
}
