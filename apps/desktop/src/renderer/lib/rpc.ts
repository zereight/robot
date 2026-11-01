import type { RpcError, RpcInput, RpcMethod, RpcOutput } from "@robot/shared"

export class RpcFailure extends Error {
  constructor(readonly error: RpcError) {
    super(error.message)
  }
}

/** Calls the main process. Throws `RpcFailure` when the main process reports an error. */
export const call = async <M extends RpcMethod>(
  method: M,
  ...[input]: RpcInput<M> extends undefined ? [] : [RpcInput<M>]
): Promise<RpcOutput<M>> => {
  // Store values are proxies, which cannot cross the process boundary. Send plain copies.
  const plain = input === undefined ? undefined : JSON.parse(JSON.stringify(input))
  const result = await window.robot.invoke(method, plain as RpcInput<M>)
  if (!result.ok) throw new RpcFailure(result.error)
  return result.value
}
