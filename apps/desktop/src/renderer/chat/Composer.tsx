import {
  CHAT_ATTACH_MAX,
  CHAT_MESSAGE_MAX,
  chatText,
  type QueuedChatMessage,
  SKILL_PICKER_MAX,
  type Skill,
  slashQuery,
  type WorkflowChatHistory,
  type WorkflowChatMessage,
} from "@robot/shared"
import { ArrowUp, Paperclip, Square, X } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  Show,
} from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call, stageFile } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./chat.module.css"
import { pastedFiles } from "./paste.ts"

interface Attached {
  readonly path: string
  readonly name: string
  /** A small preview of a picture, when the file is one. */
  readonly preview?: string
}

const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** The message box of the chat (spec 003, flows 1 to 7). */
export const Composer = (props: {
  readonly history: WorkflowChatHistory
  readonly replyTo: WorkflowChatMessage | undefined
  readonly onCancelReply: () => void
  readonly onSent: () => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const [text, setText] = createSignal("")
  const [files, setFiles] = createSignal<readonly Attached[]>([])
  const [skill, setSkill] = createSignal<Skill>()
  const [error, setError] = createSignal<ErrorText>()
  const [sending, setSending] = createSignal(false)
  const [active, setActive] = createSignal(0)
  const [dragging, setDragging] = createSignal(false)
  let box: HTMLTextAreaElement | undefined

  const [skills, { refetch }] = createResource(
    () => ui.server()?.id,
    async (serverId) => (await call("skills.list", { serverId })).filter((s) => s.enabled),
  )
  onCleanup(window.robot.on("skills.changed", () => void refetch()))
  const query = createMemo(() => (skill() ? null : slashQuery(text())))
  const matches = createMemo(() => {
    const q = query()
    if (q === null) return []
    const needle = q.toLowerCase()
    return (skills() ?? [])
      .filter((s) => s.name.toLowerCase().replace(/^\//, "").includes(needle))
      .slice(0, SKILL_PICKER_MAX)
  })
  createEffect(on(query, () => setActive(0)))

  const fit = () => {
    if (!box) return
    box.style.height = "auto"
    box.style.height = `${Math.min(box.scrollHeight, 200)}px`
  }
  createEffect(() => {
    text()
    fit()
  })

  const blocked = () => props.history.block !== null
  const fail = (e: unknown) => setError(describeError(e))

  const attach = (paths: readonly Attached[]) => {
    const room = CHAT_ATTACH_MAX - files().length
    setFiles((current) => [...current, ...paths.slice(0, Math.max(0, room))])
  }
  const pick = async () => {
    try {
      const paths = await call("files.pick")
      attach(paths.map((path) => ({ path, name: baseName(path) })))
    } catch (e) {
      fail(e)
    }
  }
  const take = async (list: readonly File[]) => {
    const out: Attached[] = []
    for (const file of list) {
      try {
        const direct = window.robot.pathForFile(file)
        const path = direct || (await stageFile(file))
        out.push({
          path,
          name: file.name || baseName(path),
          ...(file.type.startsWith("image/") ? { preview: URL.createObjectURL(file) } : {}),
        })
      } catch (e) {
        fail(e)
      }
    }
    attach(out)
  }
  const onPaste = (event: ClipboardEvent) => {
    const taken = pastedFiles(
      [...(event.clipboardData?.files ?? [])],
      event.clipboardData?.getData("text/plain") ?? "",
      (file) => window.robot.pathForFile(file) !== "",
    )
    if (taken.length === 0) return
    event.preventDefault()
    void take(taken)
  }
  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    setDragging(false)
    const dropped = [...(event.dataTransfer?.files ?? [])]
    if (dropped.length > 0) void take(dropped)
  }

  const send = async () => {
    const body = text().trim()
    if (sending() || blocked()) return
    if (body === "" && files().length === 0 && !skill()) return
    setSending(true)
    setError(undefined)
    try {
      const chosen = skill()
      await call("chat.send", {
        workflowId: props.history.workflowId,
        text: body,
        ...(files().length > 0 ? { files: files().map((f) => f.path) } : {}),
        ...(chosen ? { skillId: chosen.id } : {}),
        ...(props.replyTo ? { replyTo: props.replyTo.id } : {}),
      })
      setText("")
      setFiles([])
      setSkill(undefined)
      props.onCancelReply()
      props.onSent()
    } catch (e) {
      // The box keeps its text, so the user can try again (spec 003, "Messages during a turn").
      fail(e)
    } finally {
      setSending(false)
      box?.focus()
    }
  }
  const stop = () => void call("chat.stop", { workflowId: props.history.workflowId })

  const pickSkill = (chosen: Skill) => {
    setSkill(chosen)
    setText("")
    box?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const list = matches()
    if (query() !== null && list.length > 0) {
      if (event.key === "ArrowDown") {
        event.preventDefault()
        setActive((i) => (i + 1) % list.length)
        return
      }
      if (event.key === "ArrowUp") {
        event.preventDefault()
        setActive((i) => (i - 1 + list.length) % list.length)
        return
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault()
        const chosen = list[active()]
        if (chosen) pickSkill(chosen)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setText("")
        return
      }
    }
    if (event.key === "Backspace" && text() === "" && skill()) {
      setSkill(undefined)
      return
    }
    // Enter sends. Shift+Enter makes a new line. A key that confirms a word of an input method
    // (Korean, Japanese) is not a send.
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      void send()
    }
  }

  const queueAction = (item: QueuedChatMessage, action: "remove" | "edit" | "now") => {
    const run =
      action === "now"
        ? call("chat.sendNow", { id: item.id })
        : call("chat.delete", { id: item.id }).then(({ text: back }) => {
            if (action === "edit") {
              setText(back)
              box?.focus()
            }
          })
    void run.catch(fail)
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a drop zone for files; the attach button is the keyboard way
    <section
      class={styles.composer}
      classList={{ [styles.dragging ?? ""]: dragging() }}
      data-testid="composer"
      onDragOver={(e) => {
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <Show when={props.history.queue.length > 0}>
        <ul class={styles.queue} data-testid="queue" aria-label={t("chat.queue")}>
          <For each={props.history.queue}>
            {(item) => (
              <li class={styles.queued} data-testid="queued-message">
                <span class={styles.queuedText}>{item.text || item.files.join(", ")}</span>
                <Button onClick={() => queueAction(item, "now")} data-testid="queued-now">
                  {t("chat.sendNow")}
                </Button>
                <Button onClick={() => queueAction(item, "edit")} data-testid="queued-edit">
                  {t("chat.edit")}
                </Button>
                <Button onClick={() => queueAction(item, "remove")} data-testid="queued-remove">
                  {t("chat.remove")}
                </Button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={props.replyTo}>
        {(quoted) => (
          <div class={styles.replying} data-testid="reply-line">
            <span class={styles.replyingText}>
              {t("chat.replyingTo")} {chatText(quoted()).slice(0, 100)}
            </span>
            <button
              type="button"
              class={styles.action}
              onClick={props.onCancelReply}
              aria-label={t("chat.cancelReply")}
              title={t("chat.cancelReply")}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </Show>
      <Show when={error()}>
        {(e) => (
          <p class={styles.composerError} role="alert" data-testid="composer-error">
            {t(e().key, e().params)}
          </p>
        )}
      </Show>
      <Show when={query() !== null}>
        <ul class={styles.picker} aria-label={t("chat.skills")} data-testid="skill-picker">
          <Show
            when={matches().length > 0}
            fallback={<li class={styles.pickerNone}>{t("chat.skills.none")}</li>}
          >
            <For each={matches()}>
              {(s, i) => (
                <li>
                  <button
                    type="button"
                    class={styles.pickerItem}
                    classList={{ [styles.pickerActive ?? ""]: i() === active() }}
                    data-testid="skill-option"
                    onMouseDown={(e) => {
                      e.preventDefault()
                      pickSkill(s)
                    }}
                  >
                    <span class={styles.pickerName}>/{s.name.replace(/^\//, "")}</span>
                    <span class={styles.pickerHint}>{s.description}</span>
                  </button>
                </li>
              )}
            </For>
          </Show>
        </ul>
      </Show>
      <Show when={files().length > 0 || skill()}>
        <div class={styles.chips}>
          <Show when={skill()}>
            {(s) => (
              <span class={styles.chip} data-testid="skill-chip">
                /{s().name.replace(/^\//, "")}
                <button
                  type="button"
                  class={styles.chipRemove}
                  onClick={() => setSkill(undefined)}
                  aria-label={t("chat.removeFile")}
                >
                  <X size={12} />
                </button>
              </span>
            )}
          </Show>
          <For each={files()}>
            {(file) => (
              <span class={styles.chip} data-testid="attached-file">
                <Show when={file.preview}>
                  {(src) => <img class={styles.thumb} src={src()} alt="" />}
                </Show>
                {file.name}
                <button
                  type="button"
                  class={styles.chipRemove}
                  onClick={() => setFiles((all) => all.filter((f) => f !== file))}
                  aria-label={t("chat.removeFile")}
                  title={t("chat.removeFile")}
                >
                  <X size={12} />
                </button>
              </span>
            )}
          </For>
        </div>
      </Show>
      <Show
        when={!blocked()}
        fallback={
          <div class={styles.blocked} data-testid="chat-blocked">
            <span>{t("chat.noProvider")}</span>
            <Button
              variant="primary"
              onClick={() => ui.openSettings("providers")}
              data-testid="chat-connect"
            >
              {t("chat.connect")}
            </Button>
          </div>
        }
      >
        <div class={styles.inputRow}>
          <button
            type="button"
            class={styles.action}
            onClick={() => void pick()}
            aria-label={t("chat.attach")}
            title={t("chat.attach")}
            data-testid="chat-attach"
          >
            <Paperclip size={16} />
          </button>
          <textarea
            ref={(el) => {
              box = el
            }}
            class={styles.input}
            rows={1}
            maxLength={CHAT_MESSAGE_MAX}
            value={text()}
            placeholder={
              text() === "" && !skill()
                ? t("chat.placeholder", { name: props.history.workflowName })
                : ""
            }
            aria-label={t("chat.placeholder", { name: props.history.workflowName })}
            data-testid="chat-input"
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
          />
          <Show
            when={props.history.working}
            fallback={
              <button
                type="button"
                class={styles.send}
                onClick={() => void send()}
                disabled={sending()}
                aria-label={t("chat.send")}
                title={t("chat.send")}
                data-testid="chat-send"
              >
                <ArrowUp size={16} />
              </button>
            }
          >
            <button
              type="button"
              class={styles.send}
              onClick={stop}
              aria-label={t("chat.stop")}
              title={t("chat.stop")}
              data-testid="chat-stop"
            >
              <Square size={14} />
            </button>
          </Show>
        </div>
      </Show>
    </section>
  )
}
