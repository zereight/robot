import {
  type Agent,
  type ChatMessage,
  HANDOVER_LIMITS,
  type HandoverOffReason,
  type HandoverOpen,
  type HandoverState,
  handoverTextValid,
  type MessageKey,
  type MessagePart,
} from "@robot/shared"
import { ArrowLeftRight } from "lucide-solid"
import { createEffect, createSignal, For, type JSX, on, onCleanup, onMount, Show } from "solid-js"
import { Face } from "../agents/Face.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./handover.module.css"
import { createThreads, openThread, threadPart } from "./threads.ts"

// "Hand over" (spec 003): the menu choice, the dialog, the card of the new thread, and the muted
// line of the chat that the user left. This computer only: a linked computer and the phone show
// the line for a main thread and nothing else.

/** The words of a reason why "Hand over" is off. */
export const offKey = (reason: HandoverOffReason) => `handover.off.${reason}` as MessageKey

/** Whether "Hand over" is on for a chat or thread, kept in step with the main process. */
export const createHandoverState = (agentId: () => string, threadId: () => string | null) => {
  const [state, setState] = createSignal<HandoverState>()
  let run = 0
  const load = () => {
    const mine = ++run
    call("chat.handover.state", { agentId: agentId(), ...threadPart(threadId()) })
      .then((value) => {
        if (mine === run) setState(value)
      })
      .catch(() => {
        if (mine === run) setState(undefined)
      })
  }
  createEffect(on([agentId, threadId], load))
  // A message, a turn that starts or ends, and a new or archived agent change the answer.
  onCleanup(
    window.robot.on("chat.threads", (event) => {
      if (event.agentId === agentId()) load()
    }),
  )
  onCleanup(window.robot.on("tasks.changed", load))
  onCleanup(window.robot.on("agents.changed", load))
  return state
}

/**
 * Whether a place can be opened as the other side of a handover: the agent is in the list, and for
 * a thread the thread still exists. A linked computer opens none. When the other side is deleted,
 * the words stay and the link goes (spec 003, "Flows" 4).
 */
const createLinkTarget = (agentId: () => string, threadId: () => string | null) => {
  const ui = useUi()
  const agents = useAgents()
  const threads = createThreads(agentId)
  return () =>
    !ui.linked() &&
    agents.byId(agentId()) !== undefined &&
    (threadId() === null ||
      (threads.loaded && threads.list.threads.some((x) => x.id === threadId())))
}

/** Words that open a place of the other side of a handover, or plain text when it is gone. */
export const HandoverLink = (props: {
  agentId: string
  threadId: string | null
  testId: string
  children: JSX.Element
}) => {
  const ui = useUi()
  const live = createLinkTarget(
    () => props.agentId,
    () => props.threadId,
  )
  const open = () => {
    openThread(props.agentId, props.threadId)
    ui.selectPlace({ kind: "agent", id: props.agentId })
  }
  return (
    <Show
      when={live()}
      fallback={
        <span class={styles.plain} data-testid={props.testId} data-link="false">
          {props.children}
        </span>
      }
    >
      <button
        type="button"
        class={styles.link}
        onClick={open}
        data-testid={props.testId}
        data-link="true"
      >
        {props.children}
      </button>
    </Show>
  )
}

/** The muted line "Handed over to <name>" in the chat that the user left. */
export const HandedOverText = (props: {
  part: Extract<MessagePart, { kind: "note"; note: "handed_over" }>
}) => {
  const { t } = useApp()
  return (
    <HandoverLink
      agentId={props.part.toAgentId}
      threadId={props.part.toThreadId}
      testId="handover-line-link"
    >
      {t("handover.line", { name: props.part.toName })}
    </HandoverLink>
  )
}

/**
 * The handover card at the start of the new thread (spec 003): "From <name>" with a link back,
 * and the brief folded. The card is no words of the user.
 */
export const HandoverCard = (props: {
  message: ChatMessage
  part: Extract<MessagePart, { kind: "handover" }>
}) => {
  const { t } = useApp()
  return (
    <div class={styles.card} data-message-id={props.message.id} data-testid="handover-card">
      <div class={styles.cardHead}>
        <ArrowLeftRight size={14} aria-hidden="true" />
        <HandoverLink
          agentId={props.part.fromAgentId}
          threadId={props.part.fromThreadId}
          testId="handover-card-from"
        >
          {t("handover.card.from", { name: props.part.fromName })}
        </HandoverLink>
      </div>
      <details class={styles.fold} data-testid="handover-card-fold">
        <summary>{t("handover.card.label")}</summary>
        <pre class={styles.brief} data-testid="handover-card-brief">
          {props.part.brief}
        </pre>
      </details>
    </div>
  )
}

/** The dialog of "Hand over": the agent, the words for it, the brief, and the two buttons. */
export const HandoverDialog = (props: {
  agentId: string
  threadId: string | null
  onClose: () => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const [opened, setOpened] = createSignal<HandoverOpen>()
  const [error, setError] = createSignal<ErrorText>()
  const [pick, setPick] = createSignal<string>()
  const [text, setText] = createSignal("")
  const [busy, setBusy] = createSignal(false)

  onMount(() => {
    call("chat.handover.open", { agentId: props.agentId, ...threadPart(props.threadId) })
      .then((value) => {
        setOpened(value)
        setPick(value.candidates.find((c) => !c.full)?.agentId)
      })
      .catch((e) => setError(describeError(e)))
  })

  /** The agents of the list, with their data. An agent that left the list since is dropped. */
  const rows = () =>
    (opened()?.candidates ?? []).flatMap((c) => {
      const agent = agents.byId(c.agentId)
      return agent ? [{ agent, full: c.full }] : []
    })
  const picked = (): Agent | undefined => (pick() ? agents.byId(pick() as string) : undefined)
  const length = () => text().length
  const valid = () => picked() !== undefined && handoverTextValid(text())

  const submit = async (event?: SubmitEvent) => {
    event?.preventDefault()
    const brief = opened()
    const to = picked()
    if (!brief || !to || !valid() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      const made = await call("chat.handover.start", {
        agentId: props.agentId,
        ...threadPart(props.threadId),
        toAgentId: to.id,
        text: text().trim(),
        briefId: brief.briefId,
      })
      // The window opens the new thread (spec 003).
      openThread(made.agentId, made.threadId)
      ui.selectPlace({ kind: "agent", id: made.agentId })
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog label={t("handover.dialog.title")} onClose={props.onClose} testId="handover-dialog">
      <form class={styles.form} onSubmit={submit}>
        <h2 class={styles.title}>{t("handover.dialog.title")}</h2>
        <p class={styles.hint}>{t("handover.dialog.intro")}</p>
        <Show when={!opened() && !error()}>
          <p class={styles.hint} data-testid="handover-loading">
            {t("handover.loading")}
          </p>
        </Show>
        <Show when={opened()}>
          <fieldset class={styles.group}>
            <legend class={styles.label}>{t("handover.agent")}</legend>
            <div class={styles.agents} role="radiogroup" aria-label={t("handover.agent")}>
              <For each={rows()}>
                {(row) => (
                  <label
                    class={styles.agent}
                    data-disabled={row.full ? "true" : undefined}
                    data-checked={pick() === row.agent.id ? "true" : undefined}
                    data-testid="handover-agent"
                    data-agent-id={row.agent.id}
                  >
                    <input
                      type="radio"
                      name="handover-agent"
                      class={styles.radio}
                      checked={pick() === row.agent.id}
                      disabled={row.full}
                      onChange={() => setPick(row.agent.id)}
                    />
                    <Face
                      face={row.agent.face}
                      image={row.agent.faceImage}
                      size={28}
                      agentId={row.agent.id}
                    />
                    <span class={styles.agentText}>
                      <span class={styles.agentName}>{row.agent.name}</span>
                      <Show when={row.agent.role}>
                        <span class={styles.agentRole}>{row.agent.role}</span>
                      </Show>
                      <Show when={row.full}>
                        <span class={styles.agentOff} data-testid="handover-agent-full">
                          {t("handover.agent.full", { name: row.agent.name })}
                        </span>
                      </Show>
                    </span>
                  </label>
                )}
              </For>
            </div>
          </fieldset>
          <label class={styles.field}>
            <span class={styles.fieldTop}>
              <span class={styles.label}>{t("handover.next", { name: picked()?.name ?? "" })}</span>
              <span class={styles.counter} data-over={length() > HANDOVER_LIMITS.textMax}>
                {length()}/{HANDOVER_LIMITS.textMax}
              </span>
            </span>
            <textarea
              class={styles.textarea}
              value={text()}
              required
              onInput={(e) => setText(e.currentTarget.value)}
              data-testid="handover-text"
              autofocus
            />
          </label>
          <details class={styles.fold} data-testid="handover-brief-fold">
            <summary>{t("handover.brief.show")}</summary>
            <pre class={styles.brief} data-testid="handover-brief">
              {opened()?.brief}
            </pre>
          </details>
        </Show>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="handover-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose} data-testid="handover-cancel">
            {t("handover.cancel")}
          </Button>
          <Button
            type="submit"
            variant="primary"
            disabled={busy() || !opened() || !valid()}
            data-testid="handover-submit"
          >
            {t("handover.submit")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
