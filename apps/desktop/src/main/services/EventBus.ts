import type { RpcEvent, RpcEvents } from "@robot/shared"
import { Context, Layer } from "effect"

export interface EventBusService {
  emit<E extends RpcEvent>(event: E, payload: RpcEvents[E]): void
}

/** Pushes events to every open window. */
export class EventBus extends Context.Service<EventBus, EventBusService>()("robot/main/EventBus") {
  static readonly layer = (send: (event: RpcEvent, payload: unknown) => void) =>
    Layer.succeed(EventBus, EventBus.of({ emit: send }))

  /** Keeps every event in memory. For tests. */
  static readonly recording = () => {
    const events: { event: RpcEvent; payload: unknown }[] = []
    const layer = Layer.succeed(
      EventBus,
      EventBus.of({ emit: (event, payload) => events.push({ event, payload }) }),
    )
    return { events, layer }
  }
}
