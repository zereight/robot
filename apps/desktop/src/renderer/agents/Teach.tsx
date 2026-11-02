import {
  catalogues,
  type MessageKey,
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  TEACH_RESULT_MAX,
  type TeachState,
} from "@robot/shared"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { fillComposer } from "../chat/fill.ts"
import { formatElapsed } from "../chat/format.ts"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./agents.module.css"

// "Teach a task" (spec 017). One recording at a time on this computer, so the state is one value
// for the whole window.

const [teachState, setTeachState] = createSignal<TeachState>({ phase: "idle" })
let listening = false

/** The state of "Teach a task" on this computer, kept in step with the main process. */
export const useTeach = () => {
  if (!listening) {
    listening = true
    window.robot.on("teach.changed", setTeachState)
    void call("teach.state")
      .then(setTeachState)
      .catch(() => {})
  }
  return teachState
}

const [formFor, setFormFor] = createSignal<string>()
/** The agent whose "Teach a task" form is open. */
export const teachFormFor = formFor
export const openTeachForm = (agentId: string) => setFormFor(agentId)
export const closeTeachForm = () => setFormFor(undefined)

/** Why "Teach a task" is off for this agent now, or `undefined` when it can start. */
export const teachBlocked = (
  state: TeachState,
  agentId: string,
): { key: MessageKey; params?: Record<string, string> } | undefined => {
  if (state.phase === "idle") return undefined
  return state.agentId === agentId
    ? { key: "teach.busy.self" }
    : { key: "teach.busy.other", params: { name: state.agentName } }
}

/** The short form that asks what the result of the task is. */
export const TeachDialog = (props: { agentId: string; onClose: () => void }) => {
  const { t } = useApp()
  const state = useTeach()
  const [result, setResult] = createSignal("")
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  const length = () => [...result().trim()].length
  const blocked = () => teachBlocked(state(), props.agentId)
  const start = async (event?: SubmitEvent) => {
    event?.preventDefault()
    if (length() === 0 || length() > TEACH_RESULT_MAX || blocked()) return
    setBusy(true)
    setError(undefined)
    try {
      await call("teach.start", { agentId: props.agentId, result: result().trim() })
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog label={t("teach.title")} onClose={props.onClose} testId="teach-dialog">
      <form class={styles.form} onSubmit={start}>
        <h2 class={styles.title}>{t("teach.title")}</h2>
        <p class={styles.hint}>{t("teach.intro")}</p>
        <label class={styles.field}>
          <span class={styles.fieldTop}>
            <span class={styles.label}>{t("teach.result")}</span>
            <span class={styles.counter} data-over={length() > TEACH_RESULT_MAX}>
              {length()}/{TEACH_RESULT_MAX}
            </span>
          </span>
          <textarea
            class={styles.textarea}
            value={result()}
            placeholder={t("teach.result.placeholder")}
            onInput={(e) => setResult(e.currentTarget.value)}
            data-testid="teach-result"
            autofocus
          />
          <span class={styles.hint}>{t("teach.result.hint")}</span>
        </label>
        <Show when={blocked()}>
          {(reason) => (
            <div class={styles.hint} data-testid="teach-blocked">
              {t(reason().key, reason().params)}
            </div>
          )}
        </Show>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose}>{t("agents.cancel")}</Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy() || length() === 0 || length() > TEACH_RESULT_MAX || !!blocked()}
            data-testid="teach-start"
          >
            {t("teach.start")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

/** A clock that ticks while it is shown. */
const useNow = () => {
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return now
}

/**
 * The bar above the browser while the user teaches: the result, the time, the number of steps,
 * a field for an address, Pause, "Stop teaching" and Cancel.
 */
export const TeachBar = (props: { state: Extract<TeachState, { phase: "recording" }> }) => {
  const { t } = useApp()
  const now = useNow()
  const [address, setAddress] = createSignal("")
  const [error, setError] = createSignal<ErrorText>()
  const time = () =>
    formatElapsed(props.state.elapsedMs + (props.state.paused ? 0 : now() - props.state.at))
  const act = async (run: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await run()
    } catch (e) {
      setError(describeError(e))
    }
  }
  const open = (event: SubmitEvent) => {
    event.preventDefault()
    if (!address().trim()) return
    void act(() => call("teach.open", { url: address().trim() }))
  }
  const stop = () =>
    act(async () => {
      const { empty } = await call("teach.stop")
      if (empty) showToast("error", "teach.empty")
    })
  return (
    <div class={styles.teachBar} data-testid="teach-bar" data-paused={props.state.paused}>
      <div class={styles.teachRow}>
        <span class={styles.teachMark}>
          {props.state.paused ? t("teach.paused") : t("teach.teaching")}
        </span>
        <span class={styles.teachResult} title={props.state.result} data-user-data>
          {props.state.result}
        </span>
        <span class={styles.teachCount} data-testid="teach-time">
          {time()}
        </span>
        <span class={styles.teachCount} data-testid="teach-steps">
          {t("teach.steps", { count: props.state.steps })}
        </span>
      </div>
      <div class={styles.teachRow}>
        <form class={styles.teachAddress} onSubmit={open}>
          <input
            class={styles.input}
            value={address()}
            placeholder={t("teach.address")}
            aria-label={t("teach.address")}
            onInput={(e) => setAddress(e.currentTarget.value)}
            data-testid="teach-address"
          />
          <Button type="submit" data-testid="teach-open">
            {t("teach.open")}
          </Button>
        </form>
        <Button
          onClick={() => act(() => call("teach.pause", { paused: !props.state.paused }))}
          data-testid="teach-pause"
        >
          {props.state.paused ? t("teach.resume") : t("teach.pause")}
        </Button>
        <Button variant="primary" onClick={stop} data-testid="teach-stop">
          {t("teach.stop")}
        </Button>
        <Button onClick={() => act(() => call("teach.cancel"))} data-testid="teach-cancel">
          {t("teach.cancel")}
        </Button>
      </div>
      <Show when={error()}>
        {(err) => <div class={styles.error}>{t(err().key, err().params)}</div>}
      </Show>
    </div>
  )
}

/** The text of an error code. A code with no text of its own gets the general one. */
const errorText = (code: string | null): MessageKey => {
  const key = `error.${code ?? "unknown"}`
  return key in catalogues.en ? (key as MessageKey) : "error.unknown"
}

type DraftPhase = Exclude<TeachState, { phase: "idle" } | { phase: "recording" }>

const SKILL_FIELDS = ["name", "description", "instructions"] as const
type SkillField = (typeof SKILL_FIELDS)[number]

/**
 * The "Draft skill" card in the chat. The user edits the name, the description and the
 * instructions, then saves or discards. After a save, "Try it" puts the chip in the message box.
 */
export const DraftCard = (props: { state: DraftPhase }) => {
  const { t } = useApp()
  const [name, setName] = createSignal(props.state.draft?.name ?? "")
  const [description, setDescription] = createSignal(props.state.draft?.description ?? "")
  const [instructions, setInstructions] = createSignal(props.state.draft?.instructions ?? "")
  const [filled, setFilled] = createSignal(props.state.draft !== null)
  const [problem, setProblem] = createSignal<{ field: SkillField | null; text: ErrorText }>()
  const [busy, setBusy] = createSignal(false)
  // The draft arrives after the card shows. Its fields fill once; then they are the user's.
  createEffect(() => {
    const draft = props.state.draft
    if (!draft || filled()) return
    setFilled(true)
    setName(draft.name)
    setDescription(draft.description)
    setInstructions(draft.instructions)
  })
  const save = async () => {
    setBusy(true)
    setProblem(undefined)
    try {
      await call("teach.save", {
        name: name(),
        description: description(),
        instructions: instructions(),
      })
    } catch (e) {
      const field =
        e instanceof RpcFailure && (SKILL_FIELDS as readonly string[]).includes(e.error.message)
          ? (e.error.message as SkillField)
          : null
      setProblem({ field, text: describeError(e) })
    } finally {
      setBusy(false)
    }
  }
  const under = (field: SkillField) => (
    <Show when={problem()?.field === field ? problem() : undefined}>
      {(p) => (
        <span class={styles.error} data-testid={`draft-error-${field}`}>
          {t(p().text.key, p().text.params)}
        </span>
      )}
    </Show>
  )
  const tryIt = () => {
    const skill = props.state.skill
    if (!skill) return
    fillComposer({ agentId: props.state.agentId, skill, text: props.state.result })
    void call("teach.discard")
  }
  let card: HTMLElement | undefined
  // The card comes at the end of the chat. It shows itself, so the user sees the draft come.
  onMount(() => card?.scrollIntoView({ block: "nearest" }))
  return (
    <section
      ref={card}
      class={styles.draftCard}
      aria-label={t("teach.draft.title")}
      data-testid="draft-card"
      data-phase={props.state.phase}
    >
      <header class={styles.draftHead}>
        <span class={styles.label}>{t("teach.draft.title")}</span>
        <span class={styles.hint} data-testid="draft-steps">
          {t("teach.steps", { count: props.state.steps })}
        </span>
      </header>
      <Show when={props.state.limit}>
        {(limit) => (
          <p class={styles.hint} data-testid="draft-limit">
            {limit() === "steps" ? t("teach.limit.steps") : t("teach.limit.time")}
          </p>
        )}
      </Show>
      <Show when={props.state.phase === "drafting"}>
        <p class={styles.hint} data-testid="draft-writing">
          {t("teach.draft.writing")}
        </p>
        <div class={styles.actions}>
          <Button onClick={() => call("teach.discard")} data-testid="draft-discard">
            {t("teach.draft.discard")}
          </Button>
        </div>
      </Show>
      <Show when={props.state.phase === "failed"}>
        <p class={styles.error} role="alert" data-testid="draft-failed">
          {t("teach.draft.failed", {
            reason: t(errorText(props.state.error), { detail: "" }),
          })}
        </p>
        <div class={styles.actions}>
          <Button onClick={() => call("teach.discard")} data-testid="draft-discard">
            {t("teach.draft.discard")}
          </Button>
          <Button variant="primary" onClick={() => call("teach.retry")} data-testid="draft-retry">
            {t("teach.draft.retry")}
          </Button>
        </div>
      </Show>
      <Show when={props.state.phase === "draft" || props.state.phase === "saved"}>
        <fieldset class={styles.draftFields} disabled={props.state.phase === "saved"}>
          <label class={styles.field}>
            <span class={styles.fieldTop}>
              <span class={styles.label}>{t("teach.draft.name")}</span>
              <span class={styles.counter} data-over={[...name().trim()].length > SKILL_NAME_MAX}>
                {[...name().trim()].length}/{SKILL_NAME_MAX}
              </span>
            </span>
            <input
              class={styles.input}
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
              data-testid="draft-name"
            />
            {under("name")}
          </label>
          <label class={styles.field}>
            <span class={styles.fieldTop}>
              <span class={styles.label}>{t("teach.draft.description")}</span>
              <span
                class={styles.counter}
                data-over={[...description().trim()].length > SKILL_DESCRIPTION_MAX}
              >
                {[...description().trim()].length}/{SKILL_DESCRIPTION_MAX}
              </span>
            </span>
            <input
              class={styles.input}
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
              data-testid="draft-description"
            />
            {under("description")}
          </label>
          <label class={styles.field}>
            <span class={styles.label}>{t("teach.draft.instructions")}</span>
            <textarea
              class={`${styles.textarea} ${styles.draftInstructions}`}
              value={instructions()}
              onInput={(e) => setInstructions(e.currentTarget.value)}
              data-testid="draft-instructions"
            />
            {under("instructions")}
            <span class={styles.hint}>{t("teach.draft.privacy")}</span>
          </label>
        </fieldset>
        <Show when={problem()?.field === null ? problem() : undefined}>
          {(p) => (
            <p class={styles.error} role="alert" data-testid="draft-error">
              {t(p().text.key, p().text.params)}
            </p>
          )}
        </Show>
        <Show
          when={props.state.phase === "saved"}
          fallback={
            <div class={styles.actions}>
              <Button onClick={() => call("teach.discard")} data-testid="draft-discard">
                {t("teach.draft.discard")}
              </Button>
              <Button variant="primary" onClick={save} disabled={busy()} data-testid="draft-save">
                {t("teach.draft.save")}
              </Button>
            </div>
          }
        >
          <div class={styles.actions}>
            <span class={styles.draftSaved} data-testid="draft-saved">
              {t("teach.draft.saved")}
            </span>
            <Button onClick={() => call("teach.discard")} data-testid="draft-close">
              {t("teach.draft.close")}
            </Button>
            <Button variant="primary" onClick={tryIt} data-testid="draft-try">
              {t("teach.draft.try")}
            </Button>
          </div>
        </Show>
      </Show>
    </section>
  )
}
