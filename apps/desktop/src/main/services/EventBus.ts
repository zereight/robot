import type { RpcEvent, RpcEvents } from "@robot/shared"
import { Context, Layer } from "effect"

export type EventTap = (event: RpcEvent, payload: unknown) => void
/** Sends an event to the windows. `server` is the linked server that sent it; absent: this computer. */
export type WindowSend = (event: RpcEvent, payload: unknown, server?: string) => void

export interface EventBusService {
  emit<E extends RpcEvent>(event: E, payload: RpcEvents[E]): void
  /** Calls `listener` for every event, after the windows got it. Used to push events to linked devices. */
  tap(listener: EventTap): void
  /**
   * Sends an event to the windows only. The events of a linked server use this: they are not for
   * the devices that are linked to this computer. `server` names the linked server, so that a view
   * of this computer does not take an event of the same agent or channel from a server that syncs
   * with it (the ids are the same on both).
   */
  window(event: RpcEvent, payload: unknown, server?: string): void
}

const make = (send: WindowSend): EventBusService => {
  const taps: EventTap[] = []
  return {
    emit: (event, payload) => {
      send(event, payload)
      for (const tap of taps) tap(event, payload)
    },
    tap: (listener) => {
      taps.push(listener)
    },
    window: (event, payload, server) => send(event, payload, server),
  }
}

/** Pushes events to every open window. */
export class EventBus extends Context.Service<EventBus, EventBusService>()("robot/main/EventBus") {
  static readonly layer = (send: WindowSend) => Layer.sync(EventBus, () => EventBus.of(make(send)))

  /** Keeps every event in memory. For tests. */
  static readonly recording = () => {
    const events: { event: RpcEvent; payload: unknown; server?: string }[] = []
    const layer = Layer.sync(EventBus, () =>
      EventBus.of(
        make((event, payload, server) =>
          events.push(server === undefined ? { event, payload } : { event, payload, server }),
        ),
      ),
    )
    return { events, layer }
  }
}
