import { Worker } from "node:worker_threads"
import { CHECK_STATES_MAX, CHECK_TIME_MS } from "@robot/shared"
import { CheckStopped, ModelFault, type ModelRun, type RunModel } from "./model.ts"
import type { CheckReply, CheckRequest } from "./worker.ts"

export interface CheckLimits {
  readonly timeMs: number
  readonly maxStates: number
}

export const CHECK_LIMITS: CheckLimits = { timeMs: CHECK_TIME_MS, maxStates: CHECK_STATES_MAX }

/** The memory that the worker may use before the check stops. The app keeps its own memory. */
const WORKER_MEMORY_MB = 1024

// The worker file sits beside this file. Source runs (tests, `bun`) load the TypeScript file. The
// bundle of the app has the worker as its own entry, `checkWorker.js`, beside `index.js`. The
// name is a variable so that the bundler does not take it for an asset.
const workerFile = import.meta.url.endsWith(".ts") ? "./worker.ts" : "./checkWorker.js"

/**
 * Starts a worker, calls `use` with a function that runs one module at a time, and ends the worker
 * after. The time limit counts from the start. A run that goes over a limit rejects with
 * `CheckStopped`: the worker is ended, not asked.
 */
export const withChecker = async <T>(
  limits: CheckLimits,
  use: (run: RunModel) => Promise<T>,
): Promise<T> => {
  let next = 0
  let fail: (error: Error) => void = () => {}
  const failed = new Promise<never>((_, reject) => {
    fail = reject
  })
  // A rejected promise that nobody waits for is not an error of the app.
  failed.catch(() => {})
  const timer = setTimeout(() => fail(new CheckStopped("time")), limits.timeMs)
  // The worker starts with the first module. A graph that the shape alone decides needs none.
  let started: Worker | undefined
  const open = (): Worker => {
    if (started) return started
    const worker = new Worker(new URL(workerFile, import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB },
    })
    worker.on("error", (error) =>
      fail(
        "code" in error && error.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? new CheckStopped("memory")
          : error,
      ),
    )
    worker.on("exit", () => fail(new ModelFault("The checker ended too early.")))
    started = worker
    return worker
  }

  const run: RunModel = (source, config) => {
    const id = ++next
    const worker = open()
    const reply = new Promise<ModelRun>((resolve, reject) => {
      const onMessage = (message: CheckReply) => {
        if (message.id !== id) return
        worker.off("message", onMessage)
        if ("stopped" in message) reject(new CheckStopped(message.stopped))
        else if ("fault" in message) reject(new ModelFault(message.fault))
        else resolve({ status: message.status, trace: message.trace })
      }
      worker.on("message", onMessage)
    })
    const request: CheckRequest = { id, source, config, maxStates: limits.maxStates }
    worker.postMessage(request)
    return Promise.race([reply, failed])
  }

  try {
    return await use(run)
  } finally {
    clearTimeout(timer)
    await started?.terminate()
  }
}
