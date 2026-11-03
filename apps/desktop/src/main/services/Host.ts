import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { createInterface } from "node:readline"
import type { RpcResult } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import type { Actor } from "./actor.ts"

/**
 * The window calls that the host program answers (`host/src/methods.rs`). The main process sends
 * them to the host and has no handler of its own for them. A method moves here when its work
 * moves to the host.
 */
export const HOST_METHODS = ["app.licenses"] as const
export type HostMethod = (typeof HOST_METHODS)[number]
export const isHostMethod = (method: string): method is HostMethod =>
  (HOST_METHODS as readonly string[]).includes(method)

export interface HostService {
  call(method: HostMethod, input: unknown, actor: Actor | null): Promise<RpcResult<unknown>>
}

export interface HostCommand {
  readonly command: string
  readonly args: readonly string[]
}

/** The longest time that the host gets to end after its input closes. */
const CLOSE_MS = 2_000

const unavailable: RpcResult<unknown> = {
  ok: false,
  error: { code: "host_unavailable", message: "The host is not running" },
}

/**
 * Starts the host when the first call comes, and again after it stopped. One request is one line
 * on the input of the host and one answer is one line on its output, matched by id.
 */
export const makeHost = (spec: HostCommand) => {
  let child: ChildProcessWithoutNullStreams | undefined
  let closed = false
  let nextId = 1
  const pending = new Map<number, (result: RpcResult<unknown>) => void>()

  const failPending = () => {
    for (const resolve of pending.values()) resolve(unavailable)
    pending.clear()
  }

  const start = () => {
    const proc = spawn(spec.command, [...spec.args], { stdio: ["pipe", "pipe", "pipe"] })
    child = proc
    createInterface({ input: proc.stdout }).on("line", (line) => {
      let message: { id?: unknown; result?: RpcResult<unknown> }
      try {
        message = JSON.parse(line)
      } catch {
        console.error("host: an output line is not JSON")
        return
      }
      if (typeof message.id !== "number" || !message.result) return
      const resolve = pending.get(message.id)
      pending.delete(message.id)
      resolve?.(message.result)
    })
    createInterface({ input: proc.stderr }).on("line", (line) => console.error(`host: ${line}`))
    // A stopped host, or a program that could not start, fails its open calls. The next call
    // starts it again.
    const gone = () => {
      if (child === proc) child = undefined
      failPending()
    }
    proc.once("exit", gone)
    proc.once("error", (error) => {
      console.error("host: could not run", error.message)
      gone()
    })
    // A write after the host stopped is reported here and by "exit"; it must not stop the app.
    proc.stdin.on("error", () => {})
    return proc
  }

  const call: HostService["call"] = (method, input, actor) => {
    if (closed) return Promise.resolve(unavailable)
    const proc = child ?? start()
    const id = nextId++
    return new Promise((resolve) => {
      pending.set(id, resolve)
      proc.stdin.write(`${JSON.stringify({ id, method, input: input ?? null, actor })}\n`)
    })
  }

  /** Closes the input of the host, so it ends, and waits for the end. A slow host is killed. */
  const close = () =>
    new Promise<void>((resolve) => {
      closed = true
      const proc = child
      if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
        failPending()
        return resolve()
      }
      const timer = setTimeout(() => proc.kill("SIGKILL"), CLOSE_MS)
      proc.once("exit", () => {
        clearTimeout(timer)
        resolve()
      })
      proc.stdin.end()
    })

  return { call, close, pid: () => child?.pid }
}

/** The host program, a separate process that does the work of the app apart from the windows. */
export class Host extends Context.Service<Host, HostService>()("robot/main/Host") {
  static readonly process = (spec: HostCommand) =>
    Layer.effect(
      Host,
      Effect.acquireRelease(
        Effect.sync(() => makeHost(spec)),
        (host) => Effect.promise(() => host.close()),
      ).pipe(Effect.map((host) => Host.of({ call: host.call }))),
    )

  /** No host. Every call fails. For unit tests that do not need the host. */
  static readonly none = Layer.succeed(Host, Host.of({ call: async () => unavailable }))
}
