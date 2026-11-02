import {
  type Agent,
  type Channel,
  type ChannelMessage,
  type ChatMessage,
  type MessageKey,
  type PartChip,
  sameDay,
  startsGroup,
} from "@robot/shared"
import { Settings2, Square } from "lucide-solid"
import { createEffect, createSignal, For, on, onMount, Show } from "solid-js"
import { Face } from "../agents/Face.tsx"
import chat from "../chat/chat.module.css"
import { formatDay } from "../chat/format.ts"
import { MessageRow } from "../chat/MessageRow.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { focusMessage, setFocusMessage } from "../state/focus.ts"
import { useUi } from "../state/ui.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import { Presence } from "../ui/Presence.tsx"
import { ChannelDialog } from "./ChannelDialog.tsx"
import styles from "./channels.module.css"
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
  archived: true,
  state: "offline",
  permission: "ask_risky",
  memoryEnabled: false,
  createdAt: 0,
  changedBy: null,
})

export const ChannelHeader = (props: { channel: Channel }) => {
  const { t } = useApp()
  const ui = useUi()
  const [open, setOpen] = createSignal(false)
  return (
    <>
      <span class={styles.hash} aria-hidden="true">
        #
      </span>
      <span class={styles.headerName} data-testid="channel-header-name">
        {props.channel.name}
      </span>
      <Show when={props.channel.topic}>
        <span class={styles.divider} aria-hidden="true" />
        <span class={styles.topic} title={props.channel.topic} data-testid="channel-header-topic">
          {props.channel.topic}
        </span>
      </Show>
      <Show when={!ui.linked()}>
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

export const ChannelView = (props: { channel: Channel }) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const agents = useAgents()
  const messages = createChannelChat(props.channel.id)
  const [text, setText] = createSignal("")
  const [error, setError] = createSignal<ErrorText>()
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
  const agentFor = (message: ChannelMessage): Agent =>
    (message.agentId ? agents.byId(message.agentId) : undefined) ??
    removedAgent(t("channels.removedAgent"))
  const asChat = (m: ChannelMessage) => m as unknown as ChatMessage

  const scrollToBottom = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }
  createEffect(
    on(
      () => [messages.messages.length, messages.messages.at(-1)?.parts] as const,
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

  const jump = (id: string) => {
    const row = scroller?.querySelector<HTMLElement>(`[data-message-id="${id}"]`)
    if (!row || !scroller) return
    setBackTo(scroller.scrollTop)
    row.scrollIntoView({
      block: "center",
      behavior: document.documentElement.dataset.reduceMotion === "true" ? "auto" : "smooth",
    })
    setFlashId(undefined)
    queueMicrotask(() => setFlashId(id))
    setTimeout(() => setFlashId((cur) => (cur === id ? undefined : cur)), 1300)
  }

  // A notification asked for a message: scroll to it when it is in the list.
  createEffect(() => {
    const id = focusMessage()
    if (!id) return
    setTimeout(() => {
      jump(id)
      setFocusMessage(undefined)
    }, 120)
  })

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
      await call("channels.send", { channelId: props.channel.id, text: value })
      setText("")
      if (input) input.style.height = "auto"
      setAtBottom(true)
      queueMicrotask(scrollToBottom)
    })
  }
  const working = () => props.channel.working

  return (
    <div class={chat.view} data-testid="channel-view">
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
          <div class={chat.start} data-testid="channel-start">
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
                        setText((v) => `${v}@${agentFor(message).name} `)
                        input?.focus()
                      }}
                      onJumpTo={jump}
                      onEdit={async () => {}}
                      onRetry={() => {}}
                    />
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
      <Show when={backTo() !== undefined}>
        <div class={chat.floating} style={{ bottom: "auto", top: "12px" }}>
          <button
            type="button"
            class={chat.floatButton}
            onClick={() => {
              const top = backTo()
              if (scroller && top !== undefined) scroller.scrollTop = top
              setBackTo(undefined)
            }}
            data-testid="jump-back"
          >
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
              e.currentTarget.style.height = "auto"
              e.currentTarget.style.height = `${e.currentTarget.scrollHeight}px`
            }}
            onKeyDown={(e) => {
              if (e.isComposing || e.keyCode === 229) return
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                send()
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
