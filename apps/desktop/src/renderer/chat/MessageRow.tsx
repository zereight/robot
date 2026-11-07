import {
  assistantStepText,
  type ChatPart,
  catalogues,
  chatFiles,
  chatText,
  type MessageKey,
  type MessageParams,
  type WorkflowChatMessage,
} from "@robot/shared"
import { Check, Copy, FileText, Reply, Wrench } from "lucide-solid"
import { createSignal, For, type JSX, Show } from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { openImprovement } from "../state/improve.ts"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { showToast } from "../ui/toast.ts"
import { WorkMark } from "../ui/WorkMark.tsx"
import styles from "./chat.module.css"
import { formatTime } from "./format.ts"
import { Markdown } from "./Markdown.tsx"

type Note = Extract<ChatPart, { kind: "note" }>
type Tool = Extract<ChatPart, { kind: "tool" }>

/**
 * The muted line for a note of a message. The model never reads these lines. The lines about a
 * proposal and about a saved fact have a link and an undo control only on the computer that made
 * the change: on a linked server they are plain text (spec 002, "Surfaces"; spec 008).
 */
const NoteLine = (props: { note: Note; workflowId: string }) => {
  const { t, locale } = useApp()
  const ui = useUi()
  const local = () => ui.server()?.kind === "local"
  const [undone, setUndone] = createSignal(false)
  const undo = (historyId: string) =>
    call("memory.undo", { historyId })
      .then(() => setUndone(true))
      .catch((e: unknown) => {
        const text = describeError(e)
        showToast("error", text.key, text.params)
      })
  const text = () => {
    const n = props.note
    if (n.note === "busy_retry") return t("chat.busy", { n: n.n, of: n.of })
    if (n.note === "proposals_full") return t("improve.full")
    if (n.note === "not_allowed") return t("chat.notAllowed", { server: n.server })
    if (n.note === "memory_saved") return t("chat.memory.saved", { text: n.text })
    if (n.note === "compact_failed" && n.code === "compact_stopped")
      return t("chat.compact.stopped")
    if (n.note === "compact_failed") {
      const key = `error.${n.code}`
      // The note keeps the code, not the detail: drop the empty detail and its colon.
      const reason = t(key in catalogues.en ? (key as MessageKey) : "error.unknown", {
        detail: "",
      })
      return t("chat.compact.failed", { reason: reason.replace(/\s*[:：]\s*$/, ".") })
    }
    if (n.note === "proposal")
      return n.proposalKind === "prompt"
        ? t("chat.proposal.prompt", { number: n.nodeNumber ?? 0 })
        : t(`chat.proposal.${n.proposalKind}`, { number: 0 })
    const time = formatTime(locale(), n.startedAt)
    return n.nodes.length > 0
      ? t("chat.feedback.added", { time, nodes: n.nodes.join(", ") })
      : t("chat.feedback.none", { time })
  }
  return (
    <p class={styles.note} data-testid={`note-${props.note.note}`}>
      {text()}
      <Show when={props.note.note === "proposal" && local() && props.note}>
        {(n) => (
          <>
            {" "}
            <button
              type="button"
              class={styles.linkButton}
              data-testid="note-review"
              onClick={() =>
                openImprovement(props.workflowId, (n() as { proposalId: string }).proposalId)
              }
            >
              {t("chat.proposal.review")}
            </button>
          </>
        )}
      </Show>
      <Show when={props.note.note === "memory_saved" && local() && props.note}>
        {(n) => (
          <>
            {" "}
            <Show
              when={!undone()}
              fallback={<span data-testid="note-memory-undone">{t("chat.memory.undone")}</span>}
            >
              <button
                type="button"
                class={styles.linkButton}
                data-testid="note-memory-undo"
                onClick={() => void undo((n() as { historyId: string }).historyId)}
              >
                {t("chat.memory.undo")}
              </button>
            </Show>
          </>
        )}
      </Show>
    </p>
  )
}

/**
 * The line of the card of such a tool, in the words of the interface. Plain text, never markup.
 * The deed form ("Removed node 2") shows only for a step that happened. A step that is still
 * running, that failed, or that did not happen shows as a wish ("Remove node 2"), so the card never
 * claims a change that the graph does not have.
 */
const assistantCardText = (
  part: Tool,
  t: (key: MessageKey, params?: MessageParams) => string,
): string | null =>
  assistantStepText(
    t,
    part.name,
    part.input,
    part.state === "done" && part.notRun !== true ? "deed" : "wanted",
  )

/** The word for the state of a step: a step that did not happen says so, whatever its state. */
const stateWord = (part: Tool, t: (key: MessageKey, params?: MessageParams) => string): string =>
  part.notRun === true ? t("chat.tool.notRun") : t(`chat.tool.${part.state}`)

/** A tool step as a compact card: its name and its state. A click opens the details. */
const ToolCard = (props: { part: Tool }) => {
  const { t } = useApp()
  // The tool that adds feedback shows the line of the spec, not its name and its arguments.
  if (props.part.name === "add_run_feedback")
    return (
      <div
        class={styles.tool}
        data-testid="tool-card"
        data-state={props.part.state}
        data-not-run={props.part.notRun === true}
      >
        <span class={styles.toolSummary}>
          <Wrench size={14} aria-hidden="true" />
          <span class={styles.toolText}>{t("chat.tool.feedback")}</span>
          <span class={styles.toolState}>{stateWord(props.part, t)}</span>
        </span>
      </div>
    )
  return (
    <details
      class={styles.tool}
      data-testid="tool-card"
      data-state={props.part.state}
      data-not-run={props.part.notRun === true}
    >
      <summary>
        <Wrench size={14} aria-hidden="true" />
        <span class={styles.toolName}>{assistantCardText(props.part, t) ?? props.part.label}</span>
        <span class={styles.toolState}>{stateWord(props.part, t)}</span>
      </summary>
      <pre class={styles.toolBody}>{props.part.input}</pre>
      <Show when={props.part.output}>
        <pre class={styles.toolBody}>{props.part.output}</pre>
      </Show>
    </details>
  )
}

/** Every thought of the reply, as one muted line. It opens to the list (spec 003). */
const Thoughts = (props: { thoughts: readonly string[] }) => {
  const { t } = useApp()
  return (
    <details class={styles.thinking} data-testid="thinking">
      <summary>{t("chat.thinking")}</summary>
      <For each={props.thoughts}>{(text) => <p>{text}</p>}</For>
    </details>
  )
}

export interface MessageRowProps {
  readonly message: WorkflowChatMessage
  readonly name: string
  /** True when a header (sender and time) starts above this row. */
  readonly header: boolean
  /** The message this one replies to, when it is in the chat. */
  readonly quoted: WorkflowChatMessage | undefined
  /** The last message of the chat: only it has Retry. */
  readonly last: boolean
  readonly working: boolean
  readonly onReply: (message: WorkflowChatMessage) => void
  readonly onJump: (id: string) => void
  readonly onRetry: () => void
}

export const MessageRow = (props: MessageRowProps) => {
  const { t, locale } = useApp()
  const [copied, setCopied] = createSignal(false)
  const m = () => props.message
  const mine = () => m().author === "user"
  const error = (): { key: MessageKey; params: MessageParams } | undefined => {
    const e = m().error
    if (!e) return undefined
    const key = `error.${e.code}`
    return key in catalogues.en
      ? { key: key as MessageKey, params: { detail: e.detail ?? "" } }
      : { key: "error.unknown", params: {} }
  }
  const copy = async () => {
    await call("app.copy", { text: chatText(m()) })
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  const remove = () =>
    call("chat.delete", { id: m().id }).catch((e: unknown) => {
      const text = describeError(e)
      showToast("error", text.key, text.params)
    })
  const thoughts = () =>
    m()
      .parts.filter((p): p is Extract<ChatPart, { kind: "thinking" }> => p.kind === "thinking")
      .map((p) => p.text)
  const body = (): JSX.Element => (
    <>
      <Show when={thoughts().length > 0}>
        <Thoughts thoughts={thoughts()} />
      </Show>
      <For each={m().parts}>
        {(part) => (
          <>
            <Show when={part.kind === "text" && part}>
              {(p) => (
                <Show
                  when={!mine()}
                  fallback={
                    <p class={styles.plain} data-testid="message-text">
                      {(p() as Extract<ChatPart, { kind: "text" }>).text}
                    </p>
                  }
                >
                  <div data-testid="message-text">
                    <Markdown
                      text={(p() as Extract<ChatPart, { kind: "text" }>).text}
                      scope={m().id}
                    />
                  </div>
                </Show>
              )}
            </Show>
            <Show when={part.kind === "skill" && part}>
              {(p) => (
                <span class={styles.chip} data-testid="message-skill">
                  /{(p() as Extract<ChatPart, { kind: "skill" }>).name}
                </span>
              )}
            </Show>
            <Show when={part.kind === "tool" && part}>
              {(p) => <ToolCard part={p() as Tool} />}
            </Show>
            <Show when={part.kind === "note" && part}>
              {(p) => <NoteLine note={p() as Note} workflowId={m().workflowId} />}
            </Show>
          </>
        )}
      </For>
      <Show when={chatFiles(m()).length > 0}>
        <div class={styles.files}>
          <For each={chatFiles(m())}>
            {(file) => (
              <span class={styles.chip} data-testid="message-file">
                <FileText size={14} aria-hidden="true" />
                {file.name}
              </span>
            )}
          </For>
        </div>
      </Show>
    </>
  )
  return (
    <article
      id={`message-${m().id}`}
      class={styles.row}
      data-testid="message"
      data-author={m().author}
      data-status={m().status}
      data-message-id={m().id}
    >
      <Show when={props.header}>
        <header class={styles.rowHeader}>
          <span class={styles.sender}>{mine() ? t("chat.you") : props.name}</span>
          <time class={styles.time}>{formatTime(locale(), m().createdAt)}</time>
        </header>
      </Show>
      <Show when={props.quoted}>
        {(q) => (
          <button
            type="button"
            class={styles.quote}
            data-testid="message-quote"
            onClick={() => props.onJump(q().id)}
          >
            {chatText(q()).slice(0, 120)}
          </button>
        )}
      </Show>
      {body()}
      <Show when={m().status === "streaming" && m().parts.length === 0}>
        <WorkMark />
      </Show>
      <Show when={m().status === "stopped" && m().error === null}>
        <p class={styles.note} data-testid="message-stopped">
          {t("chat.stopped")}
        </p>
      </Show>
      <Show when={m().pending}>
        <p class={styles.note} data-testid="message-pending">
          {t("chat.readNext")}{" "}
          <button
            type="button"
            class={styles.linkButton}
            onClick={remove}
            data-testid="message-delete"
          >
            {t("chat.delete")}
          </button>
        </p>
      </Show>
      <Show when={error()}>
        {(e) => (
          <div class={styles.errorRow} role="alert" data-testid="message-error">
            <span>{t(e().key, e().params)}</span>
            <Show when={props.last && !props.working}>
              <Button onClick={props.onRetry} data-testid="message-retry">
                {t("chat.retry")}
              </Button>
            </Show>
          </div>
        )}
      </Show>
      <div class={styles.actions} data-testid="message-actions">
        <button
          type="button"
          class={styles.action}
          onClick={() => props.onReply(m())}
          aria-label={t("chat.reply")}
          title={t("chat.reply")}
          data-testid="message-reply"
        >
          <Reply size={14} />
        </button>
        <button
          type="button"
          class={styles.action}
          onClick={copy}
          aria-label={t("chat.copy")}
          title={t("chat.copy")}
          data-testid="message-copy"
        >
          <Show when={copied()} fallback={<Copy size={14} />}>
            <Check size={14} />
          </Show>
        </button>
      </div>
    </article>
  )
}
