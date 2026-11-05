import {
  type Agent,
  ATTACH_BYTES,
  ATTACH_MAX,
  type ChatMessage,
  insertMention,
  type MentionEntry,
  type MessageKey,
  mentionEntries,
  messageText,
  openMention,
  type QueuedMessage,
  type QueueHold,
  type Skill,
  type SlashCommand,
  slashItems,
  slashQuery,
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
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { MentionList } from "../channels/MentionList.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call, stageFile } from "../lib/rpc.ts"
import { AgentInLine } from "../orgs/AgentName.tsx"
import skillStyles from "../skills/skills.module.css"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useOrgs } from "../state/orgs.tsx"
import { useProviders } from "../state/providers.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import { echo } from "../ui/echo.ts"
import { compactOffKey } from "./ContextMeter.tsx"
import styles from "./chat.module.css"
import { pendingFill, takeFill } from "./fill.ts"
import { pastedFiles } from "./paste.ts"
import { threadPart } from "./threads.ts"

interface FileTransfer {
  readonly path: string
  readonly sent: number
  readonly total: number
  readonly state: "sending" | "failed"
}

function transferPercent(sent: number, total: number) {
  if (total <= 0) return 0
  return Math.min(100, Math.round((sent / total) * 100))
}

/** What the box sends: the chat marks its echo, so it slides up from the box. */
export interface SendPreview {
  readonly text: string
  readonly files: readonly string[]
  readonly skillName?: string
  readonly replyTo?: ChatMessage
}

export interface ComposerProps {
  agent: Agent
  /** The thread that the box writes to (spec 003, "Threads"). Null is the main thread. */
  threadId: string | null
  working: boolean
  queue: readonly QueuedMessage[]
  /** Set when the program of the agent takes no input during a turn: "Send now" is off. */
  hold: QueueHold | null
  replyTo: ChatMessage | undefined
  onCancelReply: () => void
  onSent: () => void
  /** Runs when a send starts, so the chat marks the echo of the message. */
  onPreview: (preview: SendPreview) => void
  /** Runs when a send fails and the draft goes back into the box. */
  onFailed: () => void
  onConnect: () => void
  onChooseModel: () => void
}

/** The reason why queued messages cannot go into the turn. */
const holdKey = (hold: QueueHold) => `chat.hold.${hold.runtime}` as MessageKey

const QueueItem = (props: {
  agentId: string
  threadId: string | null
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
        ...threadPart(props.threadId),
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
      <Show when={props.item.blocked}>
        {(blocked) => (
          <span class={styles.queueLabel} data-testid="queued-blocked">
            {t(`error.${blocked().code}` as MessageKey, { detail: blocked().detail })}
          </span>
        )}
      </Show>
      <Show when={props.working}>
        <Button
          class={styles.sendNow}
          disabled={props.hold !== null}
          title={props.hold ? t(holdKey(props.hold)) : undefined}
          onClick={() =>
            call("chat.queue.sendNow", {
              agentId: props.agentId,
              ...threadPart(props.threadId),
              itemId: props.item.id,
            }).catch((e: unknown) => props.onError(describeError(e)))
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
        onClick={() =>
          call("chat.queue.remove", {
            agentId: props.agentId,
            ...threadPart(props.threadId),
            itemId: props.item.id,
          })
        }
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
  /** Files going to a linked server, or waiting for Retry after a failed transfer (spec 003). */
  const [transfers, setTransfers] = createSignal<readonly FileTransfer[]>([])
  onCleanup(
    window.robot.on("attachments.transfer", (event) => {
      setTransfers(
        transfers().map((item) =>
          item.path === event.path && item.state === "sending"
            ? { ...item, sent: event.sent, total: event.total }
            : item,
        ),
      )
    }),
  )
  /** A small picture for each attached image that was pasted or dropped (spec 003, flow 4). */
  const [previews, setPreviews] = createSignal<Readonly<Record<string, string>>>({})
  /** The skill chip at the start of the box (spec 017). One at a time. */
  const [skill, setSkill] = createSignal<{ id: string; name: string }>()
  // The command picker (spec 003, flow 7): a slash as the first character opens a list. It shows
  // the commands first, then the skills that the user saved for this agent. The list narrows as
  // the user types.
  const [skillList, { refetch: refetchSkills }] = createResource(
    () => props.agent.id,
    (agentId) => call("skills.forAgent", { agentId }).catch(() => [] as readonly Skill[]),
    { initialValue: [] as readonly Skill[] },
  )
  onCleanup(window.robot.on("skills.changed", () => void refetchSkills()))
  // A linked computer gets no push when the skills of its server change, so the list is read again
  // each time it opens (spec 012).
  createEffect(
    on(
      () => slashQuery(text()) !== null,
      (open) => {
        if (open && ui.linked()) void refetchSkills()
      },
      { defer: true },
    ),
  )
  // A linked computer has no Compact control, so it has no command (spec 011, 012).
  const commands = (): readonly SlashCommand[] => (ui.linked() ? [] : ["compact"])
  // Whether Compact is on is read when the list opens, so the entry tells the truth.
  const [meter] = createResource(
    () =>
      !ui.linked() && slashQuery(text()) !== null
        ? `${props.agent.id}|${props.threadId ?? ""}`
        : undefined,
    () =>
      call("chat.meter", { agentId: props.agent.id, ...threadPart(props.threadId) }).catch(
        () => undefined,
      ),
  )
  const compactOff = () => meter()?.off ?? null
  const [highlight, setHighlight] = createSignal(0)
  const [dismissed, setDismissed] = createSignal(false)
  // The `@` list (spec 003, "Mention another agent"). It has no `@all`.
  const agents = useAgents()
  const orgs = useOrgs()
  const [caret, setCaret] = createSignal(0)
  const [mentionHighlight, setMentionHighlight] = createSignal(0)
  const [mentionDismissed, setMentionDismissed] = createSignal(false)
  const mention = createMemo(() => openMention(text(), caret()))
  const mentionable = createMemo(() => {
    const open = mention()
    if (!open) return []
    // Each agent brings the whole name of its organization, so the list also matches it (spec 036).
    const others = agents
      .agents()
      .filter((agent) => agent.id !== props.agent.id)
      .map((agent) => ({ ...agent, organization: orgs.prefixOrg(agent.id) }))
    return mentionEntries(others, open.query, false)
  })
  const mentionOpen = () => mentionable().length > 0 && !mentionDismissed()
  createEffect(
    on(
      () => {
        const open = mention()
        return open ? `${open.start}:${open.query}` : ""
      },
      () => {
        setMentionHighlight(0)
        setMentionDismissed(false)
      },
      { defer: true },
    ),
  )
  const pickMention = (entry: MentionEntry<Agent>) => {
    const open = mention()
    if (!open || entry.kind !== "member") return
    const next = insertMention(text(), open, caret(), entry.member.name)
    setText(next.text)
    setCaret(next.caret)
    queueMicrotask(() => {
      resize()
      input?.focus()
      input?.setSelectionRange(next.caret, next.caret)
    })
  }
  const matches = createMemo(() => slashItems(text(), skillList(), commands()))
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
  /** A command runs at once, and its slash text leaves the box. A command that is off does nothing. */
  const runCommand = async (command: SlashCommand) => {
    if (command === "compact" && (compactOff() !== null || meter()?.compacting)) return
    setText("")
    setError(undefined)
    queueMicrotask(resize)
    try {
      await call("chat.compact", { agentId: props.agent.id, ...threadPart(props.threadId) })
    } catch (e) {
      setError(describeError(e))
    }
  }
  const pickItem = (item: ReturnType<typeof matches>[number]) =>
    item.kind === "command" ? void runCommand(item.command) : pickSkill(item.skill)
  let input: HTMLTextAreaElement | undefined
  let sendButton: HTMLButtonElement | undefined
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
      void attachFiles([...(e.dataTransfer?.files ?? [])])
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
  /** Sets the attached files. A picture whose file left the list is let go. */
  const keepFiles = (next: string[]) => {
    const kept = new Set(next)
    const shown: Record<string, string> = {}
    for (const [path, url] of Object.entries(previews())) {
      if (kept.has(path)) shown[path] = url
      else URL.revokeObjectURL(url)
    }
    setPreviews(shown)
    setFiles(next)
  }
  const addFiles = (paths: readonly string[]) => {
    const merged = [...new Set([...files(), ...paths.filter(Boolean)])]
    if (merged.length > ATTACH_MAX) setError({ key: "error.too_many_files" })
    keepFiles(merged.slice(0, ATTACH_MAX))
  }
  onCleanup(() => {
    for (const url of Object.values(previews())) URL.revokeObjectURL(url)
  })
  /**
   * Attaches files that the window got from a drop or a paste. A file with a path is attached by
   * its path. A file with no path (a screenshot, a picture from a web page, a video that was
   * copied) is saved on this computer first, and the box attaches the saved file.
   */
  const attachFiles = async (list: readonly File[]) => {
    setError(undefined)
    const paths: string[] = []
    for (const file of list) {
      if (new Set([...files(), ...paths]).size >= ATTACH_MAX) {
        setError({ key: "error.too_many_files" })
        break
      }
      let path = window.robot.pathForFile(file)
      if (!path) {
        if (file.size > ATTACH_BYTES) {
          setError({ key: "error.file_too_large", params: { detail: file.name } })
          continue
        }
        try {
          path = await stageFile(file)
        } catch (e) {
          setError(describeError(e))
          continue
        }
      }
      if (file.type.startsWith("image/") && !previews()[path])
        setPreviews({ ...previews(), [path]: URL.createObjectURL(file) })
      paths.push(path)
    }
    addFiles(paths)
  }
  // A file on the clipboard is attached, and the paste does not reach the text box. Text pastes
  // as it did (see `pastedFiles`).
  const onPaste = (event: ClipboardEvent) => {
    const data = event.clipboardData
    if (!data) return
    const attach = pastedFiles([...data.files], data.getData("text/plain"), (f) =>
      Boolean(window.robot.pathForFile(f)),
    )
    if (attach.length === 0) return
    event.preventDefault()
    void attachFiles(attach)
  }
  const pick = async () => {
    try {
      addFiles(await call("files.pick"))
    } catch (e) {
      setError(describeError(e))
    }
  }

  /**
   * Sends the box. The box empties at once, before the host answers, so a second Enter or click in
   * the time of the call finds an empty box and sends nothing. If the send fails, the draft goes
   * back into the box (spec 003, "Messages during a turn": a refused message stays in the box).
   */
  const send = async () => {
    const value = text().trim()
    const chip = skill()
    const attached = files()
    if (!value && attached.length === 0 && !chip) return
    // The send button answers once, before the box empties and the button swaps to Stop.
    echo(sendButton)
    // The chat marks the echo, so it slides up from the box.
    props.onPreview({
      text: value,
      files: [...attached],
      ...(chip ? { skillName: chip.name } : {}),
      ...(props.replyTo ? { replyTo: props.replyTo } : {}),
    })
    // The small pictures stay alive until the send ends, so a failed send can show them again.
    const shown = previews()
    const linkedFiles = ui.linked() && attached.length > 0
    setError(undefined)
    setText("")
    setFiles([])
    setPreviews({})
    setSkill(undefined)
    if (linkedFiles)
      setTransfers([
        ...transfers(),
        ...attached.map((path): FileTransfer => ({ path, sent: 0, total: 0, state: "sending" })),
      ])
    queueMicrotask(resize)
    try {
      const result = await call("chat.send", {
        agentId: props.agent.id,
        ...threadPart(props.threadId),
        text: value,
        replyTo: props.replyTo?.id ?? null,
        files: [...attached],
        ...(chip ? { skillId: chip.id } : {}),
      })
      const failed = new Set(result.failedFiles ?? [])
      const kept: Record<string, string> = {}
      for (const [path, url] of Object.entries(shown)) {
        if (failed.has(path)) kept[path] = url
        else URL.revokeObjectURL(url)
      }
      setPreviews({ ...kept, ...previews() })
      if (linkedFiles) {
        const sentNow = new Set(attached)
        setTransfers(
          transfers()
            .filter((item) => !sentNow.has(item.path) || failed.has(item.path))
            .map((item) => (failed.has(item.path) ? { ...item, state: "failed" } : item)),
        )
      }
      props.onCancelReply()
      props.onSent()
    } catch (e) {
      // Put the draft back in front of anything that the user typed or attached in the meantime.
      setText(text() ? `${value}\n${text()}` : value)
      if (linkedFiles) {
        const sentNow = new Set(attached)
        setTransfers(
          transfers().map((item) => (sentNow.has(item.path) ? { ...item, state: "failed" } : item)),
        )
        setPreviews({ ...shown, ...previews() })
      } else {
        setFiles([...new Set([...attached, ...files()])].slice(0, ATTACH_MAX))
        setPreviews({ ...shown, ...previews() })
      }
      if (chip && !skill()) setSkill(chip)
      queueMicrotask(resize)
      setError(describeError(e))
      props.onFailed()
    }
  }

  const retryTransfer = async (path: string) => {
    setTransfers(
      transfers().map((item) =>
        item.path === path ? { ...item, state: "sending", sent: 0 } : item,
      ),
    )
    setError(undefined)
    try {
      const result = await call("chat.send", {
        agentId: props.agent.id,
        ...threadPart(props.threadId),
        text: "",
        replyTo: null,
        files: [path],
      })
      if ((result.failedFiles ?? []).includes(path)) {
        setTransfers(
          transfers().map((item) => (item.path === path ? { ...item, state: "failed" } : item)),
        )
        return
      }
      const url = previews()[path]
      if (url) URL.revokeObjectURL(url)
      const rest: Record<string, string> = {}
      for (const [key, value] of Object.entries(previews())) {
        if (key !== path) rest[key] = value
      }
      setPreviews(rest)
      setTransfers(transfers().filter((item) => item.path !== path))
      props.onSent()
    } catch (e) {
      setTransfers(
        transfers().map((item) => (item.path === path ? { ...item, state: "failed" } : item)),
      )
      setError(describeError(e))
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    // While an input method composes text (for example Korean), Enter ends the composition.
    if (event.isComposing || event.keyCode === 229) return
    if (mentionOpen()) {
      const list = mentionable()
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault()
        const step = event.key === "ArrowDown" ? 1 : -1
        setMentionHighlight((mentionHighlight() + step + list.length) % list.length)
        return
      }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
        event.preventDefault()
        const chosen = list[mentionHighlight()]
        if (chosen) pickMention(chosen)
        return
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setMentionDismissed(true)
        return
      }
    }
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
        if (chosen) pickItem(chosen)
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
                threadId={props.threadId}
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
                {quoted().author === "agent" ? (
                  <AgentInLine
                    line={(name) => t("chat.replyingTo", { name })}
                    id={props.agent.id}
                    name={props.agent.name}
                  />
                ) : (
                  t("chat.replyingTo", { name: t("chat.you") })
                )}
                {": "}
                {messageText(quoted()).slice(0, 80)}
              </span>
              <IconButton label={t("chat.cancelReply")} onClick={props.onCancelReply}>
                <X size={14} />
              </IconButton>
            </div>
          )}
        </Show>
        <Show when={files().length > 0 || transfers().length > 0}>
          <ul class={styles.chips} aria-label={t("chat.attach.list")} data-testid="attachments">
            <For each={files()}>
              {(path) => (
                <li class={styles.chip} data-testid="attachment-chip">
                  <Show when={previews()[path]}>
                    {(src) => (
                      <img
                        class={styles.chipThumb}
                        src={src()}
                        alt=""
                        data-testid="attachment-preview"
                      />
                    )}
                  </Show>
                  <span class={styles.chipName}>{fileName(path)}</span>
                  <IconButton
                    label={t("chat.attach.remove", { name: fileName(path) })}
                    onClick={() => keepFiles(files().filter((p) => p !== path))}
                    data-testid="attachment-remove"
                  >
                    <X size={12} />
                  </IconButton>
                </li>
              )}
            </For>
            <For each={transfers()}>
              {(item) => (
                <li class={styles.chip} data-testid="attachment-chip" data-state={item.state}>
                  <Show when={previews()[item.path]}>
                    {(src) => (
                      <img
                        class={styles.chipThumb}
                        src={src()}
                        alt=""
                        data-testid="attachment-preview"
                      />
                    )}
                  </Show>
                  <span class={styles.chipName}>{fileName(item.path)}</span>
                  <Show
                    when={item.state === "failed"}
                    fallback={
                      <span class={styles.chipSize} data-testid="attachment-progress">
                        {t("chat.attach.progress", {
                          percent: transferPercent(item.sent, item.total),
                        })}
                      </span>
                    }
                  >
                    <Button
                      data-testid="attachment-retry"
                      onClick={() => void retryTransfer(item.path)}
                    >
                      {t("chat.attach.retry")}
                    </Button>
                  </Show>
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
        <Show when={mentionOpen()}>
          <MentionList
            label={t("chat.mentions")}
            entries={mentionable()}
            highlight={mentionHighlight()}
            onPick={pickMention}
          />
        </Show>
        <Show when={pickerOpen()}>
          <div
            class={skillStyles.picker}
            role="listbox"
            aria-label={t("skills.picker")}
            data-testid="skill-picker"
          >
            <For each={matches()}>
              {(item, index) =>
                item.kind === "command" ? (
                  <button
                    type="button"
                    role="option"
                    class={skillStyles.pick}
                    aria-selected={highlight() === index()}
                    aria-disabled={compactOff() !== null || meter()?.compacting === true}
                    // The box keeps the focus, so a click does not end the typing.
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickItem(item)}
                    data-testid="command-option"
                    data-command={item.command}
                  >
                    <span class={skillStyles.pickName}>/{item.command}</span>
                    <span class={skillStyles.pickHint}>
                      {compactOff() !== null
                        ? t(
                            compactOffKey(
                              compactOff() as NonNullable<ReturnType<typeof compactOff>>,
                            ),
                          )
                        : t("skills.command.compact")}
                    </span>
                  </button>
                ) : (
                  <button
                    type="button"
                    role="option"
                    class={skillStyles.pick}
                    aria-selected={highlight() === index()}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => pickItem(item)}
                    data-testid="skill-option"
                    data-skill={item.skill.name}
                  >
                    <span class={skillStyles.pickName}>/{item.skill.name}</span>
                    <Show when={item.skill.description}>
                      <span class={skillStyles.pickHint}>{item.skill.description}</span>
                    </Show>
                  </button>
                )
              }
            </For>
          </div>
        </Show>
        <div class={styles.box} ref={dropZone}>
          <IconButton
            class={styles.attach}
            label={t("chat.attach")}
            onClick={pick}
            data-testid="composer-attach"
          >
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
              setCaret(e.currentTarget.selectionStart)
              resize()
            }}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
            onClick={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            data-testid="composer-input"
          />
          <Show
            when={props.working}
            fallback={
              <button
                type="button"
                ref={sendButton}
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
              onClick={() =>
                call("chat.stop", { agentId: props.agent.id, ...threadPart(props.threadId) })
              }
              data-testid="composer-stop"
            >
              <Square size={14} />
            </button>
          </Show>
        </div>
      </Show>
      <Show when={error()}>
        {(err) => (
          <div class={styles.composerError} data-testid="composer-error">
            {t(err().key, err().params)}
          </div>
        )}
      </Show>
    </div>
  )
}
