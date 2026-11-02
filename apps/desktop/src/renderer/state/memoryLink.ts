import { createSignal } from "solid-js"

export type MemoryTab = "items" | "proposals" | "history"

/** A request to open the memory page of an agent on one of its tabs (spec 008). */
export interface MemoryTarget {
  readonly agentId: string
  readonly tab: MemoryTab
}

const [target, setTarget] = createSignal<MemoryTarget>()

/** The request that waits. The profile of the agent opens, and the memory panel reads it once. */
export const memoryTarget = target

/** The line "Suggested for memory" in the chat opens the tab Proposals through this. */
export const openMemory = (agentId: string, tab: MemoryTab) => setTarget({ agentId, tab })

export const clearMemoryTarget = () => setTarget(undefined)
