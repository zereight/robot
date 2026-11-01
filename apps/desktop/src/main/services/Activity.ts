import { Context, Effect, Layer } from "effect"
import { EventBus } from "./EventBus.ts"

export interface ActivityService {
  isWorking(agentId: string): boolean
  setWorking(agentId: string, serverId: string, working: boolean): void
  /** The agents that work now. */
  workingIds(): readonly string[]
  /** Calls `handler` when an agent starts or stops working. */
  onChange(handler: () => void): void
}

/** Which agents are working now. Kept in memory: after a restart no agent is working. */
export class Activity extends Context.Service<Activity, ActivityService>()("robot/main/Activity") {
  static readonly layer = Layer.effect(
    Activity,
    Effect.gen(function* () {
      const bus = yield* EventBus
      // A count, because a chat reply and a channel part can both be on one agent.
      const working = new Map<string, number>()
      const handlers: (() => void)[] = []
      return Activity.of({
        isWorking: (agentId) => (working.get(agentId) ?? 0) > 0,
        workingIds: () => [...working.keys()],
        onChange: (handler) => {
          handlers.push(handler)
        },
        setWorking: (agentId, serverId, on) => {
          const before = working.get(agentId) ?? 0
          const after = Math.max(0, before + (on ? 1 : -1))
          if (after === 0) working.delete(agentId)
          else working.set(agentId, after)
          if (before > 0 === after > 0) return
          bus.emit("agents.changed", { serverId })
          bus.emit("places.changed", { serverId })
          for (const h of handlers) h()
        },
      })
    }),
  )
}
