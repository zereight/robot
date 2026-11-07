import type { WorkflowChatHistory, WorkflowChatMessage } from "@robot/shared"
import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { call } from "../lib/rpc.ts"

/** The messages of a chat, in the order they show: by time, then by arrival. */
export const upsertMessage = (
  list: readonly WorkflowChatMessage[],
  message: WorkflowChatMessage,
): WorkflowChatMessage[] => {
  const at = list.findIndex((m) => m.id === message.id)
  if (at >= 0) return list.map((m, i) => (i === at ? message : m))
  const next = [...list, message]
  // Array.sort is stable, so messages with the same time keep the order they came in.
  return next.sort((a, b) => a.createdAt - b.createdAt)
}

/**
 * The history of the chat of a workflow. It reads the history again when the queue, the notice or
 * the working state changes, and takes each message that the main process pushes while a reply
 * streams (spec 003).
 */
export const createChatState = (workflowId: () => string) => {
  const [history, setHistory] = createStore<{ value: WorkflowChatHistory | undefined }>({
    value: undefined,
  })
  const [error, setError] = createSignal(false)
  const load = async (id: string) => {
    try {
      const next = await call("chat.history", { workflowId: id })
      if (id === workflowId()) setHistory("value", reconcile(next, { key: "id" }))
      setError(false)
    } catch {
      setError(true)
    }
  }
  createEffect(
    on(workflowId, (id) => {
      setHistory("value", undefined)
      void load(id)
    }),
  )
  onCleanup(
    window.robot.on("chat.message", (payload) => {
      if (payload.workflowId !== workflowId()) return
      setHistory("value", (h) =>
        h ? { ...h, messages: upsertMessage(h.messages, payload.message) } : h,
      )
    }),
  )
  onCleanup(
    window.robot.on("chat.state", (payload) => {
      if (payload.workflowId === workflowId()) void load(workflowId())
    }),
  )
  // A provider that was connected or disconnected changes whether the box can send.
  onCleanup(window.robot.on("providers.changed", () => void load(workflowId())))
  return { history: () => history.value, error, reload: () => load(workflowId()) }
}
