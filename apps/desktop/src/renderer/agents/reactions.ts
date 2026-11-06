import type { ChatMessage } from "@robot/shared"
import { createStore } from "solid-js/store"

/** What a face does once: a reply ended, a reply failed, or the agent waits for the user. */
export type Reaction = "done" | "failed" | "ask"

/** The newest reaction of each agent. `n` grows with every reaction, so faces can listen for it. */
const [reactions, setReactions] = createStore<Record<string, { kind: Reaction; n: number }>>({})

export { reactions }

const react = (agentId: string, kind: Reaction) =>
  setReactions(agentId, (previous) => ({ kind, n: (previous?.n ?? 0) + 1 }))

// A new agent shows itself to the user once, when its first faces appear.
const born = new Map<string, number>()
const BORN_WINDOW_MS = 2000
export const markBorn = (agentId: string) => born.set(agentId, Date.now())
export const bornRecently = (agentId: string) =>
  Date.now() - (born.get(agentId) ?? Number.NEGATIVE_INFINITY) < BORN_WINDOW_MS

interface Seen {
  readonly status: string
  readonly waiting: boolean
}
const seen = new Map<string, Seen>()
const SEEN_LIMIT = 500
const FRESH_MS = 3000

/** Reads one message event and turns an end of work into a reaction. */
export const observe = (
  message: Pick<ChatMessage, "id" | "status" | "parts" | "createdAt">,
  agentId: string,
  now = Date.now(),
) => {
  const current: Seen = {
    status: message.status,
    waiting: message.parts.some((p) => p.kind === "tool" && p.state === "waiting"),
  }
  const previous = seen.get(message.id)
  seen.set(message.id, current)
  if (seen.size > SEEN_LIMIT) {
    const oldest = seen.keys().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  // A message that this session never saw while it was young is history, not news.
  const fresh = now - message.createdAt < FRESH_MS
  if (previous === undefined && !fresh) return
  if (current.waiting && !previous?.waiting) react(agentId, "ask")
  else if (current.status === "failed" && previous?.status !== "failed") react(agentId, "failed")
  else if (
    current.status === "done" &&
    (previous?.status === "streaming" || previous === undefined)
  )
    react(agentId, "done")
}

/** Listens to every chat message of the app. Returns the function that stops it. */
export const watchReactions = (): (() => void) => {
  const offChat = window.robot.on("chat.message", (message: ChatMessage) => {
    if (message.author === "agent") observe(message, message.agentId)
  })
  return offChat
}
