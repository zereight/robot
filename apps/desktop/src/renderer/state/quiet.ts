import {
  type QuietShown,
  type QuietState,
  type QuietTurn,
  quietOfChat,
  quietOfTask,
  quietShown,
} from "@robot/shared"
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js"

/**
 * The turns that are quiet now (spec 005, "Quiet line"), by server. The main process pushes the
 * start and the end of a quiet turn with the seconds on its quiet clock; the window counts on
 * from there, once each second. Nothing is stored: after a restart no turn is quiet.
 */

interface Held {
  readonly turns: readonly QuietTurn[]
  /** When the window got the state, in ms: the seconds count on from here. */
  readonly receivedAt: number
}

/** The key of this computer. A linked server has its own id. */
const LOCAL = ""

const [held, setHeld] = createSignal<ReadonlyMap<string, Held>>(new Map())
const [now, setNow] = createSignal(Date.now())
let started = false

const put = (server: string | undefined, state: QuietState) => {
  const next = new Map(held())
  const key = server ?? LOCAL
  if (state.turns.length === 0) next.delete(key)
  else next.set(key, { turns: state.turns, receivedAt: Date.now() })
  setHeld(next)
}

/** Listens once. The window of the app calls it at start; a view that reads the state does too. */
export const startQuiet = () => {
  if (started || typeof window === "undefined" || !window.robot) return
  started = true
  createRoot(() => {
    // Listen first, then read once: a state that was pushed meanwhile is newer than the read.
    let pushed = false
    window.robot.on("quiet.changed", (state, server) => {
      if (server === undefined) pushed = true
      put(server, state)
    })
    void window.robot
      .invoke("quiet.list", undefined, undefined)
      .then((result) => {
        if (result.ok && !pushed) put(undefined, result.value)
      })
      .catch(() => {})
    // One timer for the whole window, and only while some turn is quiet.
    createEffect(() => {
      if (held().size === 0) return
      setNow(Date.now())
      const timer = setInterval(() => setNow(Date.now()), 1000)
      onCleanup(() => clearInterval(timer))
    })
  })
}

const shown = (
  server: string | undefined,
  find: (turns: readonly QuietTurn[]) => QuietTurn | undefined,
) => {
  startQuiet()
  const entry = held().get(server ?? LOCAL)
  const turn = entry && find(entry.turns)
  return entry && turn ? quietShown(turn, entry.receivedAt, now()) : undefined
}

/**
 * The quiet line of the working line of a chat: the turn of this agent in this thread (null is
 * the main thread). `server` is the linked server on screen, or undefined for this computer.
 * Reactive: a view that calls it in a tracked scope follows the start, the end and each second.
 */
export const quietOfChatLine = (
  server: string | undefined,
  agentId: string,
  threadId: string | null,
): QuietShown | undefined => shown(server, (turns) => quietOfChat(turns, agentId, threadId))

/** The quiet line of the turn of one task: a plan step, a row of the Tasks page, a workflow step. */
export const quietOfTaskLine = (
  server: string | undefined,
  taskId: string | null | undefined,
): QuietShown | undefined =>
  taskId ? shown(server, (turns) => quietOfTask(turns, taskId)) : undefined
