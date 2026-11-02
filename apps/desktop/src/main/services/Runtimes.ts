import {
  type ModelInfo,
  type RuntimeKind,
  type RuntimeLimit,
  type RuntimeStatus,
  runtimeModels,
  runtimeSupport,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import type { AgentEvent } from "../providers/agent.ts"
import { drivers, type SignInPrompt } from "../runtimes/driver.ts"
import { installRuntime } from "../runtimes/install.ts"
import { findBinary } from "../runtimes/locate.ts"
import type { RuntimeRun } from "../runtimes/types.ts"
import { EventBus } from "./EventBus.ts"
import { Platform } from "./Platform.ts"

export interface RuntimesService {
  /** Looks at the program again: where it is, its version, and who is signed in. */
  status(kind: RuntimeKind): Effect.Effect<RuntimeStatus>
  /** Looks again only when the last look is old. */
  statusIfStale(kind: RuntimeKind): Effect.Effect<RuntimeStatus>
  install(kind: RuntimeKind): Effect.Effect<RuntimeStatus>
  signIn(kind: RuntimeKind): Effect.Effect<RuntimeStatus>
  cancel(kind: RuntimeKind): Effect.Effect<void>
  /** The models that an account of this kind can use. */
  models(kind: RuntimeKind): Effect.Effect<readonly ModelInfo[]>
  /** The last status that was read, without a new look. */
  cached(kind: RuntimeKind): RuntimeStatus
  /** True when the program is there and signed in with a subscription. */
  ready(kind: RuntimeKind): boolean
  /** The next look is not old; it is made again. */
  invalidate(kind: RuntimeKind): void
  /** Runs one turn. Fails with `ProviderFailure`. */
  run(kind: RuntimeKind, input: Omit<RuntimeRun, "bin" | "onLimits">): AsyncGenerator<AgentEvent>
}

const FRESH_MS = 60_000

const blank = (kind: RuntimeKind): RuntimeStatus => ({
  kind,
  source: null,
  version: null,
  signedIn: false,
  method: null,
  user: null,
  plan: null,
  busy: null,
  progress: null,
  limits: [],
  limitsAt: null,
  problem: null,
  signInUrl: null,
  signInCode: null,
})

/** A page for a sign-in may only be opened when it is https and on a host that the driver names. */
const mayOpen = (url: string, hosts: readonly string[] | undefined) => {
  try {
    const parsed = new URL(url)
    return (
      parsed.protocol === "https:" &&
      !!hosts?.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))
    )
  } catch {
    return false
  }
}

export class Runtimes extends Context.Service<Runtimes, RuntimesService>()("robot/main/Runtimes") {
  static readonly layer = Layer.effect(
    Runtimes,
    Effect.gen(function* () {
      const platform = yield* Platform
      const bus = yield* EventBus
      const state = new Map<RuntimeKind, RuntimeStatus>()
      const looked = new Map<RuntimeKind, number>()
      const looking = new Map<RuntimeKind, Promise<RuntimeStatus>>()
      const working = new Map<RuntimeKind, AbortController>()
      const versions = new Map<string, string | null>()
      /** The models that a program listed in its last look. */
      const listed = new Map<RuntimeKind, readonly ModelInfo[]>()

      const get = (kind: RuntimeKind) => state.get(kind) ?? blank(kind)
      const put = (kind: RuntimeKind, patch: Partial<RuntimeStatus>) => {
        const before = get(kind)
        const next = { ...before, ...patch }
        state.set(kind, next)
        // Nothing new means nothing to tell. This also keeps a window that looks again quiet.
        if (JSON.stringify(before) !== JSON.stringify(next)) {
          bus.emit("runtimes.changed", next)
          bus.emit("providers.changed", {})
        }
        return next
      }

      const versionOf = async (kind: RuntimeKind, path: string) => {
        if (versions.has(path)) return versions.get(path) ?? null
        // A program that does not tell its version does not run on this computer.
        const version = await drivers[kind].version(path)
        versions.set(path, version)
        return version
      }

      /** The kinds whose usage windows are being asked now. */
      const reading = new Set<RuntimeKind>()

      /**
       * Asks the program for the usage windows, after the look has ended, so a slow answer does
       * not hold the look. A program that cannot tell them leaves the last windows as they are,
       * with the time they were read.
       */
      const readUsage = async (kind: RuntimeKind, path: string) => {
        const ask = drivers[kind].usage
        if (!ask || reading.has(kind)) return
        reading.add(kind)
        try {
          const limits = await ask(path)
          if (limits && limits.length > 0) put(kind, { limits, limitsAt: Date.now() })
        } catch {
          // The windows are extra. A failed question changes nothing.
        } finally {
          reading.delete(kind)
        }
      }

      const look = async (kind: RuntimeKind): Promise<RuntimeStatus> => {
        const found = findBinary(kind, { dataDir: platform.dataDir })
        const version = found ? await versionOf(kind, found.path) : null
        if (!found || !version) {
          looked.set(kind, Date.now())
          listed.delete(kind)
          const keep = get(kind)
          return put(kind, {
            ...blank(kind),
            busy: keep.busy,
            progress: keep.progress,
            problem: keep.problem,
            limits: keep.limits,
            limitsAt: keep.limitsAt,
            signInUrl: keep.signInUrl,
            signInCode: keep.signInCode,
          })
        }
        const login = await drivers[kind].login(found.path)
        looked.set(kind, Date.now())
        if (login.models) listed.set(kind, login.models)
        const next = put(kind, {
          source: found.source,
          version,
          signedIn: login.signedIn,
          method: login.method,
          user: login.user,
          plan: login.plan,
          ...(login.limits ? { limits: login.limits, limitsAt: Date.now() } : {}),
        })
        if (login.signedIn && login.method === "subscription") void readUsage(kind, found.path)
        return next
      }

      const status = (kind: RuntimeKind) => {
        const running = looking.get(kind)
        if (running) return running
        const task = look(kind).finally(() => looking.delete(kind))
        looking.set(kind, task)
        return task
      }

      const fresh = (kind: RuntimeKind) => Date.now() - (looked.get(kind) ?? 0) < FRESH_MS

      const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

      /** Runs a long job of one kind: one at a time, with a stop switch. */
      const job = async (
        kind: RuntimeKind,
        busy: "installing" | "signing_in",
        task: (signal: AbortSignal) => Promise<string | null>,
      ): Promise<RuntimeStatus> => {
        if (working.has(kind)) return get(kind)
        const controller = new AbortController()
        working.set(kind, controller)
        put(kind, { busy, progress: null, problem: null, signInUrl: null, signInCode: null })
        let problem: string | null = null
        try {
          problem = await task(controller.signal)
        } catch (error) {
          if (!controller.signal.aborted) problem = reason(error)
        } finally {
          working.delete(kind)
        }
        put(kind, { busy: null, progress: null, problem, signInUrl: null, signInCode: null })
        looked.delete(kind)
        versions.clear()
        return await status(kind)
      }

      return Runtimes.of({
        status: (kind) => Effect.promise(() => status(kind)),
        statusIfStale: (kind) =>
          Effect.promise(() =>
            fresh(kind) && !looking.has(kind) ? Promise.resolve(get(kind)) : status(kind),
          ),
        cached: get,
        ready: (kind) => {
          const s = get(kind)
          return s.source !== null && s.signedIn && s.method === "subscription"
        },
        invalidate: (kind) => {
          looked.delete(kind)
        },
        models: (kind) =>
          Effect.promise(async () => {
            const fixed = runtimeModels(kind)
            if (fixed.length > 0) return fixed
            // A program with a list of its own is asked, when the list is not known yet.
            if (!listed.has(kind)) await status(kind)
            return listed.get(kind) ?? []
          }),
        install: (kind) =>
          Effect.promise(() =>
            job(kind, "installing", async (signal) => {
              if (runtimeSupport(kind).install !== "download")
                return "The app does not download this program."
              try {
                await installRuntime(kind, {
                  dataDir: platform.dataDir,
                  signal,
                  onProgress: (progress) => {
                    state.set(kind, { ...get(kind), progress })
                    bus.emit("runtimes.changed", get(kind))
                  },
                  ...(process.env.ROBOT_CLAUDE_DIST
                    ? { claudeDist: process.env.ROBOT_CLAUDE_DIST }
                    : {}),
                  ...(process.env.ROBOT_CODEX_API ? { codexApi: process.env.ROBOT_CODEX_API } : {}),
                })
                return null
              } catch (error) {
                if (signal.aborted) return null
                return reason(error)
              }
            }),
          ),
        signIn: (kind) =>
          Effect.promise(() => {
            const driver = drivers[kind]
            const signIn = driver.signIn
            // A program with no sign-in of its own: the user does it inside the program.
            if (!signIn) return status(kind)
            return job(kind, "signing_in", async (signal) => {
              const found = findBinary(kind, { dataDir: platform.dataDir })
              if (!found) return "The program is not on this computer."
              let opened = ""
              const done = await signIn(found.path, signal, (prompt: SignInPrompt) => {
                put(kind, { signInUrl: prompt.url, signInCode: prompt.code })
                if (
                  prompt.url &&
                  prompt.url !== opened &&
                  mayOpen(prompt.url, driver.signInHosts)
                ) {
                  opened = prompt.url
                  void platform.openExternal(prompt.url).catch(() => {})
                }
              })
              if (signal.aborted) return null
              if (done.code === 0) return null
              return (
                done.failure ??
                (done.stderr.trim().split("\n").at(-1) ||
                  `The program ended with code ${done.code}.`)
              )
            })
          }),
        cancel: (kind) => Effect.sync(() => working.get(kind)?.abort()),
        run: (kind, input) => {
          const found = findBinary(kind, { dataDir: platform.dataDir })
          const onLimits = (limits: readonly RuntimeLimit[]) => {
            if (limits.length > 0) put(kind, { limits, limitsAt: Date.now() })
          }
          return drivers[kind].run({ ...input, bin: found?.path ?? "", onLimits })
        },
      })
    }),
  )
}
