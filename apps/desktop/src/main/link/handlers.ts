import type { ServerSummary } from "@robot/shared"
import { LINK_PROTOCOL } from "@robot/shared"
import type { Effect } from "effect"
import { Effect as E } from "effect"
import type { AppServices } from "../layers.ts"
import { Devices } from "../services/Devices.ts"
import type { AppError } from "../services/errors.ts"
import { Platform } from "../services/Platform.ts"
import { Servers } from "../services/Servers.ts"

type LinkHandler = (input: unknown) => Effect.Effect<unknown, AppError, AppServices>

/**
 * Requests that exist only on the link between devices. A request that the window also makes is
 * in `rpc.ts`; the server runs those with the device as the actor.
 */
export const linkHandlers: Record<string, LinkHandler> = {
  "server.summary": () =>
    E.gen(function* () {
      const devices = yield* Devices
      const platform = yield* Platform
      const server = yield* Servers.use((s) => s.local)
      return {
        serverId: server.id,
        deviceId: devices.selfId,
        name: devices.deviceName(),
        app: platform.appVersion,
        protocol: LINK_PROTOCOL,
      } satisfies ServerSummary
    }),
}
