import { parentPort } from "node:worker_threads"
import { check, formatValue, type Value } from "tla-ts"

// The checker runs in this worker, so that a long check never blocks the main process (spec 010:
// the check runs on every change). The main process sends one module at a time and may end this
// worker at any time (see `runner.ts`).

export interface CheckRequest {
  readonly id: number
  readonly source: string
  readonly config: string
  readonly maxStates: number
}

export type CheckReply =
  | {
      readonly id: number
      readonly status: "success" | "deadlock" | "violation"
      readonly trace: readonly Readonly<Record<string, unknown>>[]
    }
  | { readonly id: number; readonly stopped: "states" }
  | { readonly id: number; readonly fault: string }

/** A value of the checker as JSON: a function over 1..N and a set become arrays. */
const plain = (value: Value): unknown => {
  if (typeof value !== "object") return value
  if (value.kind === "Function") return value.range.map(plain)
  if (value.kind === "Set") return value.elements.map(plain)
  return formatValue(value)
}

class StatesLimit extends Error {}

const answer = async (request: CheckRequest): Promise<CheckReply> => {
  try {
    const result = await check({
      source: request.source,
      config: request.config,
      onProgress: (progress) => {
        // A progress report comes rarely. This stops a model that is far over the limit.
        if (progress.kind === "progress" && progress.statistics.generatedStates > request.maxStates)
          throw new StatesLimit()
      },
    })
    const trace = (result.violation?.trace ?? []).map((step) =>
      Object.fromEntries(Object.entries(step.state).map(([name, v]) => [name, plain(v)])),
    )
    if (result.status === "success" || result.status === "deadlock")
      return { id: request.id, status: result.status, trace }
    if (result.status === "invariant-violation")
      return { id: request.id, status: "violation", trace }
    return {
      id: request.id,
      fault: result.failure?.message ?? `The checker ended with the status ${result.status}.`,
    }
  } catch (error) {
    if (error instanceof StatesLimit) return { id: request.id, stopped: "states" }
    return { id: request.id, fault: error instanceof Error ? error.message : String(error) }
  }
}

parentPort?.on("message", (request: CheckRequest) => {
  void answer(request).then((reply) => parentPort?.postMessage(reply))
})
