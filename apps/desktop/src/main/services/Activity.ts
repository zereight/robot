import { Context, Effect, Layer } from "effect"
import { EventBus } from "./EventBus.ts"

export interface ActivityService {
  isWorking(agentId: string): boolean
  setWorking(agentId: string, serverId: string, working: boolean): void
}

/** Which agents are working now. Kept in memory: after a restart no agent is working. */
export class Activity extends Context.Service<Activity, ActivityService>()("robot/main/Activity") {
  static readonly layer = Layer.effect(
    Activity,
    Effect.gen(function* () {
      const bus = yield* EventBus
      const working = new Set<string>()
      return Activity.of({
        isWorking: (agentId) => working.has(agentId),
        setWorking: (agentId, serverId, on) => {
          if (on === working.has(agentId)) return
          if (on) working.add(agentId)
          else working.delete(agentId)
          bus.emit("agents.changed", { serverId })
          bus.emit("places.changed", { serverId })
        },
      })
    }),
  )
}
