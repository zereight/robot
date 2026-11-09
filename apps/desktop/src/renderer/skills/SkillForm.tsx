import {
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  type Skill,
  type SkillDraft,
  type SkillFactResult,
} from "@robot/shared"
import { createSignal, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { trySkill } from "../state/skillTry.ts"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { showToast } from "../ui/toast.ts"
import { SkillCheckLines } from "./SkillCheck.tsx"
import { dietPercent } from "./skillCheck.ts"
import styles from "./skills.module.css"

/**
 * What the form opens with: a blank form, a skill that exists to edit, or the draft of a skill
 * from a workflow to review (spec 017, "Make a skill from a workflow").
 */
export type SkillFormOpen =
  | { readonly kind: "blank" }
  | { readonly kind: "edit"; readonly skill: Skill }
  | { readonly kind: "draft"; readonly draft: SkillDraft; readonly workflowId: string }

const [formOpen, setFormOpen] = createSignal<SkillFormOpen>()

/** The skill form that is open, if any. One form at a time. */
export const skillForm = formOpen
/** Opens the form of a new skill (spec 017, flow 1). */
export const openSkillForm = () => setFormOpen({ kind: "blank" })
/** Opens the form of a skill that exists (spec 017, flow 2). */
export const editSkill = (skill: Skill) => setFormOpen({ kind: "edit", skill })
/** Opens the review of a draft skill from a workflow (spec 017, flow 10). */
export const openSkillDraft = (draft: SkillDraft, workflowId: string) =>
  setFormOpen({ kind: "draft", draft, workflowId })
export const closeSkillForm = () => setFormOpen(undefined)

const FIELDS = ["name", "description", "instructions"] as const
type Field = (typeof FIELDS)[number]

const lengthOf = (text: string) => [...text.trim()].length

/**
 * The form of a skill (spec 017, flows 1 and 2): name, description and instructions. A skill is
 * for the whole server. It opens blank, or with the fields of a skill to edit.
 */
export const SkillFormDialog = (props: { open: SkillFormOpen; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const edited = props.open.kind === "edit" ? props.open.skill : undefined
  const draft = props.open.kind === "draft" ? props.open.draft : undefined
  const workflowId = props.open.kind === "draft" ? props.open.workflowId : undefined
  const [name, setName] = createSignal(edited?.name ?? draft?.name ?? "")
  const [description, setDescription] = createSignal(
    edited?.description ?? draft?.description ?? "",
  )
  const [instructions, setInstructions] = createSignal(
    edited?.instructions ?? draft?.instructions ?? "",
  )
  const [problem, setProblem] = createSignal<{ field: Field | null; text: ErrorText }>()
  const [busy, setBusy] = createSignal(false)
  const [checked, setChecked] = createSignal<{
    readonly skill: Skill
    readonly facts: readonly SkillFactResult[]
  }>()

  const close = () => props.onClose()

  const save = async (event?: SubmitEvent) => {
    event?.preventDefault()
    const serverId = ui.server()?.id
    if (busy() || !serverId) return
    setBusy(true)
    setProblem(undefined)
    try {
      const fields = {
        name: name(),
        description: description(),
        instructions: instructions(),
      }
      if (edited) await call("skills.update", { id: edited.id, ...fields })
      else if (draft) {
        const skill = await call("skills.create", { serverId, ...fields })
        setChecked({ skill, facts: await call("skills.check", { id: skill.id }) })
        return
      } else await call("skills.create", { serverId, ...fields })
      showToast("success", "skills.saved", { name: name().trim().replace(/^\/+/, "") })
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

  const title = () =>
    checked()
      ? t("skills.check.title")
      : draft
        ? t("skills.fromWorkflow")
        : edited
          ? t("skills.form.edit")
          : t("skills.form.title")

  // After the save of a draft, the same dialog shows the skill check with "Try it" (spec 017).
  const saved = () => {
    const result = checked()
    return result && workflowId ? { ...result, workflowId } : undefined
  }

  // The diet of the draft as generated, not of the edited text (spec 017, step 3).
  const dietLine = draft
    ? {
        before: draft.before,
        after: draft.after,
        percent: dietPercent(draft.before, draft.after),
      }
    : undefined

  return (
    <Dialog
      label={title()}
      onClose={close}
      testId={draft ? "skill-draft-dialog" : "skill-form-dialog"}
    >
      <Show
        when={saved()}
        fallback={
          <form class={styles.form} onSubmit={save} data-testid="skill-form">
            <h2 class={styles.title}>{title()}</h2>
            <Show when={dietLine}>
              {(line) => {
                const diet = line()
                return (
                  <p class={styles.hint} data-testid="skill-diet">
                    {diet.percent === null
                      ? t("skills.draft.nothingToCut")
                      : t("skills.draft.diet", {
                          before: diet.before,
                          after: diet.after,
                          percent: diet.percent,
                        })}
                  </p>
                )
              }}
            </Show>
            <fieldset class={styles.fields}>
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
                  class={`${styles.textarea} ${styles.instructions}`}
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
            </fieldset>
            <Show when={problem()?.field === null ? problem() : undefined}>
              {(p) => (
                <p class={styles.error} role="alert" data-testid="skill-error">
                  {t(p().text.key, p().text.params)}
                </p>
              )}
            </Show>
            <div class={styles.actions}>
              <Button onClick={close} data-testid={draft ? "skill-discard" : "skill-cancel"}>
                {draft ? t("skills.draft.discard") : t("skills.form.cancel")}
              </Button>
              <Button type="submit" variant="primary" disabled={busy()} data-testid="skill-save">
                {t("skills.form.save")}
              </Button>
            </div>
          </form>
        }
      >
        {(result) => (
          <div class={styles.form} data-testid="skill-check-view">
            <h2 class={styles.title}>{title()}</h2>
            <SkillCheckLines facts={result().facts} />
            <div class={styles.actions}>
              <Button onClick={close} data-testid="skill-check-close">
                {t("skills.check.close")}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  trySkill(result().workflowId, result().skill)
                  close()
                }}
                data-testid="skill-try"
              >
                {t("skills.draft.tryIt")}
              </Button>
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  )
}
