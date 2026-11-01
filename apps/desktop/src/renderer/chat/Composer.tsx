import {
  type Agent,
  ATTACH_MAX,
  type ChatMessage,
  messageText,
  type QueuedMessage,
} from "@robot/shared"
import { Paperclip, Pencil, SendHorizontal, Square, X } from "lucide-solid"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import styles from "./chat.module.css"

export interface ComposerProps {
  agent: Agent
  working: boolean
  queue: readonly QueuedMessage[]
  replyTo: ChatMessage | undefined
  onCancelReply: () => void
  onSent: () => void
  onConnect: () => void
  onChooseModel: () => void
}

const QueueItem = (props: { agentId: string; item: QueuedMessage }) => {
  const { t } = useApp()
  const [editing, setEditing] = createSignal(false)
  const [text, setText] = createSignal(props.item.text)
  const save = async () => {
    if (text().trim())
      await call("chat.queue.update", {
        agentId: props.agentId,
        itemId: props.item.id,
        text: text().trim(),
      })
    setEditing(false)
  }
  return (
    <div class={styles.queueItem} data-testid="queued">
      <span class={styles.queueLabel}>{t("chat.queued")}</span>
      <Show when={editing()} fallback={<span class={styles.queueText}>{props.item.text}</span>}>
        <input
          class={styles.input}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.isComposing) void save()
            if (e.key === "Escape") setEditing(false)
          }}
          data-testid="queued-input"
          autofocus
        />
      </Show>
      <Show when={props.item.files.length > 0}>
        <span class={styles.queueLabel}>
          {t("chat.queue.files", { count: props.item.files.length })}
        </span>
      </Show>
      <IconButton
        label={t("chat.queue.edit")}
        onClick={() => (editing() ? save() : setEditing(true))}
        data-testid="queued-edit"
      >
        <Pencil size={14} />
      </IconButton>
      <IconButton
        label={t("chat.queue.remove")}
        onClick={() => call("chat.queue.remove", { agentId: props.agentId, itemId: props.item.id })}
        data-testid="queued-remove"
      >
        <X size={14} />
      </IconButton>
    </div>
  )
}

export const Composer = (props: ComposerProps) => {
  const { t } = useApp()
  const [text, setText] = createSignal("")
  const [error, setError] = createSignal<ErrorText>()
  const [files, setFiles] = createSignal<string[]>([])
  let input: HTMLTextAreaElement | undefined
  let dropZone: HTMLDivElement | undefined
  // Files dropped on the message box are attached. The box is no control, so the listeners
  // are added here and the box gets no interactive role.
  onMount(() => {
    const over = (e: DragEvent) => e.preventDefault()
    const drop = (e: DragEvent) => {
      e.preventDefault()
      addFiles([...(e.dataTransfer?.files ?? [])].map((f) => window.robot.pathForFile(f)))
    }
    dropZone?.addEventListener("dragover", over)
    dropZone?.addEventListener("drop", drop)
    onCleanup(() => {
      dropZone?.removeEventListener("dragover", over)
      dropZone?.removeEventListener("drop", drop)
    })
  })

  const resize = () => {
    if (!input) return
    input.style.height = "auto"
    input.style.height = `${input.scrollHeight}px`
  }

  const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path
  const addFiles = (paths: readonly string[]) => {
    const merged = [...new Set([...files(), ...paths.filter(Boolean)])]
    if (merged.length > ATTACH_MAX) setError({ key: "error.too_many_files" })
    setFiles(merged.slice(0, ATTACH_MAX))
  }
  const pick = async () => {
    try {
      addFiles(await call("files.pick"))
    } catch (e) {
      setError(describeError(e))
    }
  }

  const send = async () => {
    const value = text().trim()
    if (!value && files().length === 0) return
    setError(undefined)
    try {
      await call("chat.send", {
        agentId: props.agent.id,
        text: value,
        replyTo: props.replyTo?.id ?? null,
        files: [...files()],
      })
      setText("")
      setFiles([])
      queueMicrotask(resize)
      props.onCancelReply()
      props.onSent()
    } catch (e) {
      setError(describeError(e))
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // While an input method composes text (for example Korean), Enter ends the composition.
    if (event.isComposing || event.keyCode === 229) return
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void send()
    } else if (event.key === "Escape" && props.replyTo) {
      props.onCancelReply()
    }
  }

  const blocked = () => props.agent.state === "offline"

  return (
    <div class={styles.composer}>
      <Show when={props.queue.length > 0}>
        <div class={styles.queue}>
          <For each={props.queue}>
            {(item) => <QueueItem agentId={props.agent.id} item={item} />}
          </For>
        </div>
      </Show>
      <Show
        when={!blocked()}
        fallback={
          <div class={styles.blocked} data-testid="composer-blocked">
            <span>{props.agent.model ? t("chat.notConnected") : t("chat.noModel")}</span>
            <Show
              when={props.agent.model}
              fallback={
                <Button
                  variant="primary"
                  onClick={props.onChooseModel}
                  data-testid="composer-choose-model"
                >
                  {t("chat.chooseModel")}
                </Button>
              }
            >
              <Button variant="primary" onClick={props.onConnect} data-testid="composer-connect">
                {t("chat.connect")}
              </Button>
            </Show>
          </div>
        }
      >
        <Show when={props.replyTo}>
          {(quoted) => (
            <div class={styles.quote} data-testid="reply-quote">
              <span class={styles.quoteText}>
                {t("chat.replyingTo", {
                  name: quoted().author === "agent" ? props.agent.name : t("chat.you"),
                })}
                {": "}
                {messageText(quoted()).slice(0, 80)}
              </span>
              <IconButton label={t("chat.cancelReply")} onClick={props.onCancelReply}>
                <X size={14} />
              </IconButton>
            </div>
          )}
        </Show>
        <Show when={files().length > 0}>
          <ul class={styles.chips} aria-label={t("chat.attach.list")} data-testid="attachments">
            <For each={files()}>
              {(path) => (
                <li class={styles.chip} data-testid="attachment-chip">
                  <span class={styles.chipName}>{fileName(path)}</span>
                  <IconButton
                    label={t("chat.attach.remove", { name: fileName(path) })}
                    onClick={() => setFiles(files().filter((p) => p !== path))}
                    data-testid="attachment-remove"
                  >
                    <X size={12} />
                  </IconButton>
                </li>
              )}
            </For>
          </ul>
        </Show>
        <div class={styles.box} ref={dropZone}>
          <IconButton label={t("chat.attach")} onClick={pick} data-testid="composer-attach">
            <Paperclip size={16} />
          </IconButton>
          <textarea
            ref={input}
            class={styles.input}
            rows={1}
            value={text()}
            placeholder={t("chat.placeholder", { name: props.agent.name })}
            aria-label={t("chat.placeholder", { name: props.agent.name })}
            onInput={(e) => {
              setText(e.currentTarget.value)
              resize()
            }}
            onKeyDown={onKeyDown}
            data-testid="composer-input"
          />
          <Show
            when={props.working}
            fallback={
              <button
                type="button"
                class={styles.sendButton}
                aria-label={t("chat.send")}
                title={t("chat.send")}
                disabled={!text().trim() && files().length === 0}
                onClick={send}
                data-testid="composer-send"
              >
                <SendHorizontal size={16} />
              </button>
            }
          >
            <button
              type="button"
              class={styles.sendButton}
              data-stop="true"
              aria-label={t("chat.stop")}
              title={t("chat.stop")}
              onClick={() => call("chat.stop", { agentId: props.agent.id })}
              data-testid="composer-stop"
            >
              <Square size={14} />
            </button>
          </Show>
        </div>
      </Show>
      <Show when={error()}>
        {(err) => <div class={styles.composerError}>{t(err().key, err().params)}</div>}
      </Show>
    </div>
  )
}
