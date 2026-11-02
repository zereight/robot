import {
  AGENT_FILE_MAX_AGENTS,
  type AgentFileFailure,
  type AgentFilePreview,
  type AgentModel,
} from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./agents.module.css"
import { Face } from "./Face.tsx"

/** Choose agents, then save them in one file. */
export const ExportAgentsDialog = (props: { onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(
    new Set(agents.agents().map((a) => a.id)),
  )
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  const [saved, setSaved] = createSignal<{ path: string; count: number }>()

  const allPicked = () => agents.agents().length > 0 && picked().size === agents.agents().length
  const tooMany = () => picked().size > AGENT_FILE_MAX_AGENTS
  const toggle = (id: string) => {
    const next = new Set(picked())
    if (!next.delete(id)) next.add(id)
    setPicked(next)
  }

  const submit = async () => {
    const serverId = ui.server()?.id
    if (!serverId || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const result = await call("agentFile.export", { serverId, agentIds: [...picked()] })
      if (result.path) setSaved({ path: result.path, count: result.count })
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      label={t("agentFile.export.title")}
      onClose={props.onClose}
      testId="agent-export-dialog"
    >
      <div class={styles.form}>
        <h2 class={styles.title}>{t("agentFile.export.title")}</h2>
        <p class={styles.hint}>{t("agentFile.export.hint")}</p>
        <Show
          when={agents.agents().length > 0}
          fallback={<p class={styles.hint}>{t("agentFile.export.empty")}</p>}
        >
          <label class={styles.fileRow}>
            <input
              type="checkbox"
              checked={allPicked()}
              onChange={() =>
                setPicked(allPicked() ? new Set() : new Set(agents.agents().map((a) => a.id)))
              }
              data-testid="agent-export-all"
            />
            <span class={styles.label}>{t("agentFile.export.all")}</span>
          </label>
          <ul class={styles.fileList}>
            <For each={agents.agents()}>
              {(agent) => (
                <li>
                  <label class={styles.fileRow}>
                    <input
                      type="checkbox"
                      checked={picked().has(agent.id)}
                      onChange={() => toggle(agent.id)}
                      data-testid="agent-export-item"
                    />
                    <Face face={agent.face} image={agent.faceImage} size={28} />
                    <span class={styles.fileText}>
                      <span class={styles.label}>{agent.name}</span>
                      <Show when={agent.role}>
                        <span class={styles.hint}>{agent.role}</span>
                      </Show>
                    </span>
                  </label>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={tooMany()}>
          <div class={styles.error} role="alert">
            {t("agentFile.export.limit")}
          </div>
        </Show>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="agent-export-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <Show when={saved()}>
          {(done) => (
            <p role="status" data-testid="agent-export-saved">
              {t("agentFile.exported", done())}
            </p>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose} data-testid="agent-export-close">
            {saved() ? t("agentFile.close") : t("agents.cancel")}
          </Button>
          <Show when={!saved()}>
            <Button
              variant="primary"
              disabled={picked().size === 0 || tooMany() || busy()}
              onClick={submit}
              data-testid="agent-export-submit"
            >
              {t("agentFile.export.submit")}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

/** The failure of an import that made some agents, read from its error detail. */
const readFailure = (error: unknown): AgentFileFailure | undefined => {
  if (!(error instanceof RpcFailure) || error.error.code !== "agent_file_failed") return undefined
  try {
    return JSON.parse(error.error.message) as AgentFileFailure
  } catch {
    return undefined
  }
}

/** List what the file will make, ask for one model, and ask to confirm. */
export const ImportAgentsDialog = (props: { preview: AgentFilePreview; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const [model, setModel] = createSignal<AgentModel | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  /** Set when the import stopped: the agents made so far stay, so it cannot run again. */
  const [stopped, setStopped] = createSignal(false)
  const hasRoutines = () => props.preview.agents.some((a) => a.routines > 0)

  const submit = async () => {
    const serverId = ui.server()?.id
    if (!serverId || busy() || stopped()) return
    setBusy(true)
    setError(undefined)
    try {
      await call("agentFile.import", { serverId, model: model() })
      props.onClose()
    } catch (e) {
      const failure = readFailure(e)
      if (failure) {
        const reason = describeError(
          new RpcFailure({ code: failure.code, message: failure.detail ?? failure.code }),
        )
        setError({
          key: "agentFile.import.stopped",
          params: { name: failure.name, made: failure.made, reason: t(reason.key, reason.params) },
        })
        setStopped(true)
      } else {
        setError(describeError(e))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      label={t("agentFile.import.title")}
      onClose={props.onClose}
      testId="agent-import-dialog"
    >
      <div class={styles.form}>
        <h2 class={styles.title}>{t("agentFile.import.title")}</h2>
        <p class={styles.hint}>{t("agentFile.import.intro")}</p>
        <ul class={styles.fileList} data-testid="agent-import-list">
          <For each={props.preview.agents}>
            {(item) => (
              <li class={styles.fileRow} data-testid="agent-import-item">
                <Face face={item.face} size={28} />
                <span class={styles.fileText}>
                  <span class={styles.label}>{item.name}</span>
                  <Show when={item.fileName}>
                    {(original) => (
                      <span class={styles.hint}>
                        {t("agentFile.import.renamed", { name: original() })}
                      </span>
                    )}
                  </Show>
                  <Show when={item.role}>
                    <span class={styles.hint}>{item.role}</span>
                  </Show>
                  <Show when={item.routines > 0}>
                    <span class={styles.hint}>
                      {t("agentFile.routines", { count: item.routines })}
                    </span>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>
        <Show when={hasRoutines()}>
          <p class={styles.hint}>{t("agentFile.import.paused")}</p>
        </Show>
        <div class={styles.field}>
          <span class={styles.label}>{t("agentFile.import.model")}</span>
          <ModelPicker value={model()} onChange={setModel} />
        </div>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="agent-import-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose} data-testid="agent-import-close">
            {stopped() ? t("agentFile.close") : t("agents.cancel")}
          </Button>
          <Show when={!stopped()}>
            <Button
              variant="primary"
              disabled={busy()}
              onClick={submit}
              data-testid="agent-import-submit"
            >
              {t("agentFile.import.submit", { count: props.preview.agents.length })}
            </Button>
          </Show>
        </div>
      </div>
    </Dialog>
  )
}

/** Tells why a file could not be read. */
export const AgentFileProblemDialog = (props: { problem: ErrorText; onClose: () => void }) => {
  const { t } = useApp()
  return (
    <Dialog label={t("agentFile.import.title")} onClose={props.onClose} testId="agent-file-problem">
      <div class={styles.form}>
        <h2 class={styles.title}>{t("agentFile.import.title")}</h2>
        <p role="alert" class={styles.error} data-testid="agent-file-problem-text">
          {t(props.problem.key, props.problem.params)}
        </p>
        <div class={styles.actions}>
          <Button variant="primary" onClick={props.onClose}>
            {t("agentFile.close")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
