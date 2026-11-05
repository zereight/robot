import type { MessageKey, SetupFailCode } from "@robot/shared"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { showToast } from "../ui/toast.ts"

const failKey = (code: SetupFailCode): MessageKey => {
  switch (code) {
    case "exit":
      return "setup.failed"
    case "timeout":
      return "setup.timeout"
    case "spawn":
      return "setup.spawn"
    default: {
      const never: never = code
      return never
    }
  }
}

/** Runs one setup action the user picked, and toasts what happened (spec 035). */
export const runSetupAction = (agentId: string, name: string): Promise<void> =>
  call("setup.run", { agentId, name })
    .then((result) => {
      if (result.status === "ran") showToast("success", "setup.ran", { name })
      else if (result.status === "failed") showToast("error", failKey(result.code), { name })
    })
    .catch((error: unknown) => {
      const described = describeError(error)
      showToast("error", described.key, described.params)
    })
