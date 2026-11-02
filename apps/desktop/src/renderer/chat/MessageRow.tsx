import {
  type Agent,
  type ChatMessage,
  catalogues,
  type FilePart,
  isNoteOnly,
  type KnowledgeNote,
  type MemoryNote,
  type MemoryUndo,
  type MessageKey,
  type MessagePart,
  messageFiles,
  messageSkill,
  messageText,
  type OutsideSource,
  type SecretAsk,
  type SecretAuth,
  type SettingChange,
  type SettingsNote,
  type SettingValue,
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
import { openMemory } from "../state/memoryLink.ts"
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

/** How a secret is sent, in words. */
const authText = (t: ReturnType<typeof useApp>["t"], auth: SecretAuth) =>
  auth.kind === "bearer"
    ? t("secret.auth.bearer")
    : auth.kind === "header"
      ? t("secret.auth.header", { header: auth.header })
      : t("secret.auth.basic", { user: auth.user })

/**
 * The protected card of spec 020: the reason, the origin in large text, the way to send, a hidden
 * field, Save and Cancel. The field is cleared when the save starts. On a linked device, or when
 * the agent runs on the other computer, the card says where to answer and has no field.
 */
const SecretCard = (props: {
  agent: Agent
  callId: string
  ask: SecretAsk
  /** The name of the computer that runs the agent, when it is not this one. */
  elsewhere: string | undefined
}) => {
  const { t } = useApp()
  const [failure, setFailure] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  let field: HTMLInputElement | undefined
  const answer = async (value: string | null) => {
    setFailure(undefined)
    setBusy(true)
    try {
      await call("secrets.answer", { agentId: props.agent.id, callId: props.callId, value })
    } catch (e) {
      setFailure(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    const value = field?.value ?? ""
    // The value leaves the field before the save starts (spec 020).
    if (field) field.value = ""
    if (!value) return
    void answer(value)
  }
  return (
    <div class={styles.secretCard} data-testid="secret-card">
      <strong>
        {props.ask.label
          ? t("secret.card.title", { label: props.ask.label })
          : t("secret.card.titlePlain")}
      </strong>
      <Show when={props.ask.reason}>
        <div data-testid="secret-reason">
          {t("secret.card.reason", { reason: props.ask.reason })}
        </div>
      </Show>
      <div class={styles.time}>{t("secret.card.origin")}</div>
      <div class={styles.secretOrigin} data-testid="secret-origin">
        {props.ask.origin}
      </div>
      <div class={styles.time} data-testid="secret-name">
        {t("secret.card.name", { name: props.ask.name })} · {authText(t, props.ask.auth)}
      </div>
      <Show when={props.ask.replace}>
        <div data-testid="secret-replace">{t("secret.card.replace", { name: props.ask.name })}</div>
      </Show>
      <Show
        when={props.elsewhere === undefined}
        fallback={
          <div class={styles.fromDevice} role="status" data-testid="secret-elsewhere">
            {t("secret.card.elsewhere", { name: props.elsewhere ?? "" })}
          </div>
        }
      >
        <Show when={failure()}>
          {(err) => (
            <div class={styles.fromDevice} role="alert" data-testid="secret-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <form
          class={styles.askActions}
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <input
            ref={field}
            class={styles.askInput}
            type="password"
            autocomplete="off"
            spellcheck={false}
            maxLength={16384}
            placeholder={t("secret.card.field")}
            aria-label={t("secret.card.field")}
            data-testid="secret-input"
          />
          <Button type="submit" variant="primary" disabled={busy()} data-testid="secret-save">
            {t("secret.card.save")}
          </Button>
          <Button
            disabled={busy()}
            onClick={() => {
              if (field) field.value = ""
              void answer(null)
            }}
            data-testid="secret-cancel"
          >
            {t("secret.card.cancel")}
          </Button>
        </form>
        <div class={styles.time}>{t("secret.card.hint")}</div>
      </Show>
    </div>
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
        <span class={styles.toolLabel}>
          {props.part.name === "search_chats"
            ? t("chat.tool.searchChats")
            : props.part.label || props.part.name}
        </span>
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
        <Show when={props.part.secret}>
          {(result) => (
            <span class={styles.fromDevice} data-testid="secret-result" data-result={result()}>
              {result() === "saved" ? t("secret.card.saved") : t("secret.card.cancelled")}
            </span>
          )}
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
                <Match when={ask().kind === "secret" ? (ask() as SecretAsk) : undefined}>
                  {(secret) => (
                    <SecretCard
                      agent={props.agent}
                      callId={props.part.id}
                      ask={secret()}
                      elsewhere={
                        props.from ?? (ui.linked() ? (ui.server()?.name ?? "") : undefined)
                      }
                    />
                  )}
                </Match>
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

/** True for an Undo that is off because a newer change exists. */
const newer = (undo: MemoryUndo) => !undo.on && undo.why === "newer"

/**
 * What the memory tool did: a muted line. A saved item has an undo control that does what Undo
 * does in the history. A suggestion has a link to the tab Proposals. Both work on the computer
 * where the change was made. A linked device and the other computer of a sync pair show plain
 * text (012, 019).
 */
const MemoryLine = (props: { agent: Agent; note: MemoryNote; from: string | undefined }) => {
  const { t } = useApp()
  const ui = useUi()
  const here = () => !ui.linked() && props.from === undefined
  const [tick, setTick] = createSignal(0)
  const [error, setError] = createSignal<ErrorText>()
  onCleanup(
    window.robot.on("memory.changed", (e) => {
      if (e.agentId === props.agent.id) setTick((n) => n + 1)
    }),
  )
  // The history keeps 90 days. A change that left it has no undo.
  const [row] = createResource(
    () => {
      const note = props.note
      return note.kind === "saved" && here() ? { id: note.historyId, tick: tick() } : undefined
    },
    ({ id }) => call("memory.history.get", { id }).catch(() => undefined),
  )
  const undo = async () => {
    const note = props.note
    if (note.kind !== "saved") return
    setError(undefined)
    try {
      await call("memory.undo", { id: note.historyId })
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <div
      class={styles.knowledgeLine}
      data-testid={props.note.kind === "saved" ? "memory-saved-line" : "memory-suggested-line"}
    >
      <span>{t(props.note.kind === "saved" ? "chat.memory.saved" : "chat.memory.suggested")}</span>
      <Show when={props.note.kind === "suggested" && here()}>
        <Button onClick={() => openMemory(props.agent.id, "proposals")} data-testid="memory-open">
          {t("chat.memory.open")}
        </Button>
      </Show>
      <Show when={row()}>
        {(r) => (
          <Show
            when={!r().undone}
            fallback={<span data-testid="memory-undone">{t("chat.memory.undone")}</span>}
          >
            <Show
              when={r().undo.on}
              fallback={
                <Show when={newer(r().undo)}>
                  <span data-testid="memory-undo-off">{t("memory.history.newer")}</span>
                </Show>
              }
            >
              <Button onClick={undo} data-testid="memory-undo">
                {t("chat.memory.undo")}
              </Button>
            </Show>
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
  )
}

type Translate = ReturnType<typeof useApp>["t"]

/** The text of one change from the chat, for its muted line (spec 002). */
const changeText = (t: Translate, change: SettingChange): string => {
  const plain = (v: SettingValue) => (typeof v === "string" && v ? v : t("chat.settings.none"))
  const pair = (key: MessageKey, show: (v: SettingValue) => string) =>
    t(key, { before: show(change.before), after: show(change.after) })
  const option = (prefix: string) => (v: SettingValue) => {
    const key = `${prefix}.${String(v)}` as MessageKey
    return key in catalogues.en ? t(key) : String(v)
  }
  switch (change.field) {
    case "name":
      return pair("chat.settings.name", plain)
    case "role":
      return pair("chat.settings.role", plain)
    case "instructions":
      return t("chat.settings.instructions")
    case "face":
      return t("chat.settings.face")
    case "model": {
      const model = (v: SettingValue) =>
        v && typeof v === "object" && "model" in v ? v : undefined
      const before = model(change.before)
      const after = model(change.after)
      // Only the effort changed: the line names the effort.
      if (before && after && before.model === after.model && before.accountId === after.accountId)
        return pair(
          "chat.settings.effort",
          (v) => model(v)?.effort ?? t("chat.settings.effortDefault"),
        )
      return pair("chat.settings.model", (v) => model(v)?.model ?? t("chat.settings.none"))
    }
    case "language":
      return pair("chat.settings.language", option("settings.language"))
    case "theme":
      return pair("chat.settings.theme", option("settings.theme"))
    case "textSize":
      return pair("chat.settings.textSize", option("settings.textSize"))
    case "compactPlaces":
      return t(change.after ? "chat.settings.compactPlaces.on" : "chat.settings.compactPlaces.off")
    case "reduceMotion":
      return pair("chat.settings.reduceMotion", option("settings.reduceMotion"))
  }
}

/**
 * What a call of the settings tool changed: a muted line with Undo (spec 002). Undo is off when a
 * field changed again since, with the reason. A client of a linked server shows no Undo.
 */
const SettingsLine = (props: {
  agent: Agent
  message: ChatMessage
  part: ToolPart
  note: SettingsNote
}) => {
  const { t } = useApp()
  const ui = useUi()
  const [tick, setTick] = createSignal(0)
  const [error, setError] = createSignal<ErrorText>()
  const bump = () => setTick((n) => n + 1)
  onCleanup(window.robot.on("agents.changed", bump))
  onCleanup(window.robot.on("settings.changed", bump))
  const [state] = createResource(
    () =>
      ui.linked()
        ? undefined
        : { tick: tick(), undone: props.note.undone === true, status: props.message.status },
    () =>
      call("agents.settings.line", {
        agentId: props.agent.id,
        messageId: props.message.id,
        callId: props.part.id,
      }).catch(() => undefined),
  )
  const undo = async () => {
    setError(undefined)
    try {
      await call("agents.settings.undo", {
        agentId: props.agent.id,
        messageId: props.message.id,
        callId: props.part.id,
      })
      bump()
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <div class={styles.knowledgeLine} data-testid="settings-line" data-state={state() ?? ""}>
      <For each={props.note.changes}>
        {(change) => <span data-testid="settings-change">{changeText(t, change)}</span>}
      </For>
      <Show when={state()}>
        {(s) => (
          <Switch>
            <Match when={s() === "undone"}>
              <span data-testid="settings-undone">{t("chat.settings.undone")}</span>
            </Match>
            <Match when={s() === "changed"}>
              <Button disabled data-testid="settings-undo">
                {t("chat.settings.undo")}
              </Button>
              <span data-testid="settings-changed-again">{t("chat.settings.changedAgain")}</span>
            </Match>
            <Match when={s() === "ready"}>
              <Button
                onClick={undo}
                disabled={props.message.status === "streaming"}
                data-testid="settings-undo"
              >
                {t("chat.settings.undo")}
              </Button>
            </Match>
          </Switch>
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
  )
}

/**
 * A tool step: a knowledge, memory or settings line when the tool is done, otherwise the plain
 * card.
 */
const ToolStep = (props: {
  agent: Agent
  message: ChatMessage
  part: ToolPart
  from: string | undefined
}) => {
  const finished = () => props.part.state === "done" || props.part.state === "failed"
  const note = () => (finished() ? props.part.knowledge : undefined)
  const memory = () => (props.part.state === "done" ? props.part.memory : undefined)
  const settings = () => (props.part.state === "done" ? props.part.settings : undefined)
  return (
    <Show
      when={settings()}
      fallback={
        <Show
          when={note()}
          fallback={
            <Show
              when={memory()}
              fallback={<ToolCard agent={props.agent} part={props.part} from={props.from} />}
            >
              {(m) => <MemoryLine agent={props.agent} note={m()} from={props.from} />}
            </Show>
          }
        >
          {(n) => (
            <KnowledgeLine agent={props.agent} part={props.part} note={n()} from={props.from} />
          )}
        </Show>
      }
    >
      {(n) => (
        <SettingsLine agent={props.agent} message={props.message} part={props.part} note={n()} />
      )}
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
    </div>
  )
}

/**
 * One muted line with no task: the watch of a routine checked and saw no change (spec 009,
 * "Post when nothing changed").
 */
const NoteLine = (props: { message: ChatMessage }) => {
  const app = useApp()
  const { t } = app
  const note = () =>
    props.message.parts.find((p): p is Extract<MessagePart, { kind: "note" }> => p.kind === "note")
  return (
    <div class={styles.noteLine} data-testid="note-line">
      <span>{t("routines.note.unchanged", { name: note()?.routine ?? "" })}</span>
      <span>{formatTime(app.locale(), props.message.createdAt)}</span>
    </div>
  )
}

export const MessageRow = (props: MessageRowProps) => (
  <Show when={!isNoteOnly(props.message.parts)} fallback={<NoteLine message={props.message} />}>
    <FullMessageRow {...props} />
  </Show>
)

const FullMessageRow = (props: MessageRowProps) => {
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
                      message={props.message}
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
