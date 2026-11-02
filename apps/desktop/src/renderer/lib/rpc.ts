import {
  isRoutedMethod,
  type RpcError,
  type RpcInput,
  type RpcMethod,
  type RpcOutput,
} from "@robot/shared"

export class RpcFailure extends Error {
  constructor(readonly error: RpcError) {
    super(error.message)
  }
}

/**
 * The server that the window shows now. A call that a linked server can answer goes with its id,
 * and the main process sends it over the link. For this computer the id changes nothing.
 */
let activeServer: string | undefined
export const setActiveServer = (id: string | undefined) => {
  activeServer = id
}

/** Calls the main process. Throws `RpcFailure` when the main process reports an error. */
export const call = async <M extends RpcMethod>(
  method: M,
  ...[input]: RpcInput<M> extends undefined ? [] : [RpcInput<M>]
): Promise<RpcOutput<M>> => {
  // Store values are proxies, which cannot cross the process boundary. Send plain copies.
  const plain = input === undefined ? undefined : JSON.parse(JSON.stringify(input))
  // A call that names its server uses that one; the others use the server on screen.
  const named = (plain as { serverId?: unknown } | undefined)?.serverId
  const server = isRoutedMethod(method)
    ? typeof named === "string"
      ? named
      : activeServer
    : undefined
  const result = await window.robot.invoke(method, plain as RpcInput<M>, server)
  if (!result.ok) throw new RpcFailure(result.error)
  return result.value
}
