import { createSignal } from "solid-js"

/**
 * A thing that a page is asked to show: a log opens a task, the profile of an agent opens a task,
 * a workflow or the Tasks page for that agent (`agentTasks`).
 */
export interface OpenTarget {
  readonly kind: "task" | "routine" | "workflow" | "account" | "agentTasks"
  readonly id: string
}

/** The open view takes the target when it shows, then clears it. */
export const [openTarget, setOpenTarget] = createSignal<OpenTarget>()

/** Takes the target of a kind, if there is one. The next view of that kind finds none. */
export const takeTarget = (kind: OpenTarget["kind"] | readonly OpenTarget["kind"][]) => {
  const target = openTarget()
  const kinds = typeof kind === "string" ? [kind] : kind
  if (!target || !kinds.includes(target.kind)) return undefined
  setOpenTarget(undefined)
  return target
}

/** Scrolls a row into view and lights it for a moment (the same cue as a jump to a message). */
export const flashRow = (selector: string) => {
  const el = document.querySelector<HTMLElement>(selector)
  if (!el) return false
  el.scrollIntoView({ block: "nearest" })
  el.dataset.flash = "true"
  setTimeout(() => delete el.dataset.flash, 1200)
  return true
}
