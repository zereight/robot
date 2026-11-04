import {
  type Agent,
  type Channel,
  type ChannelMessage,
  type ChatMessage,
  catalogues,
  channelParent,
  EVERYONE_MENTION,
  insertMention,
  type MentionEntry,
  type MessageKey,
  mentionEntries,
  messageText,
  openMention,
  type PartChip,
  type PartInfo,
  type PlaceRef,
  sameDay,
  startsGroup,
} from "@robot/shared"
import { Eye, OctagonX, Settings2, Square, X } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { Face } from "../agents/Face.tsx"
import chat from "../chat/chat.module.css"
import { formatDay } from "../chat/format.ts"
import { MessageRow } from "../chat/MessageRow.tsx"
import { PlaceMarksLine } from "../chat/PlaceMarksLine.tsx"
import { shapeOf } from "../chat/shape.ts"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useRetry } from "../retry/RetryNote.tsx"
import { useEndRequest, useReview } from "../review/Review.tsx"
import review from "../review/review.module.css"
import { TeamsMark } from "../settings/TeamsMark.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useChannels } from "../state/channels.tsx"
import { originFor, setSearchOrigin, useFocusMessage } from "../state/focus.ts"
import { useUi } from "../state/ui.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import { Presence } from "../ui/Presence.tsx"
import { ChannelDialog } from "./ChannelDialog.tsx"
import styles from "./channels.module.css"
import { MentionList } from "./MentionList.tsx"
import { createChannelChat } from "./state.ts"

const NEAR_BOTTOM_PX = 48

/** A stand-in for an agent that was deleted after it wrote in the channel. */
const removedAgent = (name: string): Agent => ({
  id: "",
  serverId: "",
  name,
  role: "",
  instructions: "",
  face: { shape: 0, hue: 5 },
  faceImage: null,
  model: null,
  workspace: "",
  section: "agents",
  sectionId: null,
  archived: true,
  state: "offline",
  permission: "ask_risky",
  memoryEnabled: false,
  knowledgeEnabled: false,
  createdAt: 0,
  changedBy: null,
})

export const ChannelHeader = (props: { channel: Channel }) => {
  const { t } = useApp()
  const ui = useUi()
  const channels = useChannels()
  const [open, setOpen] = createSignal(false)
  // The parent channel of the tree as it is now (spec 030): one that is gone counts as none.
  const parent = () => {
    const id = channelParent(channels.channels(), props.channel.id)
    return id ? channels.byId(id) : undefined
  }
  return (
    <>
      <span class={styles.hash} aria-hidden="true">
        #
      </span>
      <span class={styles.nameBlock}>
        <span class={styles.headerName} data-testid="channel-header-name">
          {props.channel.name}
        </span>
        <Show when={parent()}>
          {(up) => (
            <button
              type="button"
              class={styles.inParent}
              onClick={() => ui.selectPlace({ kind: "channel", id: up().id }, ui.server()?.id)}
              aria-label={t("channels.in.open", { parent: up().name })}
              data-testid="channel-header-parent"
            >
              {t("channels.in", { parent: up().name })}
            </button>
          )}
        </Show>
      </span>
      <Show when={props.channel.topic}>
        <span class={styles.divider} aria-hidden="true" />
        <span class={styles.topic} title={props.channel.topic} data-testid="channel-header-topic">
          {props.channel.topic}
        </span>
      </Show>
      <TeamsMark kind="channel" id={props.channel.id} />
      <Show when={ui.canChange()}>
        <IconButton
          label={t("channels.settings")}
          onClick={() => setOpen(true)}
          data-testid="channel-settings"
        >
          <Settings2 size={16} />
        </IconButton>
      </Show>
      <Presence when={open()}>
        {() => <ChannelDialog channel={props.channel} onClose={() => setOpen(false)} />}
      </Presence>
    </>
  )
}

const Chip = (props: { chip: PartChip; onJump: (id: string) => void }) => {
  const { t } = useApp()
  const agents = useAgents()
  const agent = () => agents.byId(props.chip.memberId)
  return (
    <button
      type="button"
      class={styles.chip}
      data-state={props.chip.state}
      disabled={!props.chip.newestReplyId}
      aria-label={t("channels.chip", { label: props.chip.label, replies: props.chip.replies })}
      onClick={() => props.chip.newestReplyId && props.onJump(props.chip.newestReplyId)}
      data-testid="part-chip"
    >
      <Show when={agent()}>{(a) => <Face face={a().face} image={a().faceImage} size={16} />}</Show>
      <span class={styles.chipLabel}>{props.chip.label}</span>
      <span class={styles.chipCount}>{props.chip.replies}</span>
    </button>
  )
}

/**
 * Under the last message of a part (spec 004): the bar of a part in review, and the card of a
 * blocked or failed part. A part that another computer owns, or that a linked server owns, shows
 * the state and a muted line: the user decides there (spec 005, 012, 019).
 */
const PartCard = (props: {
  part: PartInfo
  onAccept: () => void
  onChanges: () => void
  onRetry: () => void
  onEnd: () => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  // The name of the computer where the user decides: the sync partner, or the linked server.
  const elsewhere = () => (ui.linked() ? (ui.server()?.name ?? "") : props.part.ownerName)
  const reason = () => {
    const error = props.part.error
    if (!error) return ""
    const key = `error.${error.code}`
    return key in catalogues.en
      ? t(key as MessageKey, { detail: error.detail })
      : t("error.unknown")
  }
  return (
    <>
      <Show when={props.part.state === "review"}>
        <div class={review.bar} data-testid="part-review-bar">
          <span class={review.barText}>
            <Eye size={14} aria-hidden="true" />
            <span>{t("review.waiting")}</span>
          </span>
          <Show
            when={elsewhere() === null}
            fallback={
              <span class={review.reason} data-testid="part-decide-on">
                {t("review.decideOn", { name: elsewhere() || t("sync.anotherComputer") })}
              </span>
            }
          >
            <Button onClick={props.onAccept} data-testid="part-accept">
              {t("tasks.accept")}
            </Button>
            <Button onClick={props.onChanges} data-testid="part-changes">
              {t("tasks.requestChanges")}
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={props.part.state === "blocked" || props.part.state === "failed"}>
        <div class={review.bar} data-testid="part-card" data-state={props.part.state}>
          <span class={review.barText}>
            <OctagonX size={14} aria-hidden="true" />
            <span>
              {props.part.state === "blocked"
                ? t("channels.part.blocked")
                : t("channels.part.failed")}
            </span>
            <Show when={props.part.state === "blocked"}>
              <span class={review.reason} data-testid="part-blocked-reason">
                {reason()}
              </span>
            </Show>
          </span>
          {/* A failed part has its Retry on the row of the error. A client cannot do either. */}
          <Show when={!ui.linked()}>
            <Show when={props.part.state === "blocked"}>
              <Button onClick={props.onRetry} data-testid="part-retry">
                {t("chat.retry")}
              </Button>
            </Show>
            <Show when={props.part.ownerName === null}>
              <Button onClick={props.onEnd} data-testid="part-end-request">
                {t("tasks.endRequest")}
              </Button>
            </Show>
          </Show>
        </div>
      </Show>
    </>
  )
}

export const ChannelView = (props: { channel: Channel }) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const agents = useAgents()
  const messages = createChannelChat(props.channel.id, () =>
    ui.linked() ? ui.server()?.id : undefined,
  )
  const retry = useRetry()
  const [text, setText] = createSignal("")
  /** The message of a part that the user answers. The answer goes to the member of the part. */
  const [replyTo, setReplyTo] = createSignal<ChannelMessage>()
  const [error, setError] = createSignal<ErrorText>()
  const reviewing = useReview(setError)
  const ending = useEndRequest(setError)
  const [atBottom, setAtBottom] = createSignal(true)
  const [flashId, setFlashId] = createSignal<string>()
  const [backTo, setBackTo] = createSignal<number>()
  const openedAt = Date.now()
  let scroller: HTMLDivElement | undefined
  let input: HTMLTextAreaElement | undefined

  const members = () =>
    props.channel.memberIds.flatMap((id) => {
      const a = agents.byId(id)
      return a ? [a] : []
    })
  // The `@` list (spec 004, "Mention"): an `@` before the caret opens a list of the members that
  // can take a job. The list narrows as the user types. Enter or Tab puts `@Name` in the box.
  const [caret, setCaret] = createSignal(0)
  const [highlight, setHighlight] = createSignal(0)
  const [dismissed, setDismissed] = createSignal(false)
  const mention = createMemo(() => openMention(text(), caret()))
  const mentionable = createMemo(() => {
    const open = mention()
    if (!open) return []
    const available = members().filter((a) => !a.archived)
    // `@all` is offered when two or more members can answer (spec 004, "Everyone mention").
    return mentionEntries(available, open.query, available.length >= 2)
  })
  const listOpen = () => !dismissed() && !ui.serverOffline() && mentionable().length > 0
  // A new query starts at the top of the list. Escape holds until the query changes.
  createEffect(
    on(
      () => {
        const open = mention()
        return open ? `${open.start}:${open.query}` : ""
      },
      () => {
        setHighlight(0)
        setDismissed(false)
      },
      { defer: true },
    ),
  )
  const grow = () => {
    if (!input) return
    input.style.height = "auto"
    input.style.height = `${input.scrollHeight}px`
  }
  const pickMention = (entry: MentionEntry<Agent>) => {
    const open = mention()
    if (!open) return
    const name = entry.kind === "all" ? EVERYONE_MENTION : entry.member.name
    const next = insertMention(text(), open, caret(), name)
    setText(next.text)
    setCaret(next.caret)
    queueMicrotask(() => {
      grow()
      input?.focus()
      input?.setSelectionRange(next.caret, next.caret)
    })
  }
  const agentFor = (message: ChannelMessage): Agent =>
    (message.agentId ? agents.byId(message.agentId) : undefined) ??
    removedAgent(t("channels.removedAgent"))
  const asChat = (m: ChannelMessage) => m as unknown as ChatMessage

  const scrollToBottom = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }
  createEffect(
    on(
      () => [messages.messages.length, shapeOf(messages.messages.at(-1))] as const,
      () => atBottom() && queueMicrotask(scrollToBottom),
    ),
  )
  onMount(() => queueMicrotask(scrollToBottom))

  const markRead = () => {
    if (document.hasFocus()) void call("channels.markRead", { channelId: props.channel.id })
  }
  createEffect(
    on(
      () =>
        messages.messages.filter((m) => m.author === "agent" && m.status !== "streaming").length,
      markRead,
    ),
  )
  window.addEventListener("focus", markRead)

  /** Scrolls to a message and flashes it. False when the message is not in the list (yet). */
  const jump = (id: string, fromSearch = false): boolean => {
    const row = scroller?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (!row || !scroller) return false
    // A hit of message search from another place goes back to that place, not to a scroll spot.
    if (!fromSearch) setBackTo(scroller.scrollTop)
    row.scrollIntoView({
      block: "center",
      behavior: document.documentElement.dataset.reduceMotion === "true" ? "auto" : "smooth",
    })
    setFlashId(undefined)
    queueMicrotask(() => setFlashId(id))
    setTimeout(() => setFlashId((cur) => (cur === id ? undefined : cur)), 1300)
    return true
  }

  // A notification or a hit of message search asked for a message: scroll to it when it is in the list.
  const place: PlaceRef = { kind: "channel", id: props.channel.id }
  useFocusMessage(place, jump)

  /** The place that a hit of message search came from, while "Back" can return to it. */
  const origin = () => originFor(place)
  // The way back from a hit ends when the user leaves this place.
  onCleanup(() => {
    if (origin()) setSearchOrigin(undefined)
  })
  const goBack = () => {
    const top = backTo()
    if (top !== undefined) {
      if (scroller) scroller.scrollTop = top
      setBackTo(undefined)
      return
    }
    const from = origin()
    if (from) {
      setSearchOrigin(undefined)
      ui.selectPlace(from.from, from.serverId)
    }
  }

  const act = async (run: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await run()
    } catch (e) {
      setError(describeError(e))
    }
  }
  const send = () => {
    const value = text().trim()
    if (!value) return
    void act(async () => {
      await call("channels.send", {
        channelId: props.channel.id,
        text: value,
        replyTo: replyTo()?.id ?? null,
      })
      setText("")
      setCaret(0)
      setReplyTo(undefined)
      if (input) input.style.height = "auto"
      setAtBottom(true)
      queueMicrotask(scrollToBottom)
    })
  }
  const working = () => props.channel.working

  return (
    <div class={chat.view} data-testid="channel-view">
      <PlaceMarksLine
        place={{ kind: "channel", id: props.channel.id }}
        marks={{
          outside: props.channel.outside ?? null,
          sensitive: props.channel.sensitive ?? null,
        }}
      />
      {retry.dialog()}
      {reviewing.dialog()}
      {ending.dialog()}
      <div
        class={chat.scroller}
        ref={scroller}
        onScroll={() =>
          scroller &&
          setAtBottom(
            scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX,
          )
        }
        data-testid="chat-scroller"
      >
        <div class={chat.list} role="log" aria-label={t("chat.messages")}>
          <div class={styles.start} data-testid="channel-start">
            <h2>#{props.channel.name}</h2>
            <p>{t("channels.start", { name: props.channel.name })}</p>
            <Show when={messages.loaded && messages.messages.length === 0}>
              <p>{t("channels.empty")}</p>
            </Show>
          </div>
          <For each={messages.messages}>
            {(message, index) => {
              const previous = () => messages.messages[index() - 1]
              return (
                <>
                  <Show
                    when={
                      !previous() ||
                      !sameDay((previous() as ChannelMessage).createdAt, message.createdAt)
                    }
                  >
                    <div class={chat.dayLine}>
                      {formatDay(
                        app.locale(),
                        message.createdAt,
                        t("chat.today"),
                        t("chat.yesterday"),
                      )}
                    </div>
                  </Show>
                  <div data-testid="channel-message" data-kind={message.kind}>
                    <MessageRow
                      agent={agentFor(message)}
                      message={asChat(message)}
                      first={
                        startsGroup(
                          previous() as unknown as ChatMessage | undefined,
                          asChat(message),
                        ) ||
                        previous()?.agentId !== message.agentId ||
                        message.kind !== "text"
                      }
                      canEdit={false}
                      flash={flashId() === message.id}
                      enter={message.createdAt >= openedAt}
                      quoted={undefined}
                      onReply={() => {
                        // A reply to a part goes to its member as a new part. A reply to another
                        // message mentions its author.
                        if (message.part) setReplyTo(message)
                        else setText((v) => `${v}@${agentFor(message).name} `)
                        setCaret(text().length)
                        input?.focus()
                      }}
                      onJumpTo={jump}
                      onEdit={async () => {}}
                      onRetry={() => {
                        // A client of a linked server cannot try a part again (spec 012).
                        const id = message.taskId
                        if (!id || ui.linked()) return
                        void retry
                          .start((confirmed) =>
                            call("tasks.retry", { id, ...(confirmed ? { confirmed } : {}) }),
                          )
                          .catch((e) => setError(describeError(e)))
                      }}
                    />
                    <Show when={message.part}>
                      {(part) => (
                        <PartCard
                          part={part()}
                          onAccept={() => void reviewing.accept(part().taskId)}
                          onChanges={() => reviewing.requestChanges(part().taskId)}
                          onRetry={() =>
                            void retry
                              .start((confirmed) =>
                                call("tasks.retry", {
                                  id: part().taskId,
                                  ...(confirmed ? { confirmed } : {}),
                                }),
                              )
                              .catch((e) => setError(describeError(e)))
                          }
                          onEnd={() => ending.start(part().taskId)}
                        />
                      )}
                    </Show>
                    <Show when={message.kind !== "text"}>
                      <div class={styles.kindTag}>
                        {message.kind === "plan" ? t("channels.plan") : t("channels.summary")}
                      </div>
                    </Show>
                    <Show when={message.chips.length > 0}>
                      <div class={styles.chips} data-testid="part-chips">
                        <For each={message.chips}>
                          {(chip) => <Chip chip={chip} onJump={jump} />}
                        </For>
                      </div>
                    </Show>
                    <Show when={message.awaiting}>
                      <div class={styles.pick} data-testid="pick-member">
                        <span>{t("channels.pick")}</span>
                        <For each={members()}>
                          {(a) => (
                            <Button
                              onClick={() =>
                                act(() =>
                                  call("channels.assign", {
                                    channelId: props.channel.id,
                                    messageId: message.id,
                                    agentId: a.id,
                                  }),
                                )
                              }
                              data-testid={`pick-${a.name}`}
                            >
                              {a.name}
                            </Button>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                </>
              )
            }}
          </For>
        </div>
      </div>
      <Show when={backTo() !== undefined || origin() !== undefined}>
        <div class={chat.floating} style={{ bottom: "auto", top: "12px" }}>
          <button type="button" class={chat.floatButton} onClick={goBack} data-testid="jump-back">
            {t("channels.back")}
          </button>
        </div>
      </Show>
      <div class={chat.composer}>
        <Show when={ui.serverOffline()}>
          <div class={chat.composerError} role="status" data-testid="channel-offline">
            {ui.server()?.state === "not_allowed"
              ? t("link.state.not_allowed", { name: ui.server()?.name ?? "" })
              : t("link.state.offline", { name: ui.server()?.name ?? "" })}
          </div>
        </Show>
        <Show when={error()}>
          {(err) => <div class={chat.composerError}>{t(err().key, err().params)}</div>}
        </Show>
        <Show when={replyTo()}>
          {(quoted) => (
            <div class={chat.quote} data-testid="channel-reply-quote">
              <span class={chat.quoteText}>
                {t("chat.replyingTo", { name: agentFor(quoted()).name })}
                {": "}
                {messageText(asChat(quoted())).slice(0, 80)}
              </span>
              <IconButton label={t("chat.cancelReply")} onClick={() => setReplyTo(undefined)}>
                <X size={14} />
              </IconButton>
            </div>
          )}
        </Show>
        <Show when={listOpen()}>
          <MentionList
            label={t("channels.mentions")}
            entries={mentionable()}
            highlight={highlight()}
            onPick={pickMention}
          />
        </Show>
        <div class={chat.box}>
          <textarea
            ref={input}
            class={chat.input}
            rows={1}
            disabled={ui.serverOffline()}
            value={text()}
            placeholder={t("channels.placeholder", { name: props.channel.name })}
            aria-label={t("channels.placeholder", { name: props.channel.name })}
            onInput={(e) => {
              setText(e.currentTarget.value)
              setCaret(e.currentTarget.selectionStart)
              grow()
            }}
            onKeyUp={(e) => setCaret(e.currentTarget.selectionStart)}
            onClick={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (e.isComposing || e.keyCode === 229) return
              if (listOpen()) {
                const list = mentionable()
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault()
                  const step = e.key === "ArrowDown" ? 1 : -1
                  setHighlight((highlight() + step + list.length) % list.length)
                  return
                }
                if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
                  e.preventDefault()
                  const chosen = list[highlight()]
                  if (chosen) pickMention(chosen)
                  return
                }
                if (e.key === "Escape") {
                  e.preventDefault()
                  setDismissed(true)
                  return
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                send()
              } else if (e.key === "Escape" && replyTo()) {
                e.preventDefault()
                setReplyTo(undefined)
              }
            }}
            data-testid="channel-input"
          />
          <Show
            when={working()}
            fallback={
              <button
                type="button"
                class={chat.sendButton}
                aria-label={t("channels.send")}
                disabled={!text().trim() || ui.serverOffline()}
                onClick={send}
                data-testid="channel-send"
              >
                ↑
              </button>
            }
          >
            <button
              type="button"
              class={chat.sendButton}
              data-stop="true"
              aria-label={t("channels.stopAll")}
              title={t("channels.stopAll")}
              onClick={() => act(() => call("channels.stop", { channelId: props.channel.id }))}
              data-testid="channel-stop"
            >
              <Square size={14} />
            </button>
          </Show>
        </div>
      </div>
    </div>
  )
}

export const stateLabel = (state: string) => `channels.state.${state}` as MessageKey
