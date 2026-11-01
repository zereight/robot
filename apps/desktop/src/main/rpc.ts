import {
  INVOKE_CHANNEL,
  type RpcInput,
  type RpcMethod,
  type RpcMethods,
  type RpcOutput,
  type RpcResult,
} from "@robot/shared"
import { app, ipcMain } from "electron"

type Handlers = { [M in RpcMethod]: (input: RpcInput<M>) => Promise<RpcOutput<M>> }

const handlers: Handlers = {
  "app.info": async () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
  }),
}

export const registerRpc = () => {
  ipcMain.handle(
    INVOKE_CHANNEL,
    async (_event, method: string, input: unknown): Promise<RpcResult<unknown>> => {
      const handler = handlers[method as RpcMethod] as
        | ((input: unknown) => Promise<RpcMethods[RpcMethod]["output"]>)
        | undefined
      if (!handler) return { ok: false, error: { code: "unknown_method", message: method } }
      try {
        return { ok: true, value: await handler(input) }
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        return { ok: false, error: { code: "internal", message } }
      }
    },
  )
}
