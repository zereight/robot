import {
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
import { Button } from "../ui/controls.tsx"
import { showToast } from "../ui/toast.ts"
import { WorkMark } from "../ui/WorkMark.tsx"
import styles from "./chat.module.css"
import { formatTime } from "./format.ts"
import { Markdown } from "./Markdown.tsx"

type Note = Extract<ChatPart, { kind: "note" }>
type Tool = Extract<ChatPart, { kind: "tool" }>

/** The muted line for a note of a message. The model never reads these lines. */
const NoteLine = (props: { note: Note }) => {
  const { t, locale } = useApp()
  const text = () => {
    const n = props.note
    if (n.note === "busy_retry") return t("chat.busy", { n: n.n, of: n.of })
    const time = formatTime(locale(), n.startedAt)
    return n.nodes.length > 0
      ? t("chat.feedback.added", { time, nodes: n.nodes.join(", ") })
      : t("chat.feedback.none", { time })
  }
  return (
    <p class={styles.note} data-testid={`note-${props.note.note}`}>
      {text()}
    </p>
  )
}

/** A tool step as a compact card: its name and its state. A click opens the details. */
const ToolCard = (props: { part: Tool }) => {
  const { t } = useApp()
  // The tool that adds feedback shows the line of the spec, not its name and its arguments.
  if (props.part.name === "add_run_feedback")
    return (
      <div class={styles.tool} data-testid="tool-card" data-state={props.part.state}>
        <span class={styles.toolSummary}>
          <Wrench size={14} aria-hidden="true" />
          <span class={styles.toolText}>{t("chat.tool.feedback")}</span>
          <span class={styles.toolState}>{t(`chat.tool.${props.part.state}`)}</span>
        </span>
      </div>
    )
  return (
    <details class={styles.tool} data-testid="tool-card" data-state={props.part.state}>
      <summary>
        <Wrench size={14} aria-hidden="true" />
        <span class={styles.toolName}>{props.part.label}</span>
        <span class={styles.toolState}>{t(`chat.tool.${props.part.state}`)}</span>
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
              {(p) => <NoteLine note={p() as Note} />}
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
