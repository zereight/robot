import {
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  type SkillSourceRef,
} from "@robot/shared"
import { createSignal, For, onMount, Show } from "solid-js"
import styles from "../agents/agents.module.css"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Segmented } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { showToast } from "../ui/toast.ts"
import skillStyles from "./skills.module.css"

/** What the form opens with: a blank form, or a draft that the model writes from some work. */
export type SkillFormOpen =
  | { readonly kind: "blank" }
  | { readonly kind: "work"; readonly source: SkillSourceRef }

const [formOpen, setFormOpen] = createSignal<SkillFormOpen>()

/** The skill form that is open, if any. One form at a time. */
export const skillForm = formOpen
/** Opens the form of a new skill (spec 017, flow 1). */
export const openSkillForm = () => setFormOpen({ kind: "blank" })
/** Opens the form of a new skill and fills it with a draft from a task, an article or an item. */
export const makeSkillFromWork = (source: SkillSourceRef) => setFormOpen({ kind: "work", source })
export const closeSkillForm = () => setFormOpen(undefined)

const FIELDS = ["name", "description", "instructions", "agents"] as const
type Field = (typeof FIELDS)[number]

const lengthOf = (text: string) => [...text.trim()].length

/**
 * The form of a new skill (spec 017, flow 1): name, description, instructions and the agents that
 * may use it. When it opens from some work, it first shows "Writing a draft…", then the draft.
 */
export const SkillFormDialog = (props: { open: SkillFormOpen; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const work = props.open.kind === "work" ? props.open.source : undefined
  const [name, setName] = createSignal("")
  const [description, setDescription] = createSignal("")
  const [instructions, setInstructions] = createSignal("")
  const [all, setAll] = createSignal(true)
  const [chosen, setChosen] = createSignal<readonly string[]>([])
  const [phase, setPhase] = createSignal<"writing" | "ready" | "failed">(work ? "writing" : "ready")
  const [failure, setFailure] = createSignal<ErrorText>()
  const [outside, setOutside] = createSignal(false)
  const [problem, setProblem] = createSignal<{ field: Field | null; text: ErrorText }>()
  const [busy, setBusy] = createSignal(false)
  let requestId = ""
  let closed = false

  /** Asks for the draft. The answer of a request that the user closed is dropped. */
  const write = async () => {
    if (!work) return
    const mine = crypto.randomUUID()
    requestId = mine
    setPhase("writing")
    setFailure(undefined)
    try {
      const result = await call("skills.draft", { requestId: mine, source: work })
      if (closed || requestId !== mine) return
      setName(result.draft.name)
      setDescription(result.draft.description)
      setInstructions(result.draft.instructions)
      setAll(false)
      setChosen([result.agentId])
      setOutside(result.outside)
      setPhase("ready")
    } catch (e) {
      if (closed || requestId !== mine) return
      setFailure(describeError(e))
      setPhase("failed")
    }
  }
  onMount(() => void write())

  const close = () => {
    // Cancel while the draft is written: the app drops the answer, and nothing is saved.
    if (phase() === "writing" && requestId) void call("skills.draftCancel", { requestId })
    closed = true
    props.onClose()
  }

  const toggle = (id: string) =>
    setChosen(chosen().includes(id) ? chosen().filter((x) => x !== id) : [...chosen(), id])

  const save = async (event?: SubmitEvent) => {
    event?.preventDefault()
    const serverId = ui.server()?.id
    if (phase() !== "ready" || busy() || !serverId) return
    setBusy(true)
    setProblem(undefined)
    try {
      await call("skills.create", {
        serverId,
        name: name(),
        description: description(),
        instructions: instructions(),
        agentIds: all() ? null : chosen(),
      })
      showToast("success", "skills.saved", { name: name().trim().replace(/^\/+/, "") })
      closed = true
      props.onClose()
    } catch (e) {
      const detail = e instanceof RpcFailure ? e.error.message : ""
      const field = (FIELDS as readonly string[]).includes(detail) ? (detail as Field) : null
      setProblem({ field, text: describeError(e) })
    } finally {
      setBusy(false)
    }
  }

  const under = (field: Field) => (
    <Show when={problem()?.field === field ? problem() : undefined}>
      {(p) => (
        <span class={styles.fieldError} role="alert" data-testid={`skill-error-${field}`}>
          {t(p().text.key, p().text.params)}
        </span>
      )}
    </Show>
  )

  const locked = () => phase() !== "ready"

  return (
    <Dialog label={t("skills.form.title")} onClose={close} testId="skill-form-dialog">
      <form class={styles.form} onSubmit={save} data-testid="skill-form" data-phase={phase()}>
        <h2 class={styles.title}>{work ? t("skills.make") : t("skills.form.title")}</h2>
        <Show when={phase() === "writing"}>
          <p class={styles.hint} role="status" data-testid="skill-writing">
            {t("skills.make.writing")}
          </p>
        </Show>
        <Show when={phase() === "failed" ? failure() : undefined}>
          {(reason) => (
            <div class={skillStyles.failed}>
              <p class={styles.error} role="alert" data-testid="skill-failed">
                {t("skills.make.failed", { reason: t(reason().key, { detail: "" }) })}
              </p>
              <Button onClick={() => void write()} data-testid="skill-retry">
                {t("skills.make.retry")}
              </Button>
            </div>
          )}
        </Show>
        <Show when={phase() === "ready" && outside()}>
          <p class={styles.hint} data-testid="skill-outside">
            {t("skills.make.outside")}
          </p>
        </Show>
        <fieldset class={skillStyles.fields} disabled={locked()}>
          <label class={styles.field}>
            <span class={styles.fieldTop}>
              <span class={styles.label}>{t("skills.form.name")}</span>
              <span class={styles.counter} data-over={lengthOf(name()) > SKILL_NAME_MAX}>
                {lengthOf(name())}/{SKILL_NAME_MAX}
              </span>
            </span>
            <input
              class={styles.input}
              value={name()}
              aria-invalid={problem()?.field === "name"}
              onInput={(e) => setName(e.currentTarget.value)}
              data-testid="skill-name"
              autofocus
            />
            {under("name")}
          </label>
          <label class={styles.field}>
            <span class={styles.fieldTop}>
              <span class={styles.label}>{t("skills.form.description")}</span>
              <span
                class={styles.counter}
                data-over={lengthOf(description()) > SKILL_DESCRIPTION_MAX}
              >
                {lengthOf(description())}/{SKILL_DESCRIPTION_MAX}
              </span>
            </span>
            <input
              class={styles.input}
              value={description()}
              aria-invalid={problem()?.field === "description"}
              onInput={(e) => setDescription(e.currentTarget.value)}
              data-testid="skill-description"
            />
            {under("description")}
          </label>
          <label class={styles.field}>
            <span class={styles.fieldTop}>
              <span class={styles.label}>{t("skills.form.instructions")}</span>
              <span
                class={styles.counter}
                data-over={instructions().length > SKILL_INSTRUCTIONS_MAX}
              >
                {instructions().length}/{SKILL_INSTRUCTIONS_MAX}
              </span>
            </span>
            <textarea
              class={`${styles.textarea} ${styles.draftInstructions}`}
              value={instructions()}
              aria-invalid={problem()?.field === "instructions"}
              onInput={(e) => setInstructions(e.currentTarget.value)}
              data-testid="skill-instructions"
            />
            {under("instructions")}
            <span class={styles.hint} data-testid="skill-privacy">
              {t("skills.form.privacy")}
            </span>
          </label>
          <div class={styles.field} data-testid="skill-agents">
            <span class={styles.label}>{t("skills.form.agents")}</span>
            <Segmented
              label={t("skills.form.agents")}
              testId="skill-agents-mode"
              value={all() ? "all" : "some"}
              onChange={(value) => setAll(value === "all")}
              options={[
                { value: "all", label: t("skills.form.agents.all") },
                { value: "some", label: t("skills.form.agents.some") },
              ]}
            />
            <Show when={!all()}>
              <ul class={skillStyles.agentList} data-testid="skill-agent-list">
                <For each={agents.agents()}>
                  {(agent) => (
                    <li>
                      <label class={skillStyles.agentRow}>
                        <input
                          type="checkbox"
                          checked={chosen().includes(agent.id)}
                          onChange={() => toggle(agent.id)}
                          data-testid="skill-agent"
                          data-agent={agent.name}
                        />
                        <span>{agent.name}</span>
                      </label>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            {under("agents")}
          </div>
        </fieldset>
        <Show when={problem()?.field === null ? problem() : undefined}>
          {(p) => (
            <p class={styles.error} role="alert" data-testid="skill-error">
              {t(p().text.key, p().text.params)}
            </p>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={close} data-testid="skill-cancel">
            {t("skills.form.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={locked() || busy()}
            data-testid="skill-save"
          >
            {t("skills.form.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
