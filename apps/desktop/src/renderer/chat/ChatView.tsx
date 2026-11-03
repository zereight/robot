import {
  type Agent,
  behindWords,
  type ChatMessage,
  canAddThread,
  type PlaceRef,
  type QueuedLine,
  sameDay,
  startsGroup,
} from "@robot/shared"
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
import { AgentChecklist } from "../imports/ImportChecklist.tsx"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useRetry } from "../retry/RetryNote.tsx"
import { useApp } from "../state/app.tsx"
import { originFor, setSearchOrigin, useFocusMessage } from "../state/focus.ts"
import { useUi } from "../state/ui.tsx"
import { showToast } from "../ui/toast.ts"
import { Composer } from "./Composer.tsx"
import styles from "./chat.module.css"
import { formatDay, formatElapsed } from "./format.ts"
import { MessageRow } from "./MessageRow.tsx"
import { RestartNotice } from "./RestartNotice.tsx"
import { shapeOf } from "./shape.ts"
import { createChat } from "./state.ts"
import { createMeter, createThreads, openThread, threadPart } from "./threads.ts"

export interface ChatViewProps {
  agent: Agent
  /** The open thread (spec 003, "Threads"). Null is the main thread. */
  threadId: string | null
  /** The first screen of the chat: face, name and role. */
  start: JSX.Element
  onConnect: () => void
  onChooseModel: () => void
  /** Shows at the end of the list, after the messages, for example a draft skill card. */
  end?: JSX.Element
}

const NEAR_BOTTOM_PX = 48

const WorkingLine = (props: { since: number; compacting: boolean }) => {
  const { t } = useApp()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  return (
    <div class={styles.working} data-testid="working-line" aria-live="polite">
      <span class={styles.pulse} />
      <span>{props.compacting ? t("chat.compacting") : t("chat.working")}</span>
      <span>{formatElapsed(now() - props.since)}</span>
    </div>
  )
}

/**
 * The line of the task of this thread that waits in the queue (spec 003, 005): what it waits
 * behind, and "Run next". A linked computer and the phone have no "Run next" (011, 012).
 */
const QueuedTaskLine = (props: { line: QueuedLine; canRunNext: boolean }) => {
  const { t } = useApp()
  const words = () => (props.line.behind ? behindWords(props.line.behind) : undefined)
  return (
    <div class={styles.working} data-testid="queued-task-line">
      <span data-testid="queued-task-behind">
        {words()
          ? t(words()?.key ?? "tasks.state.queued", words()?.params)
          : t("tasks.state.queued")}
      </span>
      <Show when={props.canRunNext}>
        <button
          type="button"
          class={styles.lineButton}
          onClick={() =>
            void call("tasks.runNext", { id: props.line.taskId }).catch((e: unknown) => {
              const error = describeError(e)
              showToast("error", error.key, error.params)
            })
          }
          data-testid="queued-run-next"
        >
          {t("tasks.runNext")}
        </button>
      </Show>
    </div>
  )
}

export const ChatView = (props: ChatViewProps) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const server = () => (ui.linked() ? ui.server()?.id : undefined)
  const chat = createChat(props.agent.id, server, () => props.threadId)
  // A linked computer and the phone have the main thread only, and no meter (spec 011, 012).
  const threads = createThreads(() => props.agent.id, server)
  const meter = createMeter(
    () => props.agent.id,
    () => props.threadId,
    server,
  )
  const compacting = () => meter()?.compacting === true
  const archived = () =>
    props.threadId !== null &&
    threads.list.threads.find((x) => x.id === props.threadId)?.archivedAt != null
  /** What the open thread does now, or undefined when it is not known (a linked server). */
  const busy = () => {
    if (ui.linked() || !threads.loaded) return undefined
    return props.threadId === null
      ? threads.list.main.busy
      : (threads.list.threads.find((x) => x.id === props.threadId)?.busy ?? null)
  }
  /** The queued task of the open thread, while no turn runs in it. */
  const queuedLine = () => {
    if (busy() !== "queued") return undefined
    return props.threadId === null
      ? (threads.list.main.queued ?? undefined)
      : (threads.list.threads.find((x) => x.id === props.threadId)?.queued ?? undefined)
  }
  const place: PlaceRef = { kind: "agent", id: props.agent.id }
  const [replyTo, setReplyTo] = createSignal<ChatMessage>()
  const [atBottom, setAtBottom] = createSignal(true)
  const [flashId, setFlashId] = createSignal<string>()
  // Messages made after the chat opened rise in; history stays still.
  const openedAt = Date.now()
  const [backTo, setBackTo] = createSignal<number>()
  let scroller: HTMLDivElement | undefined

  const byId = createMemo(() => new Map(chat.messages.map((m) => [m.id, m])))
  const streaming = () => chat.messages.find((m) => m.status === "streaming")
  const retry = useRetry()
  // A memo, so that a new list of threads or a new meter with the same answer does not count as new
  // content and scroll the chat away from a message that the user jumped to.
  const working = createMemo(() => {
    if (compacting()) return true
    // A task that waits in the queue has an empty reply already: it shows its queued line.
    if (busy() === "queued") return false
    if (streaming() !== undefined) return true
    const now = busy()
    return now === undefined ? props.agent.state === "working" : now === "turn"
  })
  /** Fork at a finished message (spec 003, "Fork"). The new thread opens. */
  const fork = async (message: ChatMessage) => {
    try {
      const made = await call("chat.thread.fork", {
        agentId: props.agent.id,
        ...threadPart(props.threadId),
        messageId: message.id,
      })
      openThread(props.agent.id, made.id)
    } catch (e) {
      const error = describeError(e)
      showToast("error", error.key, error.params)
    }
  }
  const forkOff = () => (canAddThread(threads.list.threads.length) ? undefined : t("threads.limit"))
  /** The notice of a request that a restart cut off. It leaves when the user writes. */
  const cutNotice = () => {
    const cut = chat.cut
    return cut && chat.messages.at(-1)?.id === cut.messageId && !working() ? cut : undefined
  }
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
      () => [chat.messages.length, shapeOf(chat.messages.at(-1)), working()] as const,
      () => {
        if (atBottom()) queueMicrotask(scrollToBottom)
      },
    ),
  )
  onMount(() => queueMicrotask(scrollToBottom))

  // Mark the chat read while it is open and the window has focus.
  const markRead = () => {
    if (document.hasFocus())
      void call("chat.markRead", { agentId: props.agent.id, ...threadPart(props.threadId) })
  }
  createEffect(
    on(
      () => chat.messages.filter((m) => m.author === "agent" && m.status !== "streaming").length,
      () => markRead(),
    ),
  )
  window.addEventListener("focus", markRead)
  onCleanup(() => window.removeEventListener("focus", markRead))

  /** Scrolls to a message and flashes it. False when the message is not in the list (yet). */
  const jumpTo = (messageId: string, fromSearch = false): boolean => {
    const row = scroller?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`)
    if (!row || !scroller) return false
    // A hit of message search from another place goes back to that place, not to a scroll spot.
    if (!fromSearch) setBackTo(scroller.scrollTop)
    // The chat no longer follows new content; the scroll event sets this again.
    setAtBottom(false)
    row.scrollIntoView({
      block: "center",
      behavior: document.documentElement.dataset.reduceMotion === "true" ? "auto" : "smooth",
    })
    setFlashId(undefined)
    queueMicrotask(() => setFlashId(messageId))
    setTimeout(() => setFlashId((id) => (id === messageId ? undefined : id)), 1300)
    return true
  }
  // A notification or a hit of message search asked for a message: scroll to it when it is in the list.
  useFocusMessage(place, jumpTo)

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

  return (
    <div class={styles.view} data-testid="chat-view">
      {retry.dialog()}
      <div class={styles.scroller} ref={scroller} onScroll={onScroll} data-testid="chat-scroller">
        <div class={styles.list} role="log" aria-label={t("chat.messages")}>
          {props.start}
          <AgentChecklist agentId={props.agent.id} />
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
                    onFork={
                      ui.linked() || message.status === "streaming"
                        ? undefined
                        : () => void fork(message)
                    }
                    forkOff={forkOff()}
                    onEdit={(text) =>
                      call("chat.edit", { agentId: props.agent.id, messageId: message.id, text })
                    }
                    onRetry={() =>
                      void retry.start((confirmed) =>
                        call("chat.retry", {
                          agentId: props.agent.id,
                          messageId: message.id,
                          ...(confirmed ? { confirmed } : {}),
                        }),
                      )
                    }
                  />
                </>
              )
            }}
          </For>
          <Show when={working()}>
            <WorkingLine since={streaming()?.createdAt ?? Date.now()} compacting={compacting()} />
          </Show>
          <Show when={!working() && queuedLine()}>
            {(line) => <QueuedTaskLine line={line()} canRunNext={!ui.linked()} />}
          </Show>
          {props.end}
        </div>
      </div>
      <Show when={!atBottom() || backTo() !== undefined || origin() !== undefined}>
        <div class={styles.floating} style={{ bottom: "auto", top: "12px" }}>
          <Show when={backTo() !== undefined || origin() !== undefined}>
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
      <Show when={cutNotice()}>
        {(cut) => <RestartNotice agentId={props.agent.id} threadId={props.threadId} cut={cut()} />}
      </Show>
      {/* An archived thread takes no message until the user restores it (spec 003). */}
      <Show
        when={!archived()}
        fallback={
          <div class={styles.blocked} data-testid="thread-archived">
            {t("threads.archivedNote")}
          </div>
        }
      >
        <Composer
          agent={props.agent}
          threadId={props.threadId}
          working={working() || busy() === "queued"}
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
      </Show>
    </div>
  )
}
