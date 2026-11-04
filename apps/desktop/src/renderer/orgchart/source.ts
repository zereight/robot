import type { Server } from "@robot/shared"
import { RpcFailure } from "../lib/rpc.ts"

// Where the chart on the screen comes from (spec 029, 012). The page of this computer draws from
// the snapshot of its own main process. The page of a linked server draws from the ready model
// that the server sends, and only while the server is online. The chart of a server is never kept
// on this computer, so nothing of it is left when the server is not online.

export type OrgSource =
  /** This computer: the snapshot of the main process. */
  | "local"
  /** A linked server that is online: the ready model that it sends. */
  | "linked"
  /** A linked server in any other state of 012: the page shows the line "<name> is offline." */
  | "offline"

export const orgSource = (server: Pick<Server, "kind" | "state"> | undefined): OrgSource =>
  server?.kind !== "linked" ? "local" : server.state === "online" ? "linked" : "offline"

/**
 * True when the server answered the request for its chart with "Not allowed". A server of an older
 * build does not know the request, and the link answers every unknown request so (spec 012,
 * "Messages"). The page then shows the line "Open this on <name>." as before. Every other failure
 * (a server that is not online, a link that was removed) shows as the state of the server.
 */
export const unsupportedByServer = (error: unknown): boolean =>
  error instanceof RpcFailure && error.error.code === "not_allowed"

/**
 * Holds the newest ready model of one linked server. The window listens first and then asks once.
 * A push that arrives while the read is on its way is newer than the read, so the read must not
 * replace it. A read that belongs to an earlier question (another server, or an earlier open of
 * the page) is dropped.
 */
export class NewestModel<T> {
  #question = 0
  #pushed = false

  constructor(private readonly show: (model: T | undefined) => void) {}

  /** A new question. Whatever was shown goes, so a chart of another server never stays. */
  begin(): number {
    this.#question++
    this.#pushed = false
    this.show(undefined)
    return this.#question
  }

  /** The server pushed its chart. */
  pushed(model: T) {
    this.#pushed = true
    this.show(model)
  }

  /** The answer to question `question`. Returns true when it was shown. */
  answered(question: number, model: T): boolean {
    if (question !== this.#question || this.#pushed) return false
    this.show(model)
    return true
  }

  /** True while `question` is the last one asked. */
  current(question: number) {
    return question === this.#question
  }

  /** Nothing is wanted any more: the chart goes at once. */
  stop() {
    this.#question++
    this.#pushed = false
    this.show(undefined)
  }
}
