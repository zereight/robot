// A sandboxed preload cannot load packages, so it imports only plain constants and types.
import { EVENT_CHANNEL, INVOKE_CHANNEL, type RobotBridge } from "@robot/shared/ipc"
import { contextBridge, ipcRenderer } from "electron"

const bridge: RobotBridge = {
  invoke: (method, input) => ipcRenderer.invoke(INVOKE_CHANNEL, method, input),
  on: (event, listener) => {
    const handler = (_: unknown, name: string, payload: unknown) => {
      if (name === event) listener(payload as Parameters<typeof listener>[0])
    }
    ipcRenderer.on(EVENT_CHANNEL, handler)
    return () => ipcRenderer.off(EVENT_CHANNEL, handler)
  },
}

contextBridge.exposeInMainWorld("robot", bridge)
