import type { MessageKey, SetupFileView, SetupList } from "@robot/shared"
import { SETUP_ACTIONS_MAX, setupRowProblem } from "@robot/shared"
import { createEffect, createResource, createSignal, For, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./agents.module.css"

interface Row {
  name: string
  command: string
  onOwnCopy: boolean
  onTurnStart: boolean
}

const problemKey = (row: Row): MessageKey | undefined => {
  const problem = setupRowProblem(row)
  if (problem === "name") return "setup.invalid.name"
  if (problem === "command") return "setup.invalid.command"
  if (problem === "marks") return "setup.saveFailed"
  return undefined
}

/**
 * The form that makes and changes the setup list of one workspace (spec 035). It names the file
 * it writes. "Cancel" throws the draft away. A save clears the allow, so the toast says to allow
 * the list again when a marked action is left.
 */
export const SetupEditorForm = (props: {
  agentId: string
  onSaved: (list: SetupList) => void
  onCancel: () => void
}) => {
  const { t } = useApp()
  const [view, { refetch }] = createResource(() => call("setup.file", { agentId: props.agentId }))
  const [rows, setRows] = createSignal<Row[]>()
  const [loadedFor, setLoadedFor] = createSignal("")
  const [asking, setAsking] = createSignal(false)
  const [replacing, setReplacing] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()

  const draftOf = (file: SetupFileView): Row[] =>
    file.unreadable ? [] : file.actions.map((action) => ({ ...action }))

  createEffect(() => {
    const file = view()
    if (!file || loadedFor() === props.agentId) return
    setLoadedFor(props.agentId)
    setAsking(false)
    setReplacing(false)
    setRows(draftOf(file))
  })

  const blocked = () =>
    saving() || rows() === undefined || (rows() ?? []).some((row) => problemKey(row) !== undefined)

  const update = (index: number, patch: Partial<Row>) =>
    setRows((now) => (now ?? []).map((row, at) => (at === index ? { ...row, ...patch } : row)))

  const cancel = () => {
    const file = view()
    if (file) {
      setAsking(false)
      setReplacing(false)
      setRows(draftOf(file))
    }
    setError(undefined)
    props.onCancel()
  }

  const save = () => {
    const current = rows()
    if (!current || blocked()) return
    setSaving(true)
    setError(undefined)
    call("setup.save", { agentId: props.agentId, actions: current, replace: replacing() })
      .then((result) => {
        if (result.status !== "saved") {
          setError({
            key: result.status === "unreadable" ? "setup.unreadable" : "setup.saveFailed",
          })
          setLoadedFor("")
          void refetch()
          return
        }
        const marked = result.list.actions.some((action) => action.onOwnCopy || action.onTurnStart)
        showToast(
          "success",
          marked && !result.list.allowed ? "setup.saved.allowAgain" : "setup.saved",
        )
        setLoadedFor("")
        void refetch()
        props.onSaved(result.list)
      })
      .catch((cause: unknown) => setError(describeError(cause)))
      .finally(() => setSaving(false))
  }

  return (
    <div class={styles.setupForm} data-testid="setup-editor">
      <Show when={view()}>
        {(file) => (
          <>
            <div class={styles.setupPath} data-testid="setup-path">
              {file().exists || replacing()
                ? t("setup.file.path", { path: file().path })
                : t("setup.file.new", { path: file().path })}
            </div>
            <Show
              when={!file().unreadable || replacing()}
              fallback={
                <div>
                  <div class={styles.setupPath} data-testid="setup-editor-unreadable">
                    {t("setup.unreadable")}
                  </div>
                  <Show
                    when={!asking()}
                    fallback={
                      <div>
                        <p class={styles.setupPath}>
                          {t("setup.replace.ask", { path: file().path })}
                        </p>
                        <div class={styles.setupFooter}>
                          <Button onClick={() => setAsking(false)}>{t("common.keep")}</Button>
                          <Button
                            variant="danger"
                            onClick={() => {
                              setAsking(false)
                              setReplacing(true)
                              setRows([])
                            }}
                            data-testid="setup-replace-confirm"
                          >
                            {t("setup.replace")}
                          </Button>
                        </div>
                      </div>
                    }
                  >
                    <div class={styles.setupFooter}>
                      <Button onClick={() => setAsking(true)} data-testid="setup-replace">
                        {t("setup.replace")}
                      </Button>
                      <Button onClick={cancel}>{t("setup.cancel")}</Button>
                    </div>
                  </Show>
                </div>
              }
            >
              <Show
                when={(rows() ?? []).length > 0}
                fallback={
                  <div class={styles.setupPath} data-testid="setup-empty">
                    {t("setup.empty")}
                  </div>
                }
              >
                <ul class={styles.setupRows}>
                  <For each={rows() ?? []}>
                    {(row, index) => (
                      <li class={styles.setupRow} data-testid="setup-row">
                        <div class={styles.setupField}>
                          <label class={styles.setupLabel} for={`setup-name-${index()}`}>
                            {t("setup.name")}
                          </label>
                          <input
                            id={`setup-name-${index()}`}
                            class={styles.setupInput}
                            value={row.name}
                            maxLength={80}
                            autocomplete="off"
                            spellcheck={false}
                            aria-label={t("setup.name")}
                            aria-invalid={problemKey(row) === "setup.invalid.name"}
                            onInput={(e) => update(index(), { name: e.currentTarget.value })}
                            data-testid="setup-name"
                          />
                        </div>
                        <div class={styles.setupField}>
                          <label class={styles.setupLabel} for={`setup-command-${index()}`}>
                            {t("setup.command")}
                          </label>
                          <input
                            id={`setup-command-${index()}`}
                            class={`${styles.setupInput} ${styles.setupCommand}`}
                            value={row.command}
                            maxLength={4000}
                            autocomplete="off"
                            spellcheck={false}
                            aria-label={t("setup.command")}
                            aria-invalid={problemKey(row) === "setup.invalid.command"}
                            onInput={(e) => update(index(), { command: e.currentTarget.value })}
                            data-testid="setup-command"
                          />
                        </div>
                        <div class={styles.setupMarks}>
                          <span class={styles.setupMark}>
                            <Switch
                              label={t("setup.mark.ownCopy")}
                              testId="setup-mark-own-copy"
                              checked={row.onOwnCopy}
                              onChange={(onOwnCopy) => update(index(), { onOwnCopy })}
                            />
                            <span>{t("setup.mark.ownCopy")}</span>
                          </span>
                          <span class={styles.setupMark}>
                            <Switch
                              label={t("setup.mark.turn")}
                              testId="setup-mark-turn"
                              checked={row.onTurnStart}
                              onChange={(onTurnStart) => update(index(), { onTurnStart })}
                            />
                            <span>{t("setup.mark.turn")}</span>
                          </span>
                          <Button
                            onClick={() =>
                              setRows((now) => (now ?? []).filter((_, at) => at !== index()))
                            }
                            data-testid="setup-delete"
                          >
                            {t("setup.delete")}
                          </Button>
                        </div>
                        <Show when={problemKey(row)}>
                          {(key) => (
                            <div class={styles.setupError} role="alert" data-testid="setup-invalid">
                              {t(key())}
                            </div>
                          )}
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
              <div class={styles.setupFooter}>
                <Button
                  onClick={() =>
                    setRows((now) => [
                      ...(now ?? []),
                      { name: "", command: "", onOwnCopy: false, onTurnStart: false },
                    ])
                  }
                  disabled={(rows() ?? []).length >= SETUP_ACTIONS_MAX}
                  title={
                    (rows() ?? []).length >= SETUP_ACTIONS_MAX ? t("setup.invalid.many") : undefined
                  }
                  data-testid="setup-add"
                >
                  {t("setup.add")}
                </Button>
                <Button
                  variant="primary"
                  onClick={save}
                  disabled={blocked()}
                  data-testid="setup-editor-save"
                >
                  {t("setup.save")}
                </Button>
                <Button onClick={cancel}>{t("setup.cancel")}</Button>
              </div>
            </Show>
            <Show when={error()}>
              {(err) => (
                <div class={styles.setupError} role="alert" data-testid="setup-editor-error">
                  {t(err().key, err().params)}
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
    </div>
  )
}

/** The editor in a box, for the chat menu (spec 035). */
export const SetupEditorDialog = (props: {
  agentId: string
  onClose: () => void
  onSaved: (list: SetupList) => void
}) => {
  const { t } = useApp()
  return (
    <Dialog label={t("setup.manage")} onClose={props.onClose} testId="setup-editor-dialog">
      <h2 class={styles.title}>{t("setup.manage")}</h2>
      <SetupEditorForm agentId={props.agentId} onSaved={props.onSaved} onCancel={props.onClose} />
    </Dialog>
  )
}
