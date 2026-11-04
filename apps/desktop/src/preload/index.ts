// A sandboxed preload cannot load packages, so it imports only plain constants and types.
import {
  EVENT_CHANNEL,
  INVOKE_CHANNEL,
  type RobotBridge,
  SCREEN_INPUT_CHANNEL,
  SCREEN_INPUT_TYPES,
} from "@robot/shared/ipc"
import type { PageInputNote } from "@robot/shared/teachPage"
import { contextBridge, ipcRenderer, webUtils } from "electron"

type Listener = (payload: unknown, server?: string) => void

/**
 * The listeners of each event. One listener on the channel gives each event to them, so that many
 * views can listen without a warning about too many listeners.
 */
const listeners = new Map<string, Set<Listener>>()
ipcRenderer.on(EVENT_CHANNEL, (_: unknown, name: string, payload: unknown, server?: string) => {
  for (const listener of [...(listeners.get(name) ?? [])]) listener(payload, server)
})

const bridge: RobotBridge = {
  invoke: (method, input, server) => ipcRenderer.invoke(INVOKE_CHANNEL, method, input, server),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (event, listener) => {
    const handler = listener as Listener
    const set = listeners.get(event) ?? new Set<Listener>()
    listeners.set(event, set)
    set.add(handler)
    return () => {
      set.delete(handler)
    }
  },
}

contextBridge.exposeInMainWorld("robot", bridge)

// --- The diagnostic report ---------------------------------------------------------------------
// A press that does nothing in the app has two causes that look alike: it never reaches the
// document, or the screen does not act on it. The main process counts what the window gives to the
// screen. This counts what the document gets, so the report can tell the two apart. It only
// listens: it never stops an event and never reads text. It sends the kind of event, a place, the
// tag and the test id of the target.
// `import type` above is erased: this sandboxed preload loads no other module.
const noteOf = (type: string, event: Event): PageInputNote => {
  const touches = "touches" in event ? (event.touches as ArrayLike<Touch>) : undefined
  const point = touches?.[0] ?? (event as MouseEvent)
  const el = event.target instanceof Element ? event.target : undefined
  const target = el?.closest("[data-testid]")?.getAttribute("data-testid") ?? ""
  return {
    type,
    pointer: "pointerType" in event ? String(event.pointerType) : "touches" in event ? "touch" : "",
    trusted: event.isTrusted,
    tag: el ? el.tagName.toLowerCase() : "",
    ...(target ? { target } : {}),
    x: Math.round(point.clientX ?? 0),
    y: Math.round(point.clientY ?? 0),
    width: window.innerWidth,
    height: window.innerHeight,
  }
}

for (const type of SCREEN_INPUT_TYPES) {
  window.addEventListener(
    type,
    (event) => {
      try {
        ipcRenderer.send(SCREEN_INPUT_CHANNEL, noteOf(type, event))
      } catch {
        // A report that fails must never break the screen.
      }
    },
    { capture: true, passive: true },
  )
}
