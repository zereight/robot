// A sandboxed preload cannot load packages, so it imports only plain constants and types.
import { EVENT_CHANNEL, INVOKE_CHANNEL, type RobotBridge } from "@robot/shared/ipc"
import { contextBridge, ipcRenderer, webUtils } from "electron"

const bridge: RobotBridge = {
  invoke: (method, input, server) => ipcRenderer.invoke(INVOKE_CHANNEL, method, input, server),
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (event, listener) => {
    const handler = (_: unknown, name: string, payload: unknown, server?: string) => {
      if (name === event) listener(payload as Parameters<typeof listener>[0], server)
    }
    ipcRenderer.on(EVENT_CHANNEL, handler)
    return () => ipcRenderer.off(EVENT_CHANNEL, handler)
  },
}

contextBridge.exposeInMainWorld("robot", bridge)
