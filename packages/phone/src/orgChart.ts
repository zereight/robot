import { type ChartModel, isOrgModel } from "@robot/shared"

// Where the org chart on the phone comes from (spec 029, "Phone"; spec 011; spec 012). The server
// sends a ready model, as the answer to one request and as a push whenever the chart changes. The
// phone keeps the newest model in memory while the screen is open and the server is online. It
// never writes it to disk, and it drops it when the server is not online, when the screen closes
// and when another server opens. The phone has no cache of the chart.

export type OrgChartPhase =
  /** Nothing is wanted or the server is not online: nothing is held. */
  | { readonly kind: "off" }
  /** The server is online and the first model is on its way. */
  | { readonly kind: "loading" }
  /** The newest model of the server. */
  | { readonly kind: "ready"; readonly model: ChartModel }
  /** The server is an older build that does not know the request (it answered "Not allowed"). */
  | { readonly kind: "unsupported" }
  /** The server is online, but the read failed. The code is the code of the failure. */
  | { readonly kind: "failed"; readonly code: string }

/**
 * Holds the newest model of one server and tells the screen when the phase changes. A push that
 * arrives while the read is on its way is newer than the read, so the read must not replace it. An
 * answer that belongs to an earlier question (an earlier open of the screen, or an earlier time
 * that the server was online) is dropped.
 */
export class OrgFeed {
  #question = 0
  #pushed = false
  #phase: OrgChartPhase = { kind: "off" }

  constructor(private readonly show: (phase: OrgChartPhase) => void) {}

  get phase(): OrgChartPhase {
    return this.#phase
  }

  #set(phase: OrgChartPhase) {
    this.#phase = phase
    this.show(phase)
  }

  /** The server is online and the chart is wanted: a new question. Whatever was held goes. */
  begin(): number {
    this.#question++
    this.#pushed = false
    this.#set({ kind: "loading" })
    return this.#question
  }

  /**
   * The user asked again (pull to refresh): a new question that keeps what is shown until the
   * answer comes. A failure or an old-build line goes back to "loading".
   */
  again(): number {
    this.#question++
    this.#pushed = false
    if (this.#phase.kind !== "ready") this.#set({ kind: "loading" })
    return this.#question
  }

  /** The server pushed its chart. A push is shown only while a question is open. */
  pushed(model: ChartModel) {
    if (this.#phase.kind === "off") return
    this.#pushed = true
    // A server of an older step sends a chart of channels: the screen says so, as for an unknown request.
    this.#set(isOrgModel(model) ? { kind: "ready", model } : { kind: "unsupported" })
  }

  /** The answer to question `question`. Returns true when it was shown. */
  answered(question: number, model: ChartModel): boolean {
    if (question !== this.#question || this.#pushed) return false
    this.#set(isOrgModel(model) ? { kind: "ready", model } : { kind: "unsupported" })
    return true
  }

  /**
   * The request `question` failed. A server of an older build does not know the request, and the
   * link answers every unknown request with "Not allowed" (spec 012, "Messages"): the screen then
   * shows "Open this on <server name>." as the page on a computer does. Another failure shows as
   * a failure, and a later push or a new read still replaces it.
   */
  failed(question: number, error: unknown) {
    if (question !== this.#question || this.#pushed) return
    this.#set(
      unsupportedByServer(error)
        ? { kind: "unsupported" }
        : { kind: "failed", code: codeOf(error) },
    )
  }

  /** Nothing is wanted any more: the model goes at once. */
  stop() {
    this.#question++
    this.#pushed = false
    if (this.#phase.kind !== "off") this.#set({ kind: "off" })
  }

  /** The screen closed: the model goes and nobody is told. */
  discard() {
    this.#question++
    this.#pushed = false
    this.#phase = { kind: "off" }
  }
}

const codeOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : "internal"
}

/**
 * True when the server answered the request for its chart with "Not allowed". Every other failure
 * (the server is not online, the link was removed, a time out) is not a sign of an old build.
 */
export const unsupportedByServer = (error: unknown): boolean => codeOf(error) === "not_allowed"
