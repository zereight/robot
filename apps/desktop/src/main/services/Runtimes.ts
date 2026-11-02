import { existsSync, mkdirSync, rmSync, statSync } from "node:fs"
import {
  type ModelInfo,
  type ReadOnlySupport,
  type RepairReason,
  RUNTIME_CHECK_MS,
  type RuntimeKind,
  type RuntimeLimit,
  type RuntimeStatus,
  runtimeModels,
  runtimeSupport,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import type { AgentEvent } from "../providers/agent.ts"
import { ProviderFailure } from "../providers/client.ts"
import { drivers, type SignInPrompt } from "../runtimes/driver.ts"
import { installRuntime } from "../runtimes/install.ts"
import {
  findBinary,
  knownPlace,
  managedVersion,
  rememberPlace,
  signInDir,
} from "../runtimes/locate.ts"
import { type Readiness, readiness } from "../runtimes/readiness.ts"
import { hasReadOnlyMode } from "../runtimes/readonly.ts"
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
  /**
   * The state, with a new look when the last one is old. A look that is running is joined, unless
   * `join` is false: then the state shows as it is ("Checking"), and the end comes as a change.
   */
  statusIfStale(
    kind: RuntimeKind,
    signIn?: string | null,
    join?: boolean,
  ): Effect.Effect<RuntimeStatus>
  install(kind: RuntimeKind, signIn?: string | null): Effect.Effect<RuntimeStatus>
  /**
   * The only action that changes the program (spec 006). It looks for the program again in the
   * places that the app uses. For a program that the app downloaded, it downloads it again; the
   * download checks the checksum. Then it checks the program. It never touches a sign-in.
   */
  repair(kind: RuntimeKind, signIn?: string | null): Effect.Effect<RuntimeStatus>
  /**
   * Whether the program has a read-only mode of its own (spec 007). The answer comes from the help
   * text of the program, not from a check, and is kept until the file of the program changes.
   */
  readOnly(kind: RuntimeKind): Effect.Effect<ReadOnlySupport>
  signIn(kind: RuntimeKind, signIn?: string | null): Effect.Effect<RuntimeStatus>
  cancel(kind: RuntimeKind, signIn?: string | null): Effect.Effect<void>
  /** The models that an account of this kind can use. */
  models(kind: RuntimeKind): Effect.Effect<readonly ModelInfo[]>
  /** The last status that was read, without a new look. */
  cached(kind: RuntimeKind, signIn?: string | null): RuntimeStatus
  /** True when the state of the program is Ready. */
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

/**
 * The most time that a check may take. A test may make it shorter; it can never be longer than
 * the 15 seconds of the spec.
 */
const checkLimit = () => {
  const set = Number(process.env.ROBOT_CHECK_MS)
  return set > 0 ? Math.min(set, RUNTIME_CHECK_MS) : RUNTIME_CHECK_MS
}

/** A program that nobody looked at yet shows "Checking" until the first look ends. */
const blank = (kind: RuntimeKind, signIn: string | null): RuntimeStatus => ({
  kind,
  signIn,
  source: null,
  version: null,
  signedIn: false,
  method: null,
  user: null,
  plan: null,
  state: "checking",
  reason: null,
  checkedAt: null,
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
      // Each map is keyed by the kind and the sign-in, so that two sign-ins of one program do not
      // share a state.
      const state = new Map<string, RuntimeStatus>()
      const looked = new Map<string, number>()
      const looking = new Map<string, Promise<RuntimeStatus>>()
      const working = new Map<string, AbortController>()
      /** The version of each file that answered well. A bad answer is never kept. */
      const versions = new Map<string, string>()
      /** The latest look of each sign-in. A look that a newer one replaced does not write. */
      const generations = new Map<string, number>()
      /** Whether the help text of a file shows a read-only mode, by file and time of change. */
      const readOnlyModes = new Map<string, boolean>()
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
          // An agent on this program stops or starts to work when its state moves (spec 006).
          if (
            next.state !== "checking" &&
            (before.state !== next.state || before.reason !== next.reason)
          )
            bus.emit("agents.changed", { serverId: "*" })
        }
        return next
      }

      /**
       * The answer of the program to the question for its version. A forced look asks again: a
       * program that worked a minute ago may not start now.
       */
      const probeOf = async (kind: RuntimeKind, path: string, force: boolean) => {
        const known = versions.get(path)
        if (known !== undefined && !force) return { version: known }
        const probe = await drivers[kind].probe(path)
        if ("version" in probe) versions.set(path, probe.version)
        else versions.delete(path)
        return probe
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

      /** A program that did not pass: nothing about it is trusted, the rest of the row stays. */
      const failed = (kind: RuntimeKind, signIn: string | null, result: Readiness) => {
        const keep = get(kind, signIn)
        listed.delete(kind)
        return put(kind, signIn, {
          ...blank(kind, signIn),
          ...result,
          checkedAt: Date.now(),
          busy: keep.busy,
          progress: keep.progress,
          problem: keep.problem,
          limits: keep.limits,
          limitsAt: keep.limitsAt,
          signInUrl: keep.signInUrl,
          signInCode: keep.signInCode,
        })
      }

      /**
       * One check: the program runs once, with no model turn, to tell its version and who is signed
       * in (spec 006). `force` asks the program again even when it answered a moment ago.
       * `mine` is the number of this look: when a newer look has taken its place, this one writes
       * nothing.
       */
      const look = async (
        kind: RuntimeKind,
        signIn: string | null,
        force: boolean,
        mine: number,
      ): Promise<RuntimeStatus> => {
        const key = keyOf(kind, signIn)
        const live = () => generations.get(key) === mine
        const found = findBinary(kind, { dataDir: platform.dataDir })
        if (!found) {
          looked.set(key, Date.now())
          if (!live()) return get(kind, signIn)
          return failed(
            kind,
            signIn,
            readiness({
              located: false,
              knownBefore: knownPlace(platform.dataDir, kind) !== null,
            }),
          )
        }
        rememberPlace(platform.dataDir, kind, found.path)
        const probe = await probeOf(kind, found.path, force)
        if (!live()) return get(kind, signIn)
        if ("fail" in probe) {
          looked.set(key, Date.now())
          return failed(kind, signIn, readiness({ located: true, knownBefore: true, probe }))
        }
        const dir = dirOf(kind, signIn)
        // The folder of a separate sign-in is made when the user signs in. Before that nobody is
        // signed in, and asking the program would only make the folder.
        const login =
          dir && !existsSync(dir) ? SIGNED_OUT : await drivers[kind].login(found.path, dir)
        if (!live()) return get(kind, signIn)
        looked.set(key, Date.now())
        const result = readiness({ located: true, knownBefore: true, probe, login })
        if (result.state === "needs_repair") return failed(kind, signIn, result)
        if (login.models) listed.set(kind, login.models)
        const next = put(kind, signIn, {
          source: found.source,
          version: probe.version,
          signedIn: login.signedIn,
          method: login.method,
          user: login.user,
          plan: login.plan,
          ...result,
          checkedAt: Date.now(),
          // A program that is Ready ends the trouble that an earlier download or sign-in left.
          ...(result.state === "ready" ? { problem: null } : {}),
          ...(login.limits ? { limits: login.limits, limitsAt: Date.now() } : {}),
        })
        if (login.signedIn && login.method === "subscription")
          void readUsage(kind, signIn, found.path)
        return next
      }

      /**
       * A check ends within the limit of the spec, in one of the states. A program that does not
       * answer in time needs repair, and its late answer is dropped: it must not undo that.
       */
      const bounded = (
        kind: RuntimeKind,
        signIn: string | null,
        mine: number,
        task: Promise<RuntimeStatus>,
      ) =>
        new Promise<RuntimeStatus>((resolve) => {
          const key = keyOf(kind, signIn)
          const end = (result: Readiness) => {
            generations.set(key, mine + 1)
            looked.set(key, Date.now())
            resolve(failed(kind, signIn, result))
          }
          const timer = setTimeout(
            () => end({ state: "needs_repair", reason: "answer" }),
            checkLimit(),
          )
          task.then(
            (value) => {
              clearTimeout(timer)
              resolve(value)
            },
            () => {
              clearTimeout(timer)
              end({ state: "needs_repair", reason: "unreadable" })
            },
          )
        })

      /**
       * Looks at the program. A check that the user asked for shows "Checking" at once and asks the
       * program again. A look in the background does not blink the row, and may use an answer that
       * is a few seconds old.
       */
      const status = (kind: RuntimeKind, signIn: string | null, user = true) => {
        // An id that is not a plain name is refused here, before it can name a folder.
        dirOf(kind, signIn)
        const key = keyOf(kind, signIn)
        const running = looking.get(key)
        if (running) return running
        const mine = (generations.get(key) ?? 0) + 1
        generations.set(key, mine)
        if (user || get(kind, signIn).state === "checking")
          put(kind, signIn, { state: "checking", reason: null })
        const task = bounded(kind, signIn, mine, look(kind, signIn, user, mine)).finally(() =>
          looking.delete(key),
        )
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
        busy: "installing" | "signing_in" | "repairing",
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

      /**
       * A turn could not start the program. Every sign-in of the program shows Needs repair at once,
       * and the next look is not old, so that the next turn fails fast with the state in words.
       */
      const breakAt = (kind: RuntimeKind, signIn: string | null, why: RepairReason) => {
        const keys = new Set([...state.keys()].filter((k) => k.startsWith(`${kind}:`)))
        keys.add(keyOf(kind, signIn))
        for (const key of keys) {
          looked.set(key, Date.now())
          failed(kind, key.slice(kind.length + 1) || null, { state: "needs_repair", reason: why })
        }
        versions.clear()
      }

      /** Downloads the program again. Resolves with the problem in plain words, or null. */
      const download = async (
        kind: RuntimeKind,
        sign: string | null,
        signal: AbortSignal,
      ): Promise<string | null> => {
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
            ...(process.env.ROBOT_CLAUDE_DIST ? { claudeDist: process.env.ROBOT_CLAUDE_DIST } : {}),
            ...(process.env.ROBOT_CODEX_API ? { codexApi: process.env.ROBOT_CODEX_API } : {}),
          })
          // The program is new: every sign-in of it is looked at again.
          for (const key of looked.keys()) if (key.startsWith(`${kind}:`)) looked.delete(key)
          return null
        } catch (error) {
          if (signal.aborted) return null
          return reason(error)
        }
      }

      return Runtimes.of({
        status: (kind, signIn) => Effect.promise(() => status(kind, only(kind, signIn))),
        statusIfStale: (kind, signIn, join = true) => {
          const sign = only(kind, signIn)
          return Effect.promise(() => {
            const running = looking.has(keyOf(kind, sign))
            // A reader that does not join shows the state as it is: "Checking", with the end to come.
            if (running && !join) return Promise.resolve(get(kind, sign))
            return fresh(kind, sign) && !running
              ? Promise.resolve(get(kind, sign))
              : status(kind, sign, false)
          })
        },
        cached: (kind, signIn) => get(kind, only(kind, signIn)),
        ready: (kind, signIn) => get(kind, only(kind, signIn)).state === "ready",
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
              (signal) => download(kind, sign, signal),
              `install:${kind}`,
            ),
          )
        },
        repair: (kind, signIn) => {
          const sign = only(kind, signIn)
          return Effect.promise(() =>
            job(
              kind,
              sign,
              "repairing",
              async (signal) => {
                // The copy that the app downloaded is downloaded again. The download checks the
                // checksum. A program that the user installed is only looked for again, in the
                // places that the app uses; the check that follows finds it or does not.
                if (managedVersion(platform.dataDir, kind) === null) return null
                return await download(kind, sign, signal)
              },
              `install:${kind}`,
            ),
          )
        },
        readOnly: (kind) =>
          Effect.promise(async (): Promise<ReadOnlySupport> => {
            const found = findBinary(kind, { dataDir: platform.dataDir })
            if (!found) return { kind, supported: false }
            let stamp = ""
            try {
              const info = statSync(found.path)
              stamp = `${info.mtimeMs}:${info.size}`
            } catch {
              return { kind, supported: false }
            }
            const key = `${kind}:${found.path}:${stamp}`
            const known = readOnlyModes.get(key)
            if (known !== undefined) return { kind, supported: known }
            const supported = await hasReadOnlyMode(kind, found.path)
            readOnlyModes.set(key, supported)
            return { kind, supported }
          }),
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
          const turn = drivers[kind].run({
            ...input,
            bin: found?.path ?? "",
            onLimits,
            ...(dir ? { signInDir: dir } : {}),
          })
          return (async function* () {
            try {
              yield* turn
            } catch (error) {
              // The program did not start: its state turns to Needs repair at once (spec 006).
              if (error instanceof ProviderFailure && error.code === "runtime_start")
                breakAt(kind, sign, error.detail === "gone" ? "gone" : "start")
              throw error
            }
          })()
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
