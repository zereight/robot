import {
  type Agent,
  ATTACH_MAX,
  type ChatMessage,
  type MessageKey,
  messageText,
  type QueuedMessage,
  type QueueHold,
  type Skill,
} from "@robot/shared"
import {
  CornerDownRight,
  Paperclip,
  Pencil,
  SendHorizontal,
  Sparkles,
  Square,
  X,
} from "lucide-solid"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import skillStyles from "../skills/skills.module.css"
import { useApp } from "../state/app.tsx"
import { useProviders } from "../state/providers.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import styles from "./chat.module.css"
import { pendingFill, takeFill } from "./fill.ts"

export interface ComposerProps {
  agent: Agent
  working: boolean
  queue: readonly QueuedMessage[]
  /** Set when the program of the agent takes no input during a turn: "Send now" is off. */
  hold: QueueHold | null
  replyTo: ChatMessage | undefined
  onCancelReply: () => void
  onSent: () => void
  onConnect: () => void
  onChooseModel: () => void
}

/** The picker shows at most this many skills (spec 003). */
const SKILL_LIST_MAX = 30

/** The reason why queued messages cannot go into the turn. */
const holdKey = (hold: QueueHold) => `chat.hold.${hold.runtime}` as MessageKey

const QueueItem = (props: {
  agentId: string
  item: QueuedMessage
  working: boolean
  hold: QueueHold | null
  onError: (error: ErrorText) => void
}) => {
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
      <Show when={props.working}>
        <Button
          class={styles.sendNow}
          disabled={props.hold !== null}
          title={props.hold ? t(holdKey(props.hold)) : undefined}
          onClick={() =>
            call("chat.queue.sendNow", { agentId: props.agentId, itemId: props.item.id }).catch(
              (e: unknown) => props.onError(describeError(e)),
            )
          }
          data-testid="queued-send-now"
        >
          <CornerDownRight size={14} />
          {t("chat.queue.sendNow")}
        </Button>
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
  const ui = useUi()
  const [text, setText] = createSignal("")
  const [error, setError] = createSignal<ErrorText>()
  const [files, setFiles] = createSignal<string[]>([])
  /** The skill chip at the start of the box (spec 017). One at a time. */
  const [skill, setSkill] = createSignal<{ id: string; name: string }>()
  // The command picker (spec 003, flow 7): a slash as the first character opens a list of the
  // skills that the user saved for this agent. The list narrows as the user types.
  const [skillList, { refetch: refetchSkills }] = createResource(
    () => props.agent.id,
    (agentId) => call("skills.forAgent", { agentId }).catch(() => [] as readonly Skill[]),
    { initialValue: [] as readonly Skill[] },
  )
  onCleanup(window.robot.on("skills.changed", () => void refetchSkills()))
  const [highlight, setHighlight] = createSignal(0)
  const [dismissed, setDismissed] = createSignal(false)
  const matches = createMemo(() => {
    const typed = /^\/(\S*)$/.exec(text())
    if (!typed) return []
    const q = (typed[1] ?? "").toLocaleLowerCase()
    const all = skillList()
    const starts = all.filter((x) => x.name.toLocaleLowerCase().startsWith(q))
    const inside = all.filter((x) => !starts.includes(x) && x.name.toLocaleLowerCase().includes(q))
    return [...starts, ...inside].slice(0, SKILL_LIST_MAX)
  })
  const pickerOpen = () => !dismissed() && matches().length > 0
  createEffect(() => {
    void text()
    setHighlight(0)
    setDismissed(false)
  })
  /** The chip takes the place of the slash text. A second skill replaces the first. */
  const pickSkill = (picked: Skill) => {
    setSkill({ id: picked.id, name: picked.name })
    setText("")
    setError(undefined)
    queueMicrotask(() => {
      resize()
      input?.focus()
    })
  }
  let input: HTMLTextAreaElement | undefined
  // "Try it" on a draft skill card puts the chip and the result text in the box.
  createEffect(() => {
    const fill = pendingFill()
    if (!fill || fill.agentId !== props.agent.id) return
    takeFill()
    setSkill(fill.skill)
    setText(fill.text)
    setError(undefined)
    queueMicrotask(() => {
      resize()
      input?.focus()
    })
  })
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
    // A scrollbar only when the box hit its cap; otherwise it shows as a stray bar.
    input.style.overflowY = input.scrollHeight > input.clientHeight + 1 ? "auto" : "hidden"
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
    const chip = skill()
    if (!value && files().length === 0 && !chip) return
    setError(undefined)
    try {
      await call("chat.send", {
        agentId: props.agent.id,
        text: value,
        replyTo: props.replyTo?.id ?? null,
        files: [...files()],
        ...(chip ? { skillId: chip.id } : {}),
      })
      setText("")
      setFiles([])
      setSkill(undefined)
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
    if (pickerOpen()) {
      const list = matches()
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const step = event.key === "ArrowDown" ? 1 : -1
        setHighlight((highlight() + step + list.length) % list.length)
        return
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        const chosen = list[highlight()]
        if (chosen) pickSkill(chosen)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setDismissed(true)
        return
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      void send()
    } else if (
      event.key === "Backspace" &&
      skill() &&
      input?.selectionStart === 0 &&
      input.selectionEnd === 0
    ) {
      // Backspace at the start of the box removes the chip.
      event.preventDefault()
      setSkill(undefined)
    } else if (event.key === "Escape" && props.replyTo) {
      props.onCancelReply()
    }
  }

  const blocked = () => ui.serverOffline() || props.agent.state === "offline"

  // The program of the agent needs repair or is not installed (spec 006). The box is off, and the
  // button is "Repair" or "Providers". A client sees the words and has no button.
  const providers = useProviders()
  const problem = () => props.agent.runtimeProblem ?? null
  const [repairing, setRepairing] = createSignal(false)
  const [repairError, setRepairError] = createSignal<ErrorText>()
  const repair = async () => {
    const p = problem()
    if (!p || repairing()) return
    setRepairing(true)
    setRepairError(undefined)
    try {
      const account = props.agent.model ? providers.byId(props.agent.model.accountId) : undefined
      await call("runtimes.repair", { kind: p.kind, signIn: account?.signIn ?? null })
    } catch (e) {
      setRepairError(describeError(e))
    } finally {
      setRepairing(false)
    }
  }

  return (
    <div class={styles.composer}>
      <Show when={props.queue.length > 0}>
        <div class={styles.queue}>
          <Show when={props.hold}>
            {(hold) => (
              <div class={styles.queueHold} data-testid="queue-hold">
                {t(holdKey(hold()))}
              </div>
            )}
          </Show>
          <For each={props.queue}>
            {(item) => (
              <QueueItem
                agentId={props.agent.id}
                item={item}
                working={props.working}
                hold={props.hold}
                onError={setError}
              />
            )}
          </For>
        </div>
      </Show>
      <Show
        when={!blocked()}
        fallback={
          <div class={styles.blocked} data-testid="composer-blocked">
            <Show
              when={ui.serverOffline()}
              fallback={
                <Show
                  when={problem()}
                  fallback={
                    <>
                      <span>{props.agent.model ? t("chat.notConnected") : t("chat.noModel")}</span>
                      <Show when={!ui.linked()}>
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
                          <Button
                            variant="primary"
                            onClick={props.onConnect}
                            data-testid="composer-connect"
                          >
                            {t("chat.connect")}
                          </Button>
                        </Show>
                      </Show>
                    </>
                  }
                >
                  {(p) => (
                    <>
                      <span data-testid="composer-runtime" data-state={p().state}>
                        {t(`chat.runtime.${p().state}`)}
                        <Show when={p().reason}>
                          {(reason) => <> {t(`runtime.reason.${reason()}`)}</>}
                        </Show>
                      </span>
                      <Show when={repairError()}>
                        {(err) => (
                          <span role="alert" data-testid="composer-repair-error">
                            {t(err().key, err().params)}
                          </span>
                        )}
                      </Show>
                      {/* A client sees the state and has no button (spec 012). */}
                      <Show when={!ui.linked()}>
                        <Show
                          when={p().state === "needs_repair"}
                          fallback={
                            <Button
                              variant="primary"
                              onClick={props.onConnect}
                              data-testid="composer-providers"
                            >
                              {t("chat.runtime.providers")}
                            </Button>
                          }
                        >
                          <Button
                            variant="primary"
                            onClick={() => void repair()}
                            disabled={repairing()}
                            data-testid="composer-repair"
                          >
                            {repairing() ? t("chat.runtime.repairing") : t("chat.runtime.repair")}
                          </Button>
                        </Show>
                      </Show>
                    </>
                  )}
                </Show>
              }
            >
              <span data-testid="composer-offline">
                {ui.server()?.state === "not_allowed"
                  ? t("link.state.not_allowed", { name: ui.server()?.name ?? "" })
                  : t("link.state.offline", { name: ui.server()?.name ?? "" })}
              </span>
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
        <Show when={skill()}>
          {(chip) => (
            <div class={styles.composerSkill}>
              <span class={styles.skillChip} data-testid="composer-skill">
                <Sparkles size={12} />
                <span>{chip().name}</span>
                <IconButton
                  label={t("skills.chip.remove", { name: chip().name })}
                  onClick={() => setSkill(undefined)}
                  data-testid="composer-skill-remove"
                >
                  <X size={12} />
                </IconButton>
              </span>
            </div>
          )}
        </Show>
        <Show when={pickerOpen()}>
          <div
            class={skillStyles.picker}
            role="listbox"
            aria-label={t("skills.picker")}
            data-testid="skill-picker"
          >
            <For each={matches()}>
              {(item, index) => (
                <button
                  type="button"
                  role="option"
                  class={skillStyles.pick}
                  aria-selected={highlight() === index()}
                  // The box keeps the focus, so a click does not end the typing.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pickSkill(item)}
                  data-testid="skill-option"
                  data-skill={item.name}
                >
                  <span class={skillStyles.pickName}>/{item.name}</span>
                  <Show when={item.description}>
                    <span class={skillStyles.pickHint}>{item.description}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
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
                disabled={!text().trim() && files().length === 0 && !skill()}
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
