import {
  type Agent,
  type ChatMessage,
  catalogues,
  type FilePart,
  type KnowledgeNote,
  type MessageKey,
  type MessagePart,
  messageFiles,
  messageSkill,
  messageText,
  type OutsideSource,
  type SkillPart,
  type ToolAsk,
} from "@robot/shared"
import {
  BookOpen,
  Copy,
  Download,
  ExternalLink,
  Pencil,
  Reply,
  Sparkles,
  User,
  Wrench,
} from "lucide-solid"
import { createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import { Face } from "../agents/Face.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { outsideSourceText } from "../lib/outside.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useDevices } from "../state/devices.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import styles from "./chat.module.css"
import { fileSize, formatTime } from "./format.ts"
import { Markdown } from "./Markdown.tsx"

export interface MessageRowProps {
  agent: Agent
  message: ChatMessage
  /** True when the row starts a header group. */
  first: boolean
  canEdit: boolean
  flash: boolean
  /** Plays the arrival motion. */
  enter: boolean
  quoted: ChatMessage | undefined
  onReply: () => void
  onJumpTo: (messageId: string) => void
  onEdit: (text: string) => Promise<void>
  onRetry: () => void
}

const Thinking = (props: { text: string; live: boolean }) => {
  const { t } = useApp()
  return (
    <details class={styles.thinking} data-testid="thinking">
      <summary>{props.live ? t("chat.thinking") : t("chat.thought")}</summary>
      <p>{props.text}</p>
    </details>
  )
}

const ToolCard = (props: {
  agent: Agent
  part: Extract<MessagePart, { kind: "tool" }>
  /** The name of the other computer when the task runs there (spec 019). */
  from: string | undefined
}) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const devices = useDevices()
  const [answer, setAnswer] = createSignal("")
  const [failure, setFailure] = createSignal<ErrorText>()
  const respond = async (value: string) => {
    setFailure(undefined)
    try {
      await call("tools.respond", { agentId: props.agent.id, callId: props.part.id, answer: value })
    } catch (e) {
      setFailure(describeError(e))
    }
  }
  /** The card of a task on the other computer cannot be answered while that computer is away. */
  const away = () => props.from !== undefined && !devices.sync.pairOnline()
  /** A computer cannot change what an agent may always do on another computer (spec 019). */
  const mayAlways = () => !ui.linked() && props.from === undefined
  return (
    <details class={styles.tool} data-testid="tool-card" open={props.part.state === "waiting"}>
      <summary>
        <Wrench size={14} />
        <span class={styles.toolLabel}>{props.part.label || props.part.name}</span>
        <span class={styles.toolState} data-state={props.part.state}>
          {t(`chat.tool.${props.part.state}` as MessageKey)}
        </span>
        <Show when={props.from}>
          {(from) => (
            <span class={styles.fromDevice} data-testid="tool-origin">
              {t("link.fromDevice", { name: from() })}
            </span>
          )}
        </Show>
        <Show when={props.part.answeredInChat}>
          <span class={styles.fromDevice} data-testid="tool-answered-in-chat">
            {t("chat.tool.answeredInChat")}
          </span>
        </Show>
        <Show when={props.part.decision}>
          {(decision) => (
            <span
              class={styles.fromDevice}
              data-testid="tool-decision"
              data-answer={decision().answer}
            >
              {decision().answer === "allow"
                ? t("chat.decision.allowed", { name: decision().by })
                : t("chat.decision.denied", { name: decision().by })}
            </span>
          )}
        </Show>
      </summary>
      <div class={styles.toolBody}>
        <Show when={props.part.ask}>
          {(ask) => (
            <div class={styles.ask} data-testid="ask-card">
              <Show when={ask().askedAt}>
                {(at) => (
                  <div class={styles.time} data-testid="ask-time">
                    {t("chat.tool.askedAt", { time: formatTime(app.locale(), at()) })}
                  </div>
                )}
              </Show>
              <Show when={away()}>
                <div class={styles.fromDevice} role="status" data-testid="ask-origin-offline">
                  {t("sync.originOffline", { name: props.from ?? "" })}
                </div>
              </Show>
              <Show when={failure()}>
                {(err) => (
                  <div class={styles.fromDevice} role="alert" data-testid="ask-error">
                    {t(err().key, err().params)}
                  </div>
                )}
              </Show>
              <Switch>
                <Match when={ask().kind === "article" ? ask() : undefined}>
                  {(article) => {
                    const a = () => article() as Extract<ToolAsk, { kind: "article" }>
                    return (
                      <div data-testid="ask-article">
                        <div>{t("chat.knowledge.protect", { title: a().title })}</div>
                        <div class={styles.compare}>
                          <section>
                            <div class={styles.time}>{t("chat.knowledge.protect.now")}</div>
                            <pre data-testid="ask-before">{a().before}</pre>
                          </section>
                          <section>
                            <div class={styles.time}>{t("chat.knowledge.protect.new")}</div>
                            <pre data-testid="ask-after">
                              {a().after ?? t("chat.knowledge.protect.deleted")}
                            </pre>
                          </section>
                        </div>
                        <div class={styles.askActions}>
                          <Button
                            variant="primary"
                            disabled={away()}
                            onClick={() => respond("allow")}
                            data-testid="ask-allow"
                          >
                            {t("chat.tool.allow")}
                          </Button>
                          <Button
                            disabled={away()}
                            onClick={() => respond("deny")}
                            data-testid="ask-deny"
                          >
                            {t("chat.tool.deny")}
                          </Button>
                        </div>
                      </div>
                    )
                  }}
                </Match>
                <Match when={ask().kind === "question" ? ask() : undefined}>
                  {(question) => (
                    <>
                      <div>{(question() as { question: string }).question}</div>
                      <div class={styles.askActions}>
                        <For each={(question() as { choices: readonly string[] }).choices}>
                          {(choice) => (
                            <Button
                              disabled={away()}
                              onClick={() => respond(choice)}
                              data-testid="ask-choice"
                            >
                              {choice}
                            </Button>
                          )}
                        </For>
                      </div>
                      <form
                        class={styles.askActions}
                        onSubmit={(e) => {
                          e.preventDefault()
                          if (answer().trim()) respond(answer().trim())
                        }}
                      >
                        <input
                          class={styles.askInput}
                          value={answer()}
                          placeholder={t("chat.tool.answer")}
                          aria-label={t("chat.tool.answer")}
                          onInput={(e) => setAnswer(e.currentTarget.value)}
                          data-testid="ask-input"
                        />
                        <Button
                          type="submit"
                          variant="primary"
                          disabled={away()}
                          data-testid="ask-send"
                        >
                          {t("chat.tool.send")}
                        </Button>
                      </form>
                    </>
                  )}
                </Match>
                <Match when={ask().kind === "approval"}>
                  <div>{t("chat.tool.approval")}</div>
                  {/* A guarded step in a turn that holds outside content (spec 007). */}
                  <Show when={(ask() as { outside?: OutsideSource }).outside}>
                    {(source) => (
                      <div class={styles.outside} role="note" data-testid="ask-outside">
                        <strong>{t("outside.held")}</strong>
                        <span data-testid="ask-outside-source">
                          {t("outside.first", { source: outsideSourceText(t, source()) })}
                        </span>
                        <span class={styles.outsideHint}>{t("outside.hint")}</span>
                      </div>
                    )}
                  </Show>
                  <pre>{(ask() as { summary: string }).summary}</pre>
                  <div class={styles.askActions}>
                    <Button
                      variant="primary"
                      disabled={away()}
                      onClick={() => respond("allow")}
                      data-testid="ask-allow"
                    >
                      {t("chat.tool.allow")}
                    </Button>
                    {/* A client cannot change what an agent may always do (spec 012). */}
                    <Show when={mayAlways() && !(ask() as { once?: boolean }).once}>
                      <Button onClick={() => respond("always")} data-testid="ask-always">
                        {t("chat.tool.always")}
                      </Button>
                    </Show>
                    <Button
                      disabled={away()}
                      onClick={() => respond("deny")}
                      data-testid="ask-deny"
                    >
                      {t("chat.tool.deny")}
                    </Button>
                  </div>
                </Match>
              </Switch>
            </div>
          )}
        </Show>
        <Show when={props.part.input}>
          <div class={styles.time}>{t("chat.tool.input")}</div>
          <pre>{props.part.input}</pre>
        </Show>
        <Show when={props.part.output}>
          <div class={styles.time}>{t("chat.tool.output")}</div>
          <pre>{props.part.output}</pre>
        </Show>
        <Show when={props.part.memoryId}>
          {(id) => (
            <Button onClick={() => call("memory.delete", { id: id() })} data-testid="memory-undo">
              {t("chat.tool.undoMemory")}
            </Button>
          )}
        </Show>
      </div>
    </details>
  )
}

/**
 * The skill chip of a message (spec 017). A click shows the instructions as they were sent, read
 * only. A later edit of the skill does not change them.
 */
const SkillChip = (props: { skill: SkillPart }) => {
  const { t } = useApp()
  const [open, setOpen] = createSignal(false)
  return (
    <div class={styles.skillSent}>
      <button
        type="button"
        class={styles.skillChip}
        aria-expanded={open()}
        title={t("skills.chip.show")}
        onClick={() => setOpen(!open())}
        data-testid="message-skill"
      >
        <Sparkles size={12} />
        <span>{props.skill.name}</span>
      </button>
      <Show when={open()}>
        <pre class={styles.skillSentText} data-testid="message-skill-text">
          {props.skill.instructions}
        </pre>
      </Show>
    </div>
  )
}

const FileChip = (props: { message: ChatMessage; file: FilePart; from: string | undefined }) => {
  const { t } = useApp()
  const ui = useUi()
  const [savedFile, setSavedFile] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<ErrorText>()
  const ask = () => ({
    agentId: props.message.agentId,
    path: props.file.path,
    size: props.file.size,
    messageId: props.message.id,
  })
  // A file of a message from the other computer may not be on this computer (spec 019).
  const [here, { refetch }] = createResource(
    () => props.from !== undefined && !ui.linked(),
    (remote) => (remote ? call("sync.file.here", ask()).catch(() => true) : true),
    { initialValue: true },
  )
  const open = async () => {
    setFailure(undefined)
    setBusy(true)
    try {
      await call("sync.file.open", ask())
      await refetch()
    } catch (e) {
      setFailure(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <li class={styles.chip} title={props.file.path} data-testid="message-file">
      <span class={styles.chipName}>{props.file.name}</span>
      <span class={styles.chipSize}>{fileSize(props.file.size)}</span>
      <Show when={!here()}>
        <span class={styles.chipSize} data-testid="message-file-missing">
          {t("sync.file.notHere")}
        </span>
      </Show>
      <Show when={busy()}>
        <span class={styles.chipSize} data-testid="message-file-copying">
          {t("sync.file.copying")}
        </span>
      </Show>
      <Show when={failure()}>
        {(err) => (
          <span class={styles.chipSize} role="alert" data-testid="message-file-error">
            {t(err().key, err().params)}
          </span>
        )}
      </Show>
      <Show when={!ui.linked()}>
        <IconButton
          label={t("sync.file.open", { name: props.file.name })}
          disabled={busy()}
          onClick={open}
          data-testid="message-file-open"
        >
          <ExternalLink size={12} />
        </IconButton>
      </Show>
      <Show when={ui.linked()}>
        <IconButton
          label={t("link.file.download", { name: props.file.name })}
          disabled={ui.serverOffline()}
          onClick={async () => {
            const result = await call("attachments.save", {
              agentId: props.message.agentId,
              path: props.file.path,
              name: props.file.name,
            }).catch(() => undefined)
            if (result?.saved) setSavedFile(props.file.path)
          }}
          data-testid="message-file-download"
        >
          <Download size={12} />
        </IconButton>
        <Show when={savedFile() === props.file.path}>
          <span class={styles.chipSize} data-testid="message-file-saved">
            {t("link.file.saved")}
          </span>
        </Show>
      </Show>
    </li>
  )
}

type ToolPart = Extract<MessagePart, { kind: "tool" }>

const FAILED_KEY: Record<string, MessageKey> = {
  read_article: "chat.knowledge.failed.read",
  write_article: "chat.knowledge.failed.write",
  delete_article: "chat.knowledge.failed.delete",
  add_source: "chat.knowledge.failed.source",
}

/**
 * What a knowledge tool did: a compact card for a read, a muted line with undo for a change.
 * Knowledge stays on the computer that runs the agent (012, 019): a client, and a message that
 * came from the other computer of a sync pair, show the line without undo.
 */
const KnowledgeLine = (props: {
  agent: Agent
  part: ToolPart
  note: KnowledgeNote
  from: string | undefined
}) => {
  const { t } = useApp()
  const ui = useUi()
  const here = () => !ui.linked() && props.from === undefined
  const [tick, setTick] = createSignal(0)
  const [error, setError] = createSignal<ErrorText>()
  onCleanup(
    window.robot.on("knowledge.changed", (e) => {
      if (e.agentId === props.agent.id) setTick((n) => n + 1)
    }),
  )
  const changeId = () => (props.note.kind === "write" ? props.note.changeId : undefined)
  // The change list keeps 50 changes. An older change has no undo.
  const [change] = createResource(
    () => {
      const id = changeId()
      return id && here() ? { id, tick: tick() } : undefined
    },
    ({ id }) =>
      call("knowledge.change", { agentId: props.agent.id, changeId: id }).catch(() => undefined),
  )
  const undo = async () => {
    const id = changeId()
    if (!id) return
    setError(undefined)
    try {
      await call("knowledge.undo", { agentId: props.agent.id, changeId: id })
    } catch (e) {
      setError(describeError(e))
    }
  }
  const reason = (code: string) => {
    const key = `error.${code}` as MessageKey
    return key in catalogues.en ? t(key) : t("error.unknown")
  }
  return (
    <Switch>
      <Match when={props.note.kind === "read" ? props.note : undefined}>
        {(note) => (
          <div class={styles.knowledgeRead} data-testid="knowledge-read-card">
            <BookOpen size={14} />
            <span>{t("chat.knowledge.read", { title: (note() as { title: string }).title })}</span>
          </div>
        )}
      </Match>
      <Match when={props.note.kind === "write" ? props.note : undefined}>
        {(note) => (
          <div class={styles.knowledgeLine} data-testid="knowledge-line">
            <span>
              {t(
                (note() as { change: string }).change === "delete"
                  ? "chat.knowledge.deleted"
                  : "chat.knowledge.updated",
                { title: (note() as { title: string }).title },
              )}
            </span>
            <Show when={change()}>
              {(c) => (
                <Show
                  when={!c().undone}
                  fallback={
                    <span data-testid="knowledge-undone">{t("chat.knowledge.undone")}</span>
                  }
                >
                  <Button onClick={undo} data-testid="knowledge-undo">
                    {t("chat.knowledge.undo")}
                  </Button>
                </Show>
              )}
            </Show>
            <Show when={error()}>
              {(err) => (
                <span class={styles.knowledgeError} role="alert">
                  {t(err().key, err().params)}
                </span>
              )}
            </Show>
          </div>
        )}
      </Match>
      <Match when={props.note.kind === "source" ? props.note : undefined}>
        {(note) => (
          <div class={styles.knowledgeLine} data-testid="knowledge-source-line">
            <span>{t("chat.knowledge.source", { name: (note() as { name: string }).name })}</span>
          </div>
        )}
      </Match>
      <Match when={props.note.kind === "failed" ? props.note : undefined}>
        {(note) => (
          <div class={styles.knowledgeFailed} role="alert" data-testid="knowledge-failed">
            <span>
              {t(FAILED_KEY[props.part.name] ?? "chat.knowledge.failed.write", {
                title: (note() as { title: string }).title,
              })}
            </span>
            <span>{reason((note() as { code: string }).code)}</span>
          </div>
        )}
      </Match>
    </Switch>
  )
}

/** A tool step: a knowledge line when the tool is done, otherwise the plain card. */
const ToolStep = (props: { agent: Agent; part: ToolPart; from: string | undefined }) => {
  const note = () =>
    props.part.state === "done" || props.part.state === "failed" ? props.part.knowledge : undefined
  return (
    <Show
      when={note()}
      fallback={<ToolCard agent={props.agent} part={props.part} from={props.from} />}
    >
      {(n) => <KnowledgeLine agent={props.agent} part={props.part} note={n()} from={props.from} />}
    </Show>
  )
}

/** "Read at the next step" under a message that joined the turn, with Delete while it may go. */
const UnreadLine = (props: { message: ChatMessage; unread: "waiting" | "handed" }) => {
  const { t } = useApp()
  const [failure, setFailure] = createSignal<ErrorText>()
  const remove = async () => {
    setFailure(undefined)
    try {
      await call("chat.unread.delete", {
        agentId: props.message.agentId,
        messageId: props.message.id,
      })
    } catch (e) {
      setFailure(describeError(e))
    }
  }
  return (
    <div class={styles.unread} data-testid="unread-line">
      <span>{t("chat.unread")}</span>
      <Show when={props.unread === "waiting"}>
        <button
          type="button"
          class={styles.unreadDelete}
          onClick={remove}
          data-testid="unread-delete"
        >
          {t("chat.unread.delete")}
        </button>
      </Show>
      <Show when={failure()}>
        {(err) => <span role="alert">{t(err().key, err().params)}</span>}
      </Show>
    </div>
  )
}

const FailedRow = (props: { message: ChatMessage; onRetry: () => void }) => {
  const app = useApp()
  const { t } = app
  const reason = () => {
    const error = props.message.error
    if (!error) return t("error.unknown")
    const key = `error.${error.code}`
    return key in catalogues.en
      ? t(key as MessageKey, { detail: error.detail })
      : t("error.unknown")
  }
  return (
    <div class={styles.failed} role="alert" data-testid="failed-row">
      <span class={styles.failedText}>
        {reason()}
        <Show when={props.message.error?.resetsAt}>
          {(at) => <> {t("chat.limitResets", { time: formatTime(app.locale(), at()) })}</>}
        </Show>
      </span>
      <Button onClick={props.onRetry} data-testid="retry">
        {t("chat.retry")}
      </Button>
      {/* How far the turn went (spec 005). It sits beside Retry. */}
      <Show when={props.message.progress}>
        {(progress) => (
          <p class={styles.failedLine} data-testid="progress-line" data-progress={progress()}>
            {t(`progress.line.${progress()}` as MessageKey)}
          </p>
        )}
      </Show>
    </div>
  )
}

export const MessageRow = (props: MessageRowProps) => {
  const app = useApp()
  const { t } = app
  const devices = useDevices()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  /** A message from another linked device shows its name. This device does not name itself. */
  const fromOther = () => {
    const from = props.message.fromDevice
    return from && from !== devices.state()?.self.name ? from : undefined
  }
  const isAgent = () => props.message.author === "agent"
  const name = () => (isAgent() ? props.agent.name : t("chat.you"))
  const time = () => formatTime(app.locale(), props.message.createdAt)

  const startEdit = () => {
    setDraft(messageText(props.message))
    setEditing(true)
  }
  const saveEdit = async () => {
    const text = draft().trim()
    if (!text) return
    await props.onEdit(text)
    setEditing(false)
  }

  return (
    <article
      class={styles.row}
      data-first={props.first}
      data-flash={props.flash}
      data-enter={props.enter}
      data-message-id={props.message.id}
      data-author={props.message.author}
      data-status={props.message.status}
      data-testid="message"
      aria-label={`${name()}, ${time()}`}
    >
      <Show when={props.first} fallback={<span class={styles.gutterTime}>{time()}</span>}>
        <Show
          when={isAgent()}
          fallback={
            <span class={styles.avatar}>
              <User size={20} />
            </span>
          }
        >
          <Face face={props.agent.face} image={props.agent.faceImage} size={40} />
        </Show>
      </Show>
      <div class={styles.content}>
        <Show when={props.quoted}>
          {(quoted) => (
            <button
              type="button"
              class={styles.replyLink}
              onClick={() => props.onJumpTo(quoted().id)}
              data-testid="reply-link"
            >
              <Reply size={12} />
              {t("chat.repliesTo", {
                name: quoted().author === "agent" ? props.agent.name : t("chat.you"),
                excerpt: messageText(quoted()).slice(0, 80),
              })}
            </button>
          )}
        </Show>
        <Show when={props.first}>
          <div class={styles.head}>
            <span class={styles.name}>{name()}</span>
            <Show when={isAgent()}>
              <span class={styles.bot}>{t("chat.bot")}</span>
            </Show>
            <span class={styles.time}>{time()}</span>
          </div>
        </Show>
        <Show
          when={!editing()}
          fallback={
            <div class={styles.box}>
              <textarea
                class={styles.input}
                value={draft()}
                rows={2}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                    e.preventDefault()
                    void saveEdit()
                  } else if (e.key === "Escape") setEditing(false)
                }}
                data-testid="edit-input"
              />
              <Button onClick={() => setEditing(false)}>{t("chat.cancel")}</Button>
              <Button variant="primary" onClick={saveEdit} data-testid="edit-save">
                {t("chat.save")}
              </Button>
            </div>
          }
        >
          <Show
            when={isAgent()}
            fallback={
              <>
                <Show when={messageSkill(props.message)}>
                  {(skill) => <SkillChip skill={skill()} />}
                </Show>
                <Show when={messageText(props.message)}>
                  <p class={styles.userText}>{messageText(props.message)}</p>
                </Show>
                <Show when={fromOther()}>
                  {(from) => (
                    <p class={styles.fromDevice} data-testid="from-device">
                      {t("link.fromDevice", { name: from() })}
                    </p>
                  )}
                </Show>
                <Show when={messageFiles(props.message).length > 0}>
                  <ul class={styles.chips} data-testid="message-files">
                    <For each={messageFiles(props.message)}>
                      {(file) => (
                        <FileChip message={props.message} file={file} from={fromOther()} />
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={props.message.unread}>
                  {(unread) => <UnreadLine message={props.message} unread={unread()} />}
                </Show>
              </>
            }
          >
            <For each={props.message.parts}>
              {(part, index) => (
                <Switch>
                  <Match when={part.kind === "text"}>
                    <Markdown text={(part as Extract<MessagePart, { kind: "text" }>).text} />
                  </Match>
                  <Match when={part.kind === "thinking"}>
                    <Thinking
                      text={(part as Extract<MessagePart, { kind: "thinking" }>).text}
                      live={
                        props.message.status === "streaming" &&
                        index() === props.message.parts.length - 1
                      }
                    />
                  </Match>
                  <Match when={part.kind === "tool"}>
                    <ToolStep
                      agent={props.agent}
                      part={part as Extract<MessagePart, { kind: "tool" }>}
                      from={fromOther()}
                    />
                  </Match>
                </Switch>
              )}
            </For>
          </Show>
          <Show when={props.message.editedAt}>
            <span class={styles.edited}> {t("chat.edited")}</span>
          </Show>
          <Show when={props.message.status === "stopped"}>
            <span class={styles.stopped} data-testid="stopped-mark">
              {t("chat.stopped")}
            </span>
          </Show>
          <Show when={props.message.status === "failed"}>
            <FailedRow message={props.message} onRetry={props.onRetry} />
          </Show>
        </Show>
      </div>
      <Show when={!editing() && props.message.status !== "streaming"}>
        <div class={styles.actions}>
          <IconButton label={t("chat.reply")} onClick={props.onReply} data-testid="action-reply">
            <Reply size={16} />
          </IconButton>
          <IconButton
            label={t("chat.copy")}
            onClick={() => call("app.copy", { text: messageText(props.message) })}
            data-testid="action-copy"
          >
            <Copy size={16} />
          </IconButton>
          <Show when={props.canEdit}>
            <IconButton label={t("chat.edit")} onClick={startEdit} data-testid="action-edit">
              <Pencil size={16} />
            </IconButton>
          </Show>
        </div>
      </Show>
    </article>
  )
}
