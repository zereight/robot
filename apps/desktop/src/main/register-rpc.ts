import { INVOKE_CHANNEL } from "@robot/shared/ipc"
import type { ManagedRuntime } from "effect"
import { ipcMain } from "electron"
import { bindLinkDispatcher, runWindowRequest, type Services } from "./rpc.ts"

/** Connects the window to the handlers. This is the only part of the RPC that needs Electron. */
export const registerRpc = (runtime: ManagedRuntime.ManagedRuntime<Services, never>) => {
  void bindLinkDispatcher(runtime)
  ipcMain.handle(INVOKE_CHANNEL, (_event, method: string, input: unknown, server?: string) =>
    runWindowRequest(runtime, method, input, server),
  )
}
