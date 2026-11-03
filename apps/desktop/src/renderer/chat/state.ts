import type { ChatMessage, CutNotice, QueuedMessage, QueueHold } from "@robot/shared"
import { createEffect, on, onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { isForView, type ViewServer } from "../lib/events.ts"
import { placeMessage } from "../lib/order.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
import { linkEpoch } from "../state/link.ts"

export interface ChatState {
  loaded: boolean
  messages: ChatMessage[]
  queue: QueuedMessage[]
  /** Set when the program of the agent takes no input during a turn (spec 003). */
  hold: QueueHold | null
  /** The request that a restart cut off, when the user has not written since (spec 003). */
  cut: CutNotice | null
}

/**
 * The messages and queue of one direct chat, kept in step with the main process. `server` is the
 * server that the view shows (see `isForView`).
 */
export const createChat = (
  agentId: string,
  server: () => ViewServer = () => undefined,
  threadId: () => string | null = () => null,
) => {
  const [state, setState] = createStore<ChatState>({
    loaded: false,
    messages: [],
    queue: [],
    hold: null,
    cut: null,
  })

  // A message that is there is updated field by field, not replaced. The row and the parts of a
  // reply that streams then stay, and only the text that grew is drawn again. A new message goes
  // to the place that its time says.
  const upsert = (message: ChatMessage) => {
    const index = state.messages.findIndex((m) => m.id === message.id)
    if (index >= 0) setState("messages", index, reconcile(message, { key: "id", merge: true }))
    else
      setState(
        "messages",
        produce((list) => placeMessage(list, message)),
      )
  }

  const mine = (id: string, from: ViewServer) => id === agentId && isForView(server(), from)
  /** True for an event of the thread that the view shows (spec 003, "Threads"). */
  const ofThread = (id: string | null | undefined) => (id ?? null) === threadId()
  const offMessage = window.robot.on("chat.message", (message, from) => {
    if (mine(message.agentId, from) && ofThread(message.threadId)) upsert(message)
  })
  const offRemoved = window.robot.on("chat.removed", (event, from) => {
    if (mine(event.agentId, from))
      setState("messages", (list) => list.filter((m) => m.id !== event.messageId))
  })
  const offQueue = window.robot.on("chat.queue", (event, from) => {
    if (!mine(event.agentId, from) || !ofThread(event.threadId)) return
    setState("queue", reconcile([...event.queue]))
    setState("hold", event.hold ?? null)
  })
  onCleanup(() => {
    offMessage()
    offRemoved()
    offQueue()
  })

  let run = 0
  const load = () => {
    const ticket = ++run
    const thread = threadId()
    return (
      call("chat.history", thread ? { agentId, threadId: thread } : { agentId })
        .then((history) => {
          if (ticket !== run) return
          setState({
            loaded: true,
            messages: [...history.messages],
            queue: [...history.queue],
            hold: history.hold ?? null,
            cut: history.cut ?? null,
          })
        })
        // A linked server that is offline and has nothing saved: the view stays empty. One that
        // removed this device takes its messages from the view too (spec 012).
        .catch((error) => {
          if (ticket !== run) return
          setState(
            error instanceof RpcFailure && error.error.code === "not_allowed"
              ? { loaded: true, messages: [], queue: [], hold: null, cut: null }
              : { loaded: true },
          )
        })
    )
  }
  // Another thread opens with its own messages and queue.
  createEffect(
    on(threadId, () => {
      setState({ loaded: false, messages: [], queue: [], hold: null, cut: null })
      void load()
    }),
  )
  // A linked server that came back: read what happened while it was away.
  createEffect(on(linkEpoch.value, () => void load(), { defer: true }))

  return state
}
