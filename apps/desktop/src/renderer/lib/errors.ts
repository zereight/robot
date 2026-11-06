import { catalogues, type MessageKey, type MessageParams } from "@robot/shared"
import { RpcFailure } from "./rpc.ts"

export interface ErrorText {
  readonly key: MessageKey
  readonly params?: MessageParams
}

/** The translation key and values for an error from the main process. */
export const describeError = (error: unknown): ErrorText => {
  if (error instanceof RpcFailure) {
    const key = `error.${error.error.code}`
    if (key in catalogues.en)
      return { key: key as MessageKey, params: { detail: error.error.message } }
  }
  return { key: "error.unknown" }
}

/** Only the key. For messages that take no values. */
export const errorKey = (error: unknown): MessageKey => describeError(error).key
