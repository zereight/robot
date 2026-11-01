import type { MessageKey } from "@robot/shared"
import { RpcFailure } from "./rpc.ts"

/** The translation key for an error from the main process. */
export const errorKey = (error: unknown): MessageKey => {
  if (error instanceof RpcFailure) {
    const key = `error.${error.error.code}`
    return (key in knownErrors ? key : "error.unknown") as MessageKey
  }
  return "error.unknown"
}

const knownErrors: Record<string, true> = Object.fromEntries(
  [
    "agent_name_taken",
    "agent_not_found",
    "agent_working",
    "agent_not_archived",
    "face_image_invalid",
    "face_image_too_large",
    "workspace_failed",
    "trash_failed",
    "invalid_input",
  ].map((code) => [`error.${code}`, true]),
)
