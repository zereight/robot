import { type Agent, type ChatMessage, sameDay, startsGroup } from "@robot/shared"
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { focusMessage, setFocusMessage } from "../state/focus.ts"
import { Composer } from "./Composer.tsx"
import styles from "./chat.module.css"
import { formatDay, formatElapsed } from "./format.ts"
import { MessageRow } from "./MessageRow.tsx"
import { createChat } from "./state.ts"

export interface ChatViewProps {
  agent: Agent
  /** The first screen of the chat: face, name and role. */
  start: JSX.Element
  onConnect: () => void
  onChooseModel: () => void
}

const NEAR_BOTTOM_PX = 48

const WorkingLine = (props: { since: number }) => {
  const { t } = useApp()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return (
    <div class={styles.working} data-testid="working-line" aria-live="polite">
      <span class={styles.pulse} />
      <span>{t("chat.working")}</span>
      <span>{formatElapsed(now() - props.since)}</span>
    </div>
  )
}

export const ChatView = (props: ChatViewProps) => {
  const app = useApp()
  const { t } = app
  const chat = createChat(props.agent.id)
  const [replyTo, setReplyTo] = createSignal<ChatMessage>()
  const [atBottom, setAtBottom] = createSignal(true)
  const [flashId, setFlashId] = createSignal<string>()
  // Messages made after the chat opened rise in; history stays still.
  const openedAt = Date.now()
  const [backTo, setBackTo] = createSignal<number>()
  let scroller: HTMLDivElement | undefined

  const byId = createMemo(() => new Map(chat.messages.map((m) => [m.id, m])))
  const streaming = () => chat.messages.find((m) => m.status === "streaming")
  const working = () => props.agent.state === "working" || streaming() !== undefined
  const lastUserId = createMemo(
    () => [...chat.messages].reverse().find((m) => m.author === "user")?.id,
  )

  const scrollToBottom = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }
  const onScroll = () => {
    if (!scroller) return
    setAtBottom(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < NEAR_BOTTOM_PX)
  }

  // Follow new content while the user is at the bottom. Scrolling up stops it.
  createEffect(
    on(
      () => [chat.messages.length, chat.messages.at(-1)?.parts, working()] as const,
      () => {
        if (atBottom()) queueMicrotask(scrollToBottom)
      },
    ),
  )
  onMount(() => queueMicrotask(scrollToBottom))

  // Mark the chat read while it is open and the window has focus.
  const markRead = () => {
    if (document.hasFocus()) void call("chat.markRead", { agentId: props.agent.id })
  }
  createEffect(
    on(
      () => chat.messages.filter((m) => m.author === "agent" && m.status !== "streaming").length,
      () => markRead(),
    ),
  )
  window.addEventListener("focus", markRead)
  onCleanup(() => window.removeEventListener("focus", markRead))

  const jumpTo = (messageId: string) => {
    const row = scroller?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
    if (!row || !scroller) return
    setBackTo(scroller.scrollTop)
    row.scrollIntoView({
      block: "center",
      behavior: document.documentElement.dataset.reduceMotion === "true" ? "auto" : "smooth",
    })
    setFlashId(undefined)
    queueMicrotask(() => setFlashId(messageId))
    setTimeout(() => setFlashId((id) => (id === messageId ? undefined : id)), 1300)
  }
  // A notification asked for a message: scroll to it when it is in the list.
  createEffect(() => {
    const id = focusMessage()
    if (!id) return
    setTimeout(() => {
      jumpTo(id)
      setFocusMessage(undefined)
    }, 120)
  })

  const goBack = () => {
    const top = backTo()
    if (scroller && top !== undefined) scroller.scrollTop = top
    setBackTo(undefined)
  }

  return (
    <div class={styles.view} data-testid="chat-view">
      <div class={styles.scroller} ref={scroller} onScroll={onScroll} data-testid="chat-scroller">
        <div class={styles.list} role="log" aria-label={t("chat.messages")}>
          {props.start}
          <For each={chat.messages}>
            {(message, index) => {
              const previous = () => chat.messages[index() - 1]
              return (
                <>
                  <Show
                    when={
                      !previous() ||
                      !sameDay((previous() as ChatMessage).createdAt, message.createdAt)
                    }
                  >
                    <div class={styles.dayLine} data-testid="day-line">
                      {formatDay(
                        app.locale(),
                        message.createdAt,
                        t("chat.today"),
                        t("chat.yesterday"),
                      )}
                    </div>
                  </Show>
                  <MessageRow
                    agent={props.agent}
                    message={message}
                    first={startsGroup(previous(), message)}
                    canEdit={message.id === lastUserId() && !working()}
                    flash={flashId() === message.id}
                    enter={message.createdAt >= openedAt}
                    quoted={message.replyTo ? byId().get(message.replyTo) : undefined}
                    onReply={() => setReplyTo(message)}
                    onJumpTo={jumpTo}
                    onEdit={(text) =>
                      call("chat.edit", { agentId: props.agent.id, messageId: message.id, text })
                    }
                    onRetry={() =>
                      void call("chat.retry", { agentId: props.agent.id, messageId: message.id })
                    }
                  />
                </>
              )
            }}
          </For>
          <Show when={working()}>
            <WorkingLine since={streaming()?.createdAt ?? Date.now()} />
          </Show>
        </div>
      </div>
      <Show when={!atBottom() || backTo() !== undefined}>
        <div class={styles.floating} style={{ bottom: "auto", top: "12px" }}>
          <Show when={backTo() !== undefined}>
            <button
              type="button"
              class={styles.floatButton}
              onClick={goBack}
              data-testid="jump-back"
            >
              {t("chat.back")}
            </button>
          </Show>
          <Show when={!atBottom()}>
            <button
              type="button"
              class={styles.floatButton}
              onClick={() => {
                setBackTo(undefined)
                scrollToBottom()
              }}
              data-testid="jump-latest"
            >
              {t("chat.jumpLatest")}
            </button>
          </Show>
        </div>
      </Show>
      <Composer
        agent={props.agent}
        working={working()}
        queue={chat.queue}
        hold={chat.hold}
        replyTo={replyTo()}
        onCancelReply={() => setReplyTo(undefined)}
        onSent={() => {
          setAtBottom(true)
          queueMicrotask(scrollToBottom)
        }}
        onConnect={props.onConnect}
        onChooseModel={props.onChooseModel}
      />
    </div>
  )
}
