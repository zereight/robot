import { catalogues, type MessageKey, type MessageParams, parseLineDetail } from "@robot/shared"
import { RpcFailure } from "./rpc.ts"

export interface ErrorText {
  readonly key: MessageKey
  readonly params?: MessageParams
}

/** The translation key and values for an error from the main process. */
export const describeError = (error: unknown): ErrorText => {
  if (error instanceof RpcFailure) {
    const key = `error.${error.error.code}`
    if (key in catalogues.en) {
      // A refusal of "One line" (spec 030) carries the names for its long line as JSON.
      const names = error.error.code.startsWith("org_line_")
        ? parseLineDetail(error.error.message)
        : {}
      return { key: key as MessageKey, params: { ...names, detail: error.error.message } }
    }
  }
  return { key: "error.unknown" }
}

/** Only the key. For messages that take no values. */
export const errorKey = (error: unknown): MessageKey => describeError(error).key
