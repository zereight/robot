import {
  assistantStepText,
  type ChatPart,
  type ChatSegment,
  type ChatToolPart,
  catalogues,
  chatFiles,
  chatText,
  foldedToolsKey,
  groupChatParts,
  isReadableReply,
  type MessageKey,
  type MessageParams,
  type WorkflowChatMessage,
} from "@robot/shared"
import { Check, Copy, FileText, Mail, Pencil, Reply, Wrench } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  Show,
  Switch,
} from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { openImprovement } from "../state/improve.ts"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Keyed } from "../ui/Keyed.tsx"
import { showToast } from "../ui/toast.ts"
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

/**
 * The folded series that the user opened. The state lives here and not in the row, so a line that
 * the user opened stays open when the series takes another step and when the chat is drawn again
 * (spec 003, "Folded tool steps"). The key is the message and the first step of the series.
 */
const [openRuns, setOpenRuns] = createSignal<ReadonlySet<string>>(new Set())

/**
 * A series of plain tool steps as one muted line with the count, when "Show tool steps" is off.
 * The line is a disclosure: a click, Enter or Space opens the cards and closes them again. A step
 * that runs joins the series, so the line keeps its place while the turn goes on (spec 003).
 */
const ToolRun = (props: { id: string; parts: readonly ChatToolPart[] }) => {
  const { t } = useApp()
  const open = () => openRuns().has(props.id)
  const set = (value: boolean) =>
    setOpenRuns((now) => {
      if (now.has(props.id) === value) return now
      const next = new Set(now)
      if (value) next.add(props.id)
      else next.delete(props.id)
      return next
    })
  return (
    <details
      class={styles.toolsFolded}
      data-testid="tools-folded"
      data-count={props.parts.length}
      open={open()}
      onToggle={(e) => set(e.currentTarget.open)}
    >
      <summary data-testid="tools-folded-line">
        {t(foldedToolsKey(props.parts.length), { count: props.parts.length })}
      </summary>
      <Keyed each={props.parts} by={(part) => part.id}>
        {(part) => <ToolCard part={part()} />}
      </Keyed>
    </details>
  )
}

/** One row of the body of a reply: a part, or the one line of a series of tool steps. */
const SegmentRow = (props: {
  message: () => WorkflowChatMessage
  segment: () => ChatSegment
  mine: boolean
}) => {
  const seg = () => props.segment()
  const part = () => {
    const s = seg()
    return s.kind === "part" ? s.part : undefined
  }
  const tools = () => {
    const s = seg()
    return s.kind === "tools" ? s.parts : undefined
  }
  const text = () => {
    const p = part()
    return p?.kind === "text" ? p : undefined
  }
  const skill = () => {
    const p = part()
    return p?.kind === "skill" ? p : undefined
  }
  const tool = () => {
    const p = part()
    return p?.kind === "tool" ? p : undefined
  }
  const note = () => {
    const p = part()
    return p?.kind === "note" ? p : undefined
  }
  return (
    <Switch>
      <Match when={tools()}>
        {(parts) => <ToolRun id={`${props.message().id}:${seg().key}`} parts={parts()} />}
      </Match>
      <Match when={text()}>
        {(p) =>
          props.mine ? (
            <p class={styles.plain} data-testid="message-text">
              {p().text}
            </p>
          ) : (
            <div data-testid="message-text">
              <Markdown text={p().text} scope={props.message().id} />
            </div>
          )
        }
      </Match>
      <Match when={skill()}>
        {(p) => (
          <span class={styles.chip} data-testid="message-skill">
            /{p().name}
          </span>
        )}
      </Match>
      <Match when={tool()}>{(p) => <ToolCard part={p()} />}</Match>
      <Match when={note()}>
        {(p) => <NoteLine note={p()} workflowId={props.message().workflowId} />}
      </Match>
    </Switch>
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
  /** True for the one message that Edit can change now (spec 003, "Message rows"). */
  readonly editable: boolean
  readonly onReply: (message: WorkflowChatMessage) => void
  readonly onJump: (id: string) => void
  readonly onRetry: () => void
}

export const MessageRow = (props: MessageRowProps) => {
  const app = useApp()
  const { t, locale } = app
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
  // "Show tool steps" off: each series of plain tool steps is one line. The thoughts are one line
  // above the body, so thinking between two steps does not split a series.
  const fold = () => !app.settings.showToolSteps
  const segments = createMemo(() => groupChatParts(m().parts, fold()))
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  let editBox: HTMLTextAreaElement | undefined
  // Edit is off when the chat changes under it (a turn starts, a later step ran).
  createEffect(() => {
    if (!props.editable) setEditing(false)
  })
  const startEdit = () => {
    setDraft(chatText(m()))
    setEditing(true)
    queueMicrotask(() => editBox?.focus())
  }
  const saveEdit = () =>
    call("chat.edit", { id: m().id, text: draft() })
      .then(() => setEditing(false))
      .catch((e: unknown) => {
        const text = describeError(e)
        showToast("error", text.key, text.params)
      })
  const markUnread = () =>
    call("chat.markUnread", { id: m().id }).catch((e: unknown) => {
      const text = describeError(e)
      showToast("error", text.key, text.params)
    })
  const body = (): JSX.Element => (
    <>
      <Show when={thoughts().length > 0}>
        <Thoughts thoughts={thoughts()} />
      </Show>
      <Show
        when={!editing()}
        fallback={
          <div class={styles.editBox} data-testid="message-edit">
            <textarea
              ref={(el) => {
                editBox = el
              }}
              class={styles.editInput}
              rows={3}
              value={draft()}
              aria-label={t("chat.edit.label")}
              data-testid="message-edit-input"
              onInput={(e) => setDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault()
                  setEditing(false)
                } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                  e.preventDefault()
                  void saveEdit()
                }
              }}
            />
            <div class={styles.editButtons}>
              <Button onClick={() => void saveEdit()} data-testid="message-edit-save">
                {t("chat.edit.save")}
              </Button>
              <Button onClick={() => setEditing(false)} data-testid="message-edit-cancel">
                {t("chat.edit.cancel")}
              </Button>
            </div>
          </div>
        }
      >
        <Keyed each={segments()} by={(segment) => segment.key}>
          {(segment) => <SegmentRow message={m} segment={segment} mine={mine()} />}
        </Keyed>
      </Show>
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
        <Show when={props.editable && !editing()}>
          <button
            type="button"
            class={styles.action}
            onClick={startEdit}
            aria-label={t("chat.edit")}
            title={t("chat.edit")}
            data-testid="message-edit-open"
          >
            <Pencil size={14} />
          </button>
        </Show>
        <Show when={isReadableReply(m())}>
          <button
            type="button"
            class={styles.action}
            onClick={() => void markUnread()}
            aria-label={t("chat.markUnread")}
            title={t("chat.markUnread")}
            data-testid="message-mark-unread"
          >
            <Mail size={14} />
          </button>
        </Show>
      </div>
    </article>
  )
}
