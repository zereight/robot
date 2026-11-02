import type { MessageKey, MessageParams } from "@robot/shared"
import { createRoot, createSignal } from "solid-js"

export type ToastTone = "success" | "error"

export interface Toast {
  readonly id: number
  readonly tone: ToastTone
  readonly key: MessageKey
  readonly params?: MessageParams | undefined
}

/** How long a toast stays. An error stays longer, because the user needs time to read it. */
export const TOAST_MS: Record<ToastTone, number> = { success: 3000, error: 6000 }

/** Most toasts on screen at once. A new toast pushes the oldest one out. */
export const TOAST_MAX = 3

let nextId = 0

const store = createRoot(() => {
  const [toasts, setToasts] = createSignal<readonly Toast[]>([])
  return { toasts, setToasts }
})
const timers = new Map<number, ReturnType<typeof setTimeout>>()

export const toasts = store.toasts

export const dismissToast = (id: number) => {
  clearTimeout(timers.get(id))
  timers.delete(id)
  store.setToasts((all) => all.filter((t) => t.id !== id))
}

/** Shows a toast with a translated text. It goes away by itself. */
export const showToast = (tone: ToastTone, key: MessageKey, params?: MessageParams): number => {
  const id = ++nextId
  const next: Toast = { id, tone, key, params }
  const all = [...store.toasts(), next]
  for (const old of all.slice(0, Math.max(0, all.length - TOAST_MAX))) dismissToast(old.id)
  store.setToasts(all.slice(-TOAST_MAX))
  timers.set(
    id,
    setTimeout(() => dismissToast(id), TOAST_MS[tone]),
  )
  return id
}

/** Removes every toast. For tests. */
export const clearToasts = () => {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  store.setToasts([])
}
