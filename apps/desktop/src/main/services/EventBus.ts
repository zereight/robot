import type { RpcEvent, RpcEvents } from "@robot/shared"
import { Context, Layer } from "effect"

export type EventTap = (event: RpcEvent, payload: unknown) => void

export interface EventBusService {
  emit<E extends RpcEvent>(event: E, payload: RpcEvents[E]): void
  /** Calls `listener` for every event, after the windows got it. Used to push events to linked devices. */
  tap(listener: EventTap): void
  /**
   * Sends an event to the windows only. The events of a linked server use this: they are not for
   * the devices that are linked to this computer.
   */
  window(event: RpcEvent, payload: unknown): void
}

const make = (send: EventTap): EventBusService => {
  const taps: EventTap[] = []
  return {
    emit: (event, payload) => {
      send(event, payload)
      for (const tap of taps) tap(event, payload)
    },
    tap: (listener) => {
      taps.push(listener)
    },
    window: (event, payload) => send(event, payload),
  }
}

/** Pushes events to every open window. */
export class EventBus extends Context.Service<EventBus, EventBusService>()("robot/main/EventBus") {
  static readonly layer = (send: EventTap) => Layer.sync(EventBus, () => EventBus.of(make(send)))

  /** Keeps every event in memory. For tests. */
  static readonly recording = () => {
    const events: { event: RpcEvent; payload: unknown }[] = []
    const layer = Layer.sync(EventBus, () =>
      EventBus.of(make((event, payload) => events.push({ event, payload }))),
    )
    return { events, layer }
  }
}
