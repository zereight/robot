import type { ChatMeter, ChatThreads } from "@robot/shared"
import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { isForView, type ViewServer } from "../lib/events.ts"
import { call } from "../lib/rpc.ts"

/** The thread part of a chat request. The main thread sends none, as before threads. */
export const threadPart = (threadId: string | null) => (threadId ? { threadId } : {})

/**
 * The open thread of each agent (spec 003, "Threads"). Null is the main thread. It stays while the
 * user opens other places, and goes back to the main thread when the app starts again.
 */
const [openThreads, setOpenThreads] = createSignal<ReadonlyMap<string, string>>(new Map())

export const openThreadOf = (agentId: string): string | null => openThreads().get(agentId) ?? null

export const openThread = (agentId: string, threadId: string | null | undefined) =>
  setOpenThreads((map) => {
    const next = new Map(map)
    if (threadId) next.set(agentId, threadId)
    else next.delete(agentId)
    return next
  })

/** The threads of one agent, kept in step with the main process. */
export const createThreads = (
  agentId: () => string,
  server: () => ViewServer = () => undefined,
) => {
  const [state, setState] = createStore<{ loaded: boolean; list: ChatThreads }>({
    loaded: false,
    list: { main: { unread: 0, busy: null }, threads: [] },
  })
  let run = 0
  const load = () => {
    const mine = ++run
    const id = agentId()
    call("chat.threads", { agentId: id })
      .then((list) => {
        if (mine !== run) return
        setState("list", reconcile(list, { key: "id" }))
        setState("loaded", true)
      })
      .catch(() => {
        if (mine === run) setState("loaded", true)
      })
  }
  createEffect(on(agentId, load))
  const off = window.robot.on("chat.threads", (event, from) => {
    if (event.agentId === agentId() && isForView(server(), from)) load()
  })
  onCleanup(off)
  // The line of a queued task follows the queue: a task that starts or ends elsewhere changes it.
  onCleanup(
    window.robot.on("tasks.changed", (_event, from) => {
      if (isForView(server(), from)) load()
    }),
  )
  return state
}

/** The context meter of one thread (spec 003, "Context meter"). Undefined until it loads. */
export const createMeter = (
  agentId: () => string,
  threadId: () => string | null,
  server: () => ViewServer = () => undefined,
) => {
  const [meter, setMeter] = createSignal<ChatMeter>()
  let run = 0
  const load = () => {
    const mine = ++run
    call("chat.meter", { agentId: agentId(), threadId: threadId() })
      .then((value) => {
        if (mine === run) setMeter(value)
      })
      .catch(() => {
        if (mine === run) setMeter(undefined)
      })
  }
  createEffect(on([agentId, threadId], load))
  const offMeter = window.robot.on("chat.meter", (event, from) => {
    if (event.agentId === agentId() && event.threadId === threadId() && isForView(server(), from))
      load()
  })
  // A turn of the agent in any thread changes if Compact is on ("The agent is working").
  const offThreads = window.robot.on("chat.threads", (event, from) => {
    if (event.agentId === agentId() && isForView(server(), from)) load()
  })
  onCleanup(() => {
    offMeter()
    offThreads()
  })
  return meter
}
