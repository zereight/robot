import { Context } from "effect"

/** A linked device that makes a request on this computer (spec 012). */
export interface Actor {
  readonly id: string
  readonly name: string
}

/**
 * Who makes the request that runs now: a linked device, or null for the window of this computer.
 * Handlers read it to record "from <device name>" and "Allowed by <device name>".
 */
export const CurrentActor = Context.Reference<Actor | null>("robot/main/CurrentActor", {
  defaultValue: () => null,
})
