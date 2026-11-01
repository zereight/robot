import type { ChatMessage, QueuedMessage } from "@robot/shared"
import { onCleanup } from "solid-js"
import { createStore, produce, reconcile } from "solid-js/store"
import { call } from "../lib/rpc.ts"

export interface ChatState {
  loaded: boolean
  messages: ChatMessage[]
  queue: QueuedMessage[]
}

/** The messages and queue of one direct chat, kept in step with the main process. */
export const createChat = (agentId: string) => {
  const [state, setState] = createStore<ChatState>({ loaded: false, messages: [], queue: [] })

  const upsert = (message: ChatMessage) =>
    setState(
      "messages",
      produce((list) => {
        const index = list.findIndex((m) => m.id === message.id)
        if (index >= 0) list[index] = message
        else list.push(message)
      }),
    )

  const offMessage = window.robot.on("chat.message", (message) => {
    if (message.agentId === agentId) upsert(message)
  })
  const offRemoved = window.robot.on("chat.removed", (event) => {
    if (event.agentId === agentId)
      setState("messages", (list) => list.filter((m) => m.id !== event.messageId))
  })
  const offQueue = window.robot.on("chat.queue", (event) => {
    if (event.agentId === agentId) setState("queue", reconcile([...event.queue]))
  })
  onCleanup(() => {
    offMessage()
    offRemoved()
    offQueue()
  })

  void call("chat.history", { agentId }).then((history) => {
    setState({ loaded: true, messages: [...history.messages], queue: [...history.queue] })
  })

  return state
}
