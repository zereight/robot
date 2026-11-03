// A sandboxed preload cannot load packages, so it imports only plain constants and types.
import { EVENT_CHANNEL, INVOKE_CHANNEL, type RobotBridge } from "@robot/shared/ipc"
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
