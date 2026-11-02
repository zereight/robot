import { existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
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
import { findBinary, signInDir } from "../runtimes/locate.ts"
import { startPrograms } from "../runtimes/programs.ts"
import type { Login, RuntimeRun } from "../runtimes/types.ts"
import { EventBus } from "./EventBus.ts"
import { Platform } from "./Platform.ts"

/**
 * Most calls take the kind of program and, after it, the separate sign-in to look at. Without a
 * sign-in they are about the one that the program has on this computer. A kind that cannot have
 * a separate sign-in treats every call as about that one.
 */
export interface RuntimesService {
  /** Looks at the program again: where it is, its version, and who is signed in. */
  status(kind: RuntimeKind, signIn?: string | null): Effect.Effect<RuntimeStatus>
  /** Looks again only when the last look is old. */
  statusIfStale(kind: RuntimeKind, signIn?: string | null): Effect.Effect<RuntimeStatus>
  install(kind: RuntimeKind, signIn?: string | null): Effect.Effect<RuntimeStatus>
  signIn(kind: RuntimeKind, signIn?: string | null): Effect.Effect<RuntimeStatus>
  cancel(kind: RuntimeKind, signIn?: string | null): Effect.Effect<void>
  /** The models that an account of this kind can use. */
  models(kind: RuntimeKind): Effect.Effect<readonly ModelInfo[]>
  /** The last status that was read, without a new look. */
  cached(kind: RuntimeKind, signIn?: string | null): RuntimeStatus
  /** True when the program is there and signed in with a subscription. */
  ready(kind: RuntimeKind, signIn?: string | null): boolean
  /** The next look is not old; it is made again. */
  invalidate(kind: RuntimeKind, signIn?: string | null): void
  /** Runs one turn. Fails with `ProviderFailure`. */
  run(
    kind: RuntimeKind,
    input: Omit<RuntimeRun, "bin" | "onLimits" | "signInDir">,
    signIn?: string | null,
  ): AsyncGenerator<AgentEvent>
  /**
   * Signs out of a separate sign-in and deletes its folder. The sign-in of the program on this
   * computer is never touched.
   */
  forget(kind: RuntimeKind, signIn: string): Effect.Effect<void>
}

const FRESH_MS = 60_000

const blank = (kind: RuntimeKind, signIn: string | null): RuntimeStatus => ({
  kind,
  signIn,
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
      // A vendor program that an earlier run started and left running, for example after a crash,
      // is ended now (spec 006). From here on the programs of this run are written down.
      void startPrograms(join(platform.dataDir, "running-programs.json")).catch(() => {})
      // Each map is keyed by the kind and the sign-in, so that two sign-ins of one program do not
      // share a state.
      const state = new Map<string, RuntimeStatus>()
      const looked = new Map<string, number>()
      const looking = new Map<string, Promise<RuntimeStatus>>()
      const working = new Map<string, AbortController>()
      const versions = new Map<string, string | null>()
      /** The models that a program listed in its last look. */
      const listed = new Map<RuntimeKind, readonly ModelInfo[]>()

      /** The sign-in that counts: a kind that cannot have a separate one has none. */
      const only = (kind: RuntimeKind, signIn: string | null | undefined) =>
        signIn && drivers[kind].signOut ? signIn : null
      const keyOf = (kind: RuntimeKind, signIn: string | null) => `${kind}:${signIn ?? ""}`
      /** The folder of a separate sign-in, or none for the sign-in of the program itself. */
      const dirOf = (kind: RuntimeKind, signIn: string | null) =>
        signIn ? signInDir(platform.dataDir, kind, signIn) : undefined

      const get = (kind: RuntimeKind, signIn: string | null) =>
        state.get(keyOf(kind, signIn)) ?? blank(kind, signIn)
      const put = (kind: RuntimeKind, signIn: string | null, patch: Partial<RuntimeStatus>) => {
        const before = get(kind, signIn)
        const next = { ...before, ...patch }
        state.set(keyOf(kind, signIn), next)
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

      /** The sign-ins whose usage windows are being asked now. */
      const reading = new Set<string>()

      /**
       * Asks the program for the usage windows, after the look has ended, so a slow answer does
       * not hold the look. A program that cannot tell them leaves the last windows as they are,
       * with the time they were read.
       */
      const readUsage = async (kind: RuntimeKind, signIn: string | null, path: string) => {
        const ask = drivers[kind].usage
        const key = keyOf(kind, signIn)
        if (!ask || reading.has(key)) return
        reading.add(key)
        try {
          const limits = await ask(path, dirOf(kind, signIn))
          if (limits && limits.length > 0) put(kind, signIn, { limits, limitsAt: Date.now() })
        } catch {
          // The windows are extra. A failed question changes nothing.
        } finally {
          reading.delete(key)
        }
      }

      const SIGNED_OUT: Login = { signedIn: false, method: null, user: null, plan: null }

      const look = async (kind: RuntimeKind, signIn: string | null): Promise<RuntimeStatus> => {
        const key = keyOf(kind, signIn)
        const found = findBinary(kind, { dataDir: platform.dataDir })
        const version = found ? await versionOf(kind, found.path) : null
        if (!found || !version) {
          looked.set(key, Date.now())
          listed.delete(kind)
          const keep = get(kind, signIn)
          return put(kind, signIn, {
            ...blank(kind, signIn),
            busy: keep.busy,
            progress: keep.progress,
            problem: keep.problem,
            limits: keep.limits,
            limitsAt: keep.limitsAt,
            signInUrl: keep.signInUrl,
            signInCode: keep.signInCode,
          })
        }
        const dir = dirOf(kind, signIn)
        // The folder of a separate sign-in is made when the user signs in. Before that nobody is
        // signed in, and asking the program would only make the folder.
        const login =
          dir && !existsSync(dir) ? SIGNED_OUT : await drivers[kind].login(found.path, dir)
        looked.set(key, Date.now())
        if (login.models) listed.set(kind, login.models)
        const next = put(kind, signIn, {
          source: found.source,
          version,
          signedIn: login.signedIn,
          method: login.method,
          user: login.user,
          plan: login.plan,
          ...(login.limits ? { limits: login.limits, limitsAt: Date.now() } : {}),
        })
        if (login.signedIn && login.method === "subscription")
          void readUsage(kind, signIn, found.path)
        return next
      }

      const status = (kind: RuntimeKind, signIn: string | null) => {
        const key = keyOf(kind, signIn)
        const running = looking.get(key)
        if (running) return running
        const task = look(kind, signIn).finally(() => looking.delete(key))
        looking.set(key, task)
        return task
      }

      const fresh = (kind: RuntimeKind, signIn: string | null) =>
        Date.now() - (looked.get(keyOf(kind, signIn)) ?? 0) < FRESH_MS

      const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

      /**
       * Runs a long job of one sign-in: one at a time, with a stop switch. `lock` is what the job
       * excludes; a download of a program is one job for all its sign-ins.
       */
      const job = async (
        kind: RuntimeKind,
        signIn: string | null,
        busy: "installing" | "signing_in",
        task: (signal: AbortSignal) => Promise<string | null>,
        lock: string,
      ): Promise<RuntimeStatus> => {
        if (working.has(lock)) return get(kind, signIn)
        const controller = new AbortController()
        working.set(lock, controller)
        put(kind, signIn, {
          busy,
          progress: null,
          problem: null,
          signInUrl: null,
          signInCode: null,
        })
        let problem: string | null = null
        try {
          problem = await task(controller.signal)
        } catch (error) {
          if (!controller.signal.aborted) problem = reason(error)
        } finally {
          working.delete(lock)
        }
        put(kind, signIn, {
          busy: null,
          progress: null,
          problem,
          signInUrl: null,
          signInCode: null,
        })
        looked.delete(keyOf(kind, signIn))
        versions.clear()
        return await status(kind, signIn)
      }

      return Runtimes.of({
        status: (kind, signIn) => Effect.promise(() => status(kind, only(kind, signIn))),
        statusIfStale: (kind, signIn) => {
          const sign = only(kind, signIn)
          return Effect.promise(() =>
            fresh(kind, sign) && !looking.has(keyOf(kind, sign))
              ? Promise.resolve(get(kind, sign))
              : status(kind, sign),
          )
        },
        cached: (kind, signIn) => get(kind, only(kind, signIn)),
        ready: (kind, signIn) => {
          const s = get(kind, only(kind, signIn))
          return s.source !== null && s.signedIn && s.method === "subscription"
        },
        invalidate: (kind, signIn) => {
          looked.delete(keyOf(kind, only(kind, signIn)))
        },
        models: (kind) =>
          Effect.promise(async () => {
            const fixed = runtimeModels(kind)
            if (fixed.length > 0) return fixed
            // A program with a list of its own is asked, when the list is not known yet.
            if (!listed.has(kind)) await status(kind, null)
            return listed.get(kind) ?? []
          }),
        install: (kind, signIn) => {
          const sign = only(kind, signIn)
          return Effect.promise(() =>
            job(
              kind,
              sign,
              "installing",
              async (signal) => {
                if (runtimeSupport(kind).install !== "download")
                  return "The app does not download this program."
                try {
                  await installRuntime(kind, {
                    dataDir: platform.dataDir,
                    signal,
                    onProgress: (progress) => {
                      state.set(keyOf(kind, sign), { ...get(kind, sign), progress })
                      bus.emit("runtimes.changed", get(kind, sign))
                    },
                    ...(process.env.ROBOT_CLAUDE_DIST
                      ? { claudeDist: process.env.ROBOT_CLAUDE_DIST }
                      : {}),
                    ...(process.env.ROBOT_CODEX_API
                      ? { codexApi: process.env.ROBOT_CODEX_API }
                      : {}),
                  })
                  // The program is new: every sign-in of it is looked at again.
                  for (const key of looked.keys())
                    if (key.startsWith(`${kind}:`)) looked.delete(key)
                  return null
                } catch (error) {
                  if (signal.aborted) return null
                  return reason(error)
                }
              },
              `install:${kind}`,
            ),
          )
        },
        signIn: (kind, signIn) => {
          const sign = only(kind, signIn)
          return Effect.promise(() => {
            const driver = drivers[kind]
            const signInWith = driver.signIn
            // A program with no sign-in of its own: the user does it inside the program.
            if (!signInWith) return status(kind, sign)
            return job(
              kind,
              sign,
              "signing_in",
              async (signal) => {
                const found = findBinary(kind, { dataDir: platform.dataDir })
                if (!found) return "The program is not on this computer."
                const dir = dirOf(kind, sign)
                // Only the app uses this folder, and it holds the sign-in: the user alone may read it.
                if (dir) mkdirSync(dir, { recursive: true, mode: 0o700 })
                let opened = ""
                const done = await signInWith(
                  found.path,
                  signal,
                  (prompt: SignInPrompt) => {
                    put(kind, sign, { signInUrl: prompt.url, signInCode: prompt.code })
                    if (
                      prompt.url &&
                      prompt.url !== opened &&
                      mayOpen(prompt.url, driver.signInHosts)
                    ) {
                      opened = prompt.url
                      void platform.openExternal(prompt.url).catch(() => {})
                    }
                  },
                  dir,
                )
                if (signal.aborted) return null
                if (done.code === 0) return null
                return (
                  done.failure ??
                  (done.stderr.trim().split("\n").at(-1) ||
                    `The program ended with code ${done.code}.`)
                )
              },
              keyOf(kind, sign),
            )
          })
        },
        cancel: (kind, signIn) =>
          Effect.sync(() => {
            const sign = only(kind, signIn)
            // A download belongs to the program, a sign-in to one sign-in of it.
            const lock =
              get(kind, sign).busy === "installing" ? `install:${kind}` : keyOf(kind, sign)
            working.get(lock)?.abort()
          }),
        run: (kind, input, signIn) => {
          const sign = only(kind, signIn)
          const found = findBinary(kind, { dataDir: platform.dataDir })
          const dir = dirOf(kind, sign)
          const onLimits = (limits: readonly RuntimeLimit[]) => {
            if (limits.length > 0) put(kind, sign, { limits, limitsAt: Date.now() })
          }
          return drivers[kind].run({
            ...input,
            bin: found?.path ?? "",
            onLimits,
            ...(dir ? { signInDir: dir } : {}),
          })
        },
        forget: (kind, signIn) =>
          Effect.promise(async () => {
            const sign = only(kind, signIn)
            if (!sign) return
            const key = keyOf(kind, sign)
            working.get(key)?.abort()
            const dir = dirOf(kind, sign)
            if (dir && existsSync(dir)) {
              // The program keeps part of a sign-in outside its folder, for example in the system
              // keychain. Signing out removes that too. A failure leaves nothing more to do here.
              const found = findBinary(kind, { dataDir: platform.dataDir })
              if (found) await drivers[kind].signOut?.(found.path, dir).catch(() => {})
              rmSync(dir, { recursive: true, force: true })
            }
            state.delete(key)
            looked.delete(key)
          }),
      })
    }),
  )
}
