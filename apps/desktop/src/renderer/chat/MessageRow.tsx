import {
  type Agent,
  type ChatMessage,
  catalogues,
  type MessageKey,
  type MessagePart,
  messageFiles,
  messageText,
} from "@robot/shared"
import { Copy, Download, Pencil, Reply, User, Wrench } from "lucide-solid"
import { createSignal, For, Match, Show, Switch } from "solid-js"
import { Face } from "../agents/Face.tsx"
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

const ToolCard = (props: { agent: Agent; part: Extract<MessagePart, { kind: "tool" }> }) => {
  const { t } = useApp()
  const [answer, setAnswer] = createSignal("")
  const respond = (value: string) =>
    call("tools.respond", { agentId: props.agent.id, callId: props.part.id, answer: value })
  return (
    <details class={styles.tool} data-testid="tool-card" open={props.part.state === "waiting"}>
      <summary>
        <Wrench size={14} />
        <span class={styles.toolLabel}>{props.part.label || props.part.name}</span>
        <span class={styles.toolState} data-state={props.part.state}>
          {t(`chat.tool.${props.part.state}` as MessageKey)}
        </span>
      </summary>
      <div class={styles.toolBody}>
        <Show when={props.part.ask}>
          {(ask) => (
            <div class={styles.ask} data-testid="ask-card">
              <Show
                when={ask().kind === "question" ? ask() : undefined}
                fallback={
                  <>
                    <div>{t("chat.tool.approval")}</div>
                    <pre>{(ask() as { summary: string }).summary}</pre>
                    <div class={styles.askActions}>
                      <Button
                        variant="primary"
                        onClick={() => respond("allow")}
                        data-testid="ask-allow"
                      >
                        {t("chat.tool.allow")}
                      </Button>
                      <Button onClick={() => respond("always")} data-testid="ask-always">
                        {t("chat.tool.always")}
                      </Button>
                      <Button onClick={() => respond("deny")} data-testid="ask-deny">
                        {t("chat.tool.deny")}
                      </Button>
                    </div>
                  </>
                }
              >
                {(question) => (
                  <>
                    <div>{(question() as { question: string }).question}</div>
                    <div class={styles.askActions}>
                      <For each={(question() as { choices: readonly string[] }).choices}>
                        {(choice) => (
                          <Button onClick={() => respond(choice)} data-testid="ask-choice">
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
                      <Button type="submit" variant="primary" data-testid="ask-send">
                        {t("chat.tool.send")}
                      </Button>
                    </form>
                  </>
                )}
              </Show>
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

export const MessageRow = (props: MessageRowProps) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const devices = useDevices()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  const [savedFile, setSavedFile] = createSignal<string>()
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
                <Show when={messageText(props.message)}>
                  <p class={styles.userText}>{messageText(props.message)}</p>
                </Show>
                <Show when={fromOther()}>
                  {(from) => (
                    <p class={styles.fromDevice} data-testid="from-device">
                      {t("link.from", { name: from() })}
                    </p>
                  )}
                </Show>
                <Show when={messageFiles(props.message).length > 0}>
                  <ul class={styles.chips} data-testid="message-files">
                    <For each={messageFiles(props.message)}>
                      {(file) => (
                        <li class={styles.chip} title={file.path} data-testid="message-file">
                          <span class={styles.chipName}>{file.name}</span>
                          <span class={styles.chipSize}>{fileSize(file.size)}</span>
                          <Show when={ui.linked()}>
                            <IconButton
                              label={t("link.file.download", { name: file.name })}
                              disabled={ui.serverOffline()}
                              onClick={async () => {
                                const result = await call("attachments.save", {
                                  agentId: props.message.agentId,
                                  path: file.path,
                                  name: file.name,
                                }).catch(() => undefined)
                                if (result?.saved) setSavedFile(file.path)
                              }}
                              data-testid="message-file-download"
                            >
                              <Download size={12} />
                            </IconButton>
                            <Show when={savedFile() === file.path}>
                              <span class={styles.chipSize} data-testid="message-file-saved">
                                {t("link.file.saved")}
                              </span>
                            </Show>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
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
                    <ToolCard
                      agent={props.agent}
                      part={part as Extract<MessagePart, { kind: "tool" }>}
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
