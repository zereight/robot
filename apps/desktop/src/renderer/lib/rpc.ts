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
  const result = await window.robot.invoke(method, input as RpcInput<M>)
  if (!result.ok) throw new RpcFailure(result.error)
  return result.value
}
