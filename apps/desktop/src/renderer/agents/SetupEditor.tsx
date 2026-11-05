import type { SetupFileView, SetupList } from "@robot/shared"
import { SETUP_ACTIONS_MAX, setupCanon } from "@robot/shared"
import { Play, Settings } from "lucide-solid"
import { createEffect, createResource, createSignal, Index, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./agents.module.css"
import { SetupActionDialog, type SetupRow } from "./SetupActionDialog.tsx"
import { runSetupAction } from "./setupRun.ts"

/**
 * The form that makes and changes the setup list of one workspace (spec 035). It names the file
 * it writes and lists the actions. "Cancel" throws the draft away. A save clears the allow, so
 * the toast says to allow the list again when a marked action is left.
 */
export const SetupEditorForm = (props: {
  agentId: string
  onSaved: (list: SetupList) => void
  onCancel: () => void
}) => {
  const { t } = useApp()
  const [view, { refetch }] = createResource(() => call("setup.file", { agentId: props.agentId }))
  const [rows, setRows] = createSignal<SetupRow[]>()
  const [loadedFor, setLoadedFor] = createSignal("")
  const [asking, setAsking] = createSignal(false)
  const [replacing, setReplacing] = createSignal(false)
  const [saving, setSaving] = createSignal(false)
  const [running, setRunning] = createSignal(false)
  const [rowDialog, setRowDialog] = createSignal<{ at: number | "new" }>()
  const [error, setError] = createSignal<ErrorText>()

  const draftOf = (file: SetupFileView): SetupRow[] =>
    file.unreadable ? [] : file.actions.map((action) => ({ ...action }))

  createEffect(() => {
    const file = view()
    if (!file || loadedFor() === props.agentId) return
    setLoadedFor(props.agentId)
    setAsking(false)
    setReplacing(false)
    setRowDialog(undefined)
    setRows(draftOf(file))
  })

  const blocked = () => saving() || rows() === undefined

  /** A run reads the file, so rows run only while the draft matches it. */
  const dirty = () => {
    const file = view()
    const current = rows()
    if (!file || !current) return false
    return setupCanon(current) !== setupCanon(file.actions)
  }

  const run = (name: string) => {
    if (running()) return
    setRunning(true)
    void runSetupAction(props.agentId, name).finally(() => setRunning(false))
  }

  const cancel = () => {
    const file = view()
    if (file) {
      setAsking(false)
      setReplacing(false)
      setRowDialog(undefined)
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
                  <Index each={rows() ?? []}>
                    {(row, index) => (
                      <li class={styles.setupRow} data-testid="setup-row">
                        <IconButton
                          label={t("setup.run", { name: row().name })}
                          title={
                            dirty() ? t("setup.unsaved") : t("setup.run", { name: row().name })
                          }
                          onClick={() => run(row().name)}
                          disabled={running() || dirty()}
                          data-testid="setup-row-run"
                        >
                          <Play size={16} />
                        </IconButton>
                        <div class={styles.setupRowText}>
                          <span class={styles.setupRowName}>{row().name}</span>
                          <span class={styles.setupRowCommand} title={row().command}>
                            {row().command}
                          </span>
                        </div>
                        <IconButton
                          label={t("setup.edit")}
                          onClick={() => setRowDialog({ at: index })}
                          data-testid="setup-row-edit"
                        >
                          <Settings size={16} />
                        </IconButton>
                      </li>
                    )}
                  </Index>
                </ul>
              </Show>
              <div class={styles.setupFooter}>
                <Button
                  onClick={() => setRowDialog({ at: "new" })}
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
              <Presence when={rowDialog()}>
                {(target) => {
                  const at = target.at
                  const initial: SetupRow =
                    at === "new"
                      ? { name: "", command: "", onOwnCopy: false, onTurnStart: false }
                      : ((rows() ?? [])[at] ?? {
                          name: "",
                          command: "",
                          onOwnCopy: false,
                          onTurnStart: false,
                        })
                  return (
                    <SetupActionDialog
                      initial={initial}
                      isNew={at === "new"}
                      onSave={(row) => {
                        if (at === "new") setRows((now) => [...(now ?? []), row])
                        else setRows((now) => (now ?? []).map((old, i) => (i === at ? row : old)))
                        setRowDialog(undefined)
                      }}
                      onDelete={
                        at === "new"
                          ? undefined
                          : () => {
                              setRows((now) => (now ?? []).filter((_, i) => i !== at))
                              setRowDialog(undefined)
                            }
                      }
                      onClose={() => setRowDialog(undefined)}
                    />
                  )
                }}
              </Presence>
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
