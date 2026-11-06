import { randomUUID } from "node:crypto"
import {
  effortsFor,
  isBlockingState,
  isRuntimeKind,
  levelOnRuntime,
  MODEL_NEW_MS,
  type ModelInfo,
  nearestEffort,
  orderModels,
  type ProviderAccount,
  type ProviderConnect,
  type ProviderKind,
  type RuntimeKind,
  type RuntimeProblem,
  runtimeHasSeparateSignIn,
  runtimeTakesInput,
  tokenCount,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { type AgentEvent, runAgent } from "../providers/agent.ts"
import { takesCacheMarker } from "../providers/cache.ts"
import { type Connection, effortToSend, listModels, ProviderFailure } from "../providers/client.ts"
import { spendTracker } from "../providers/spent.ts"
import type { TurnHooks, TurnInput } from "../providers/turn.ts"
import { grantBridge } from "../runtimes/bridge.ts"
import { buildBlocks, buildPrompt } from "../runtimes/prompt.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Runtimes } from "./Runtimes.ts"
import { Secrets } from "./Secrets.ts"

interface AccountRow {
  id: string
  kind: ProviderKind
  name: string
  base_url: string
  /** 1 when the user disconnected a runtime account. */
  off: number
  /** The separate sign-in of a runtime account, or null. */
  sign_in: string | null
}

const COLUMNS = "id, kind, name, base_url, off, sign_in"

/** What this computer keeps for one model of an account (spec 006, "Model list"). */
interface ModelRow {
  model: string
  /** When a later fetch first listed the model, in ms. Null for a model of the first fetch. */
  seen_at: number | null
  hidden: number
  context_size: number | null
  output_limit: number | null
  /** 1 for a model ID that the user typed. */
  typed: number
}

/**
 * The clock of the tag "New" (spec 006). A test moves it; the app never does.
 */
export const modelClock = { now: () => Date.now() }

/** The change of one model in the part "Models" of an account. A field that is absent stays. */
export interface ModelPatch {
  readonly hidden?: boolean
  /** In tokens, 1 to 10,000,000. Null clears the field. Custom models only. */
  readonly contextSize?: number | null
  readonly outputLimit?: number | null
}

export interface ProvidersService {
  readonly list: Effect.Effect<readonly ProviderAccount[]>
  /**
   * The accounts with the last state that is known of each program. It looks at no program and
   * waits for no check, so a turn of one provider never waits for the check of another (spec 006).
   */
  readonly accounts: Effect.Effect<readonly ProviderAccount[]>
  /** Checks the key with one request, then stores the account and the key. */
  connect(input: ProviderConnect): Effect.Effect<ProviderAccount, AppError>
  check(accountId: string): Effect.Effect<void, AppError>
  disconnect(accountId: string): Effect.Effect<void, AppError>
  remove(accountId: string): Effect.Effect<void, AppError>
  /**
   * The models of an account, newest first, with the marks that this computer adds: older, new,
   * hidden, custom, and the limits of a custom model (spec 006, "Model list"). A hidden model is
   * in the list, with its mark: the picker leaves it out, and an agent that uses it keeps it.
   */
  models(accountId: string): Effect.Effect<readonly ModelInfo[], AppError>
  /** Changes one model: shows or hides it, and sets the fields of a custom model. */
  setModel(accountId: string, model: string, patch: ModelPatch): Effect.Effect<void, AppError>
  /** "Hide all" turns every model of the account off. "Reset" turns them all on. */
  setAllModels(accountId: string, hidden: boolean): Effect.Effect<void, AppError>
  /** Adds a model ID that the user typed, to an API account. */
  addModel(accountId: string, model: string): Effect.Effect<void, AppError>
  /** Takes a model ID that the user typed off the list again. */
  removeModel(accountId: string, model: string): Effect.Effect<void, AppError>
  /** The output limit of a custom model, or null (spec 006). */
  outputLimit(accountId: string, model: string): number | null
  /** The connection of an API account, with its key. Fails when no key is stored. */
  connection(accountId: string): Effect.Effect<Connection, AppError>
  isConnected(accountId: string): boolean
  /** True when the account is a vendor program (an agent runtime), not an API account. */
  isRuntime(accountId: string): boolean
  /** Which vendor program answers for the account, or null for an API account. */
  runtimeKind(accountId: string): RuntimeKind | null
  /**
   * Gives up a separate sign-in that the user made in a form and did not keep: signs it out and
   * deletes its folder. A sign-in that an account uses is left as it is.
   */
  discardSignIn(kind: RuntimeKind, signIn: string): Effect.Effect<void>
  /** Like `isConnected`, but looks at an agent runtime again when the last look is old. */
  verify(accountId: string): Effect.Effect<boolean>
  /**
   * Why an agent on this account cannot work: its program needs repair or is not installed. Null
   * for an API account, and for a program in any other state (spec 006).
   */
  runtimeProblem(accountId: string): RuntimeProblem | null
  /**
   * Whether an agent on this account can be at "Read only": an API account always can, because
   * the app decides each step; a program can only when it has a read-only mode of its own (007).
   */
  readOnlySupported(accountId: string): Effect.Effect<boolean>
  /**
   * The events of one turn, from whatever kind of account answers it: an API model with the
   * tools of the app, or an agent runtime with its own tools and permission prompts.
   */
  events(
    accountId: string,
    input: TurnInput,
    hooks: TurnHooks,
  ): Effect.Effect<AsyncGenerator<AgentEvent>, AppError>
}

export const secretKey = (accountId: string) => `provider:${accountId}`

/**
 * How long a caller waits for the check of an agent runtime. A check that has not ended by then
 * goes on in the background, and the caller uses the last state that is known (spec 006).
 */
export const CHECK_WAIT_MS = 15_000
/** A test makes the wait short. The app never changes it. */
export const checkWait = { ms: CHECK_WAIT_MS }

export const toAppError = (error: unknown) =>
  error instanceof ProviderFailure
    ? error.code === "runtime_start"
      ? // The program did not start. The message names the state in words (spec 006).
        new AppError({ code: `runtime_repair_${error.detail === "gone" ? "gone" : "start"}` })
      : new AppError({ code: error.code, ...(error.detail ? { detail: error.detail } : {}) })
    : new AppError({ code: "provider_unreachable", detail: String(error) })

/**
 * What a failed reply keeps of a failure of the provider. A program that did not start keeps the
 * state in words (spec 006); every other failure keeps its own code.
 */
export const storedFailure = (failure: ProviderFailure) => {
  const error = toAppError(failure)
  return {
    code: error.code,
    detail: error.detail ?? "",
    resetsAt: failure.resetsAt ?? null,
  }
}

export interface ProvidersOptions {
  /**
   * Hosts, besides the official one, whose Anthropic accounts get the marker of the cache. Only a
   * test run sets it, for a stand-in provider on this computer.
   */
  readonly cacheHosts?: readonly string[]
}

export class Providers extends Context.Service<Providers, ProvidersService>()(
  "robot/main/Providers",
) {
  static readonly layer = (options: ProvidersOptions = {}) =>
    Layer.effect(
      Providers,
      Effect.gen(function* () {
        const db = yield* Database
        const secrets = yield* Secrets
        const bus = yield* EventBus
        const runtimes = yield* Runtimes
        const modelCache = new Map<string, readonly ModelInfo[]>()

        const rowConnected = (row: AccountRow) =>
          isRuntimeKind(row.kind)
            ? row.off === 0 && runtimes.ready(row.kind, row.sign_in)
            : secrets.get(secretKey(row.id)) !== null
        const toAccount = (row: AccountRow): ProviderAccount => ({
          id: row.id,
          kind: row.kind,
          name: row.name,
          baseUrl: row.base_url,
          signIn: row.sign_in,
          connected: rowConnected(row),
          ...(isRuntimeKind(row.kind) ? { runtime: runtimes.cached(row.kind, row.sign_in) } : {}),
        })
        const lookup = (id: string) =>
          db.get<AccountRow>(`SELECT ${COLUMNS} FROM provider_account WHERE id = ?`, id)
        const isConnected = (id: string) => {
          const row = lookup(id)
          return row ? rowConnected(row) : false
        }
        const isRuntime = (id: string) => {
          const row = lookup(id)
          return row ? isRuntimeKind(row.kind) : false
        }
        const runtimeKind = (id: string) => {
          const row = lookup(id)
          return row && isRuntimeKind(row.kind) ? row.kind : null
        }
        const findRow = (id: string) =>
          Effect.suspend(() => {
            const row = lookup(id)
            return row
              ? Effect.succeed(row)
              : Effect.fail(new AppError({ code: "provider_not_found" }))
          })
        const changed = () => {
          bus.emit("providers.changed", {})
        }

        const fetchModels = (c: Connection) =>
          Effect.tryPromise({ try: () => listModels(c), catch: toAppError })

        const modelRows = (accountId: string) =>
          db.all<ModelRow>(
            "SELECT model, seen_at, hidden, context_size, output_limit, typed FROM provider_model WHERE account_id = ?",
            accountId,
          )

        /**
         * Writes down the models that a fetch listed (spec 006). The first fetch of an account tags
         * nothing: its models get no time. A model that a later fetch lists for the first time
         * gets the time, and shows "New" for 7 days.
         */
        const noteSeen = (accountId: string, list: readonly ModelInfo[]) => {
          const known = new Set<string>()
          let fetchedBefore = false
          for (const row of modelRows(accountId)) {
            known.add(row.model)
            if (row.typed === 0) fetchedBefore = true
          }
          const now = modelClock.now()
          for (const m of list) {
            if (known.has(m.id)) continue
            db.run(
              "INSERT INTO provider_model (account_id, model, seen_at) VALUES (?, ?, ?)",
              accountId,
              m.id,
              fetchedBefore ? now : null,
            )
            known.add(m.id)
          }
        }

        /** The list of the provider, with what this computer adds to it. */
        const decorate = (row: AccountRow, raw: readonly ModelInfo[]): readonly ModelInfo[] => {
          const saved = new Map(modelRows(row.id).map((r) => [r.model, r]))
          const listed = new Set(raw.map((m) => m.id))
          // A model ID that the user typed is in the list, also when the provider does not list it.
          const typed: ModelInfo[] = []
          for (const r of saved.values())
            if (r.typed === 1 && !listed.has(r.model))
              typed.push({ id: r.model, label: r.model, efforts: effortsFor(row.kind, r.model) })
          const now = modelClock.now()
          return orderModels(
            [...raw, ...typed].map((m): ModelInfo => {
              const r = saved.get(m.id)
              // The fields belong to a custom model: any model of an account with a custom address,
              // and any model ID that the user typed.
              const custom = row.kind === "custom" || r?.typed === 1
              return {
                ...m,
                ...(custom ? { custom: true as const } : {}),
                ...(r?.typed === 1 ? { added: true as const } : {}),
                ...(custom && r?.context_size ? { contextWindow: r.context_size } : {}),
                ...(custom && r?.output_limit ? { outputLimit: r.output_limit } : {}),
                ...(r?.hidden === 1 ? { hidden: true as const } : {}),
                ...(r?.seen_at != null && now - r.seen_at < MODEL_NEW_MS
                  ? { isNew: true as const }
                  : {}),
              }
            }),
          )
        }

        const connection = (id: string) =>
          findRow(id).pipe(
            Effect.flatMap((row): Effect.Effect<Connection, AppError> => {
              const apiKey = secrets.get(secretKey(id))
              return apiKey && !isRuntimeKind(row.kind)
                ? Effect.succeed({ kind: row.kind, baseUrl: row.base_url, apiKey })
                : Effect.fail(new AppError({ code: "provider_not_connected" }))
            }),
          )

        /**
         * A runtime must be Ready: on the computer, answering, and signed in with a subscription.
         * Any other state fails at once with the state in words (spec 006).
         */
        const checkRuntime = (kind: RuntimeKind, signIn: string | null, fresh: boolean) =>
          Effect.gen(function* () {
            const status = yield* fresh
              ? runtimes.status(kind, signIn)
              : runtimes.statusIfStale(kind, signIn)
            switch (status.state) {
              case "ready":
                return
              case "not_installed":
                return yield* new AppError({ code: "runtime_missing" })
              case "needs_repair":
                return yield* new AppError({ code: `runtime_repair_${status.reason ?? "start"}` })
              case "needs_sign_in":
                return yield* new AppError({
                  code:
                    status.signedIn && status.method !== "subscription"
                      ? "runtime_api_key_login"
                      : "runtime_not_signed_in",
                })
              default:
                // A check that is still on the way after its limit does not happen. If it did, the
                // program has not answered.
                return yield* new AppError({ code: "runtime_repair_answer" })
            }
          })

        const connect = Effect.fn("Providers.connect")(function* (input: ProviderConnect) {
          const runtime = isRuntimeKind(input.kind) ? input.kind : null
          let models: readonly ModelInfo[] = []
          // The sign-in of an account is set when it is made. An account that is connected again
          // keeps it, as long as it stays an account of the same kind.
          const before = input.accountId ? yield* findRow(input.accountId) : null
          if (input.signIn && !(runtime && runtimeHasSeparateSignIn(runtime)))
            return yield* new AppError({ code: "invalid_input" })
          const signIn = !runtime
            ? null
            : before
              ? before.kind === runtime
                ? before.sign_in
                : null
              : (input.signIn ?? null)
          if (runtime) {
            yield* checkRuntime(runtime, signIn, true)
          } else {
            if (!input.baseUrl || !input.apiKey)
              return yield* new AppError({ code: "invalid_input" })
            models = yield* fetchModels({
              kind: input.kind as Connection["kind"],
              baseUrl: input.baseUrl,
              apiKey: input.apiKey,
            })
          }
          const baseUrl = runtime ? "" : (input.baseUrl ?? "")
          const id = input.accountId ?? randomUUID()
          if (before) {
            db.run(
              "UPDATE provider_account SET kind = ?, name = ?, base_url = ?, off = 0, sign_in = ? WHERE id = ?",
              input.kind,
              input.name.trim(),
              baseUrl,
              signIn,
              id,
            )
            // The account is no longer of a kind that has its own sign-in: nothing uses the folder.
            if (before.sign_in && before.sign_in !== signIn)
              yield* runtimes.forget(before.kind as RuntimeKind, before.sign_in)
          } else {
            db.run(
              "INSERT INTO provider_account (id, kind, name, base_url, sign_in, created_at) VALUES (?, ?, ?, ?, ?, ?)",
              id,
              input.kind,
              input.name.trim(),
              baseUrl,
              signIn,
              Date.now(),
            )
          }
          if (runtime) secrets.remove(secretKey(id))
          else secrets.set(secretKey(id), input.apiKey as string)
          // The models of a runtime come from the program each time. Only an API list is kept.
          if (!runtime) {
            modelCache.set(id, models)
            noteSeen(id, models)
          }
          changed()
          return toAccount(yield* findRow(id))
        })

        const events = (id: string, input: TurnInput, hooks: TurnHooks) =>
          Effect.gen(function* () {
            const row = yield* findRow(id)
            if (!isRuntimeKind(row.kind)) {
              const conn = yield* connection(id)
              // The marker goes only where the endpoint is known to take it. Without a lifetime from
              // the caller, the turn gets the short one (5 minutes).
              const cache = takesCacheMarker(conn, options.cacheHosts)
                ? (input.cache ?? "short")
                : null
              const limit = outputLimit(id, input.model)
              return runAgent(
                {
                  connection: conn,
                  model: input.model,
                  // The model that runs the turn counts: a level it does not list is never sent.
                  effort: effortToSend(row.kind, input.model, input.effort, modelCache.get(id)),
                  ...(limit !== null ? { maxOutput: limit } : {}),
                  system: input.system,
                  turns: input.resume ? [...input.turns, ...input.resume.turns] : input.turns,
                  ...(input.tools ? { tools: input.tools } : {}),
                  ...(cache ? { cache } : {}),
                  signal: input.signal,
                  ...(input.busy ? { busy: input.busy } : {}),
                },
                hooks.execute,
                input.resume?.call,
                input.inbox,
                input.moreTools,
              )
            }
            const kind = row.kind
            if (row.off !== 0) return yield* new AppError({ code: "provider_not_connected" })
            yield* checkRuntime(kind, row.sign_in, false)
            // "Read only" for a program means the mode of the program itself. When the app cannot
            // show that the program has one, the turn does not start (spec 007).
            if (input.permission === "read_only" && input.useTools) {
              const mode = yield* runtimes.readOnly(kind)
              if (!mode.supported) return yield* new AppError({ code: "read_only_unsupported" })
            }
            // The model that runs the turn counts: a level that its list does not hold is never
            // sent. A model that the app has no list for goes as it is.
            const listedModel = (yield* runtimes.models(kind)).find((m) => m.id === input.model)
            const effort = listedModel
              ? nearestEffort(input.effort, listedModel.efforts)
              : input.effort
            return (async function* () {
              // The program reaches the browser of the agent through the app, for this turn only.
              // When the access cannot open, the turn goes on without the browser.
              const grant =
                input.useTools && hooks.bridge
                  ? await grantBridge(hooks.bridge).catch(() => undefined)
                  : undefined
              try {
                // A program gives its counts of tokens at the end of a turn, as totals of the run.
                // `spent` is what the run used, for the usage of the task (spec 005).
                const spend = spendTracker()
                for await (const event of runtimes.run(
                  kind,
                  {
                    model: input.model,
                    effort,
                    system: input.system,
                    prompt: buildPrompt(input.turns),
                    // Claude Code reads the start of a request from the cache of the model when its
                    // blocks are the same as in the turn before. The other programs get the text.
                    ...(kind === "claude_code" ? { blocks: buildBlocks(input.turns) } : {}),
                    workspace: input.workspace,
                    // A program decides its own steps: "Ask when unsure" works as "Ask for risky
                    // steps" there (spec 007).
                    permission: levelOnRuntime(input.permission, true),
                    useTools: input.useTools,
                    signal: input.signal,
                    approve: hooks.approve,
                    ...(grant ? { bridge: grant } : {}),
                    ...(input.inbox && runtimeTakesInput(kind) ? { inbox: input.inbox } : {}),
                  },
                  row.sign_in,
                )) {
                  yield event
                  if (event.type === "usage") {
                    const spent = spend(event)
                    if (spent) yield spent
                  }
                }
              } catch (error) {
                // The sign-in is gone: look again, so that the account shows the truth.
                if (error instanceof ProviderFailure && error.code === "runtime_signed_out")
                  runtimes.invalidate(kind, row.sign_in)
                throw error
              } finally {
                grant?.release()
              }
            })()
          })

        /**
         * Waits for a check, but not for longer than `CHECK_WAIT_MS`. With `join` false, a check
         * that is running is not joined: the state shows as "Checking" (spec 006).
         */
        const checked = (kind: RuntimeKind, signIn: string | null, join = true) =>
          Effect.raceFirst(
            Effect.asVoid(runtimes.statusIfStale(kind, signIn, join)),
            Effect.sleep(checkWait.ms),
          )

        /** Every sign-in that an account uses is looked at, once for each. */
        const refreshRuntimes = () =>
          Effect.forEach(
            db
              .all<{ kind: ProviderKind; sign_in: string | null }>(
                "SELECT DISTINCT kind, sign_in FROM provider_account",
              )
              .flatMap((r) => (isRuntimeKind(r.kind) ? [{ kind: r.kind, signIn: r.sign_in }] : [])),
            ({ kind, signIn }) => checked(kind, signIn, false),
            { concurrency: "unbounded", discard: true },
          )

        const outputLimit = (accountId: string, model: string): number | null =>
          db.get<{ output_limit: number | null }>(
            "SELECT output_limit FROM provider_model WHERE account_id = ? AND model = ?",
            accountId,
            model,
          )?.output_limit ?? null

        const accounts = Effect.sync(() =>
          db
            .all<AccountRow>(`SELECT ${COLUMNS} FROM provider_account ORDER BY created_at`)
            .map(toAccount),
        )

        return Providers.of({
          list: Effect.gen(function* () {
            yield* refreshRuntimes()
            return yield* accounts
          }),
          accounts,
          connect,
          check: (id) =>
            findRow(id).pipe(
              Effect.flatMap((row) => {
                if (isRuntimeKind(row.kind)) {
                  const kind = row.kind
                  return checkRuntime(kind, row.sign_in, true).pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        // A check by the user also takes back a disconnect.
                        db.run("UPDATE provider_account SET off = 0 WHERE id = ?", id)
                        changed()
                      }),
                    ),
                  )
                }
                return connection(id).pipe(
                  Effect.flatMap(fetchModels),
                  Effect.tap((models) =>
                    Effect.sync(() => {
                      modelCache.set(id, models)
                      noteSeen(id, models)
                      // The part "Models" of the page shows what is new.
                      bus.emit("providers.changed", {})
                    }),
                  ),
                )
              }),
              Effect.asVoid,
            ),
          disconnect: (id) =>
            findRow(id).pipe(
              Effect.tap((row) =>
                Effect.sync(() => {
                  // The sign-in of a vendor program is not ours to remove: the account is only switched off.
                  if (isRuntimeKind(row.kind))
                    db.run("UPDATE provider_account SET off = 1 WHERE id = ?", id)
                  else secrets.remove(secretKey(id))
                  modelCache.delete(id)
                  changed()
                }),
              ),
              Effect.asVoid,
            ),
          remove: (id) =>
            findRow(id).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  secrets.remove(secretKey(id))
                  modelCache.delete(id)
                  // A node that used the account goes back to the default model.
                  db.run(
                    "UPDATE workflow_node SET account_id = NULL, model = NULL, effort = NULL WHERE account_id = ?",
                    id,
                  )
                  db.run("DELETE FROM provider_model WHERE account_id = ?", id)
                  db.run("DELETE FROM provider_account WHERE id = ?", id)
                  changed()
                }),
              ),
              // The sign-in that the account made for itself goes with it. The sign-in of the
              // program on this computer is not the app's to remove.
              Effect.tap((row) =>
                row.sign_in && isRuntimeKind(row.kind)
                  ? runtimes.forget(row.kind, row.sign_in)
                  : Effect.void,
              ),
              Effect.asVoid,
            ),
          models: (id) =>
            findRow(id).pipe(
              Effect.flatMap((row): Effect.Effect<readonly ModelInfo[], AppError> => {
                if (isRuntimeKind(row.kind))
                  // Each look at a program is a fetch of its list.
                  return runtimes.models(row.kind).pipe(
                    Effect.map((raw) => {
                      noteSeen(id, raw)
                      return decorate(row, raw)
                    }),
                  )
                const cached = modelCache.get(id)
                if (cached) return Effect.sync(() => decorate(row, cached))
                return connection(id).pipe(
                  Effect.flatMap(fetchModels),
                  Effect.map((models) => {
                    modelCache.set(id, models)
                    noteSeen(id, models)
                    return decorate(row, models)
                  }),
                )
              }),
            ),
          setModel: (id, model, patch) =>
            findRow(id).pipe(
              Effect.flatMap((row) =>
                Effect.suspend(() => {
                  const saved = modelRows(id).find((r) => r.model === model)
                  const wantsLimit =
                    patch.contextSize !== undefined || patch.outputLimit !== undefined
                  if (wantsLimit && !(row.kind === "custom" || saved?.typed === 1))
                    return Effect.fail(new AppError({ code: "invalid_input" }))
                  for (const value of [patch.contextSize, patch.outputLimit])
                    if (value !== undefined && value !== null && tokenCount(value) === null)
                      return Effect.fail(new AppError({ code: "model_limit_invalid" }))
                  if (!saved)
                    db.run(
                      "INSERT INTO provider_model (account_id, model) VALUES (?, ?)",
                      id,
                      model,
                    )
                  if (patch.hidden !== undefined)
                    db.run(
                      "UPDATE provider_model SET hidden = ? WHERE account_id = ? AND model = ?",
                      patch.hidden ? 1 : 0,
                      id,
                      model,
                    )
                  if (patch.contextSize !== undefined)
                    db.run(
                      "UPDATE provider_model SET context_size = ? WHERE account_id = ? AND model = ?",
                      patch.contextSize,
                      id,
                      model,
                    )
                  if (patch.outputLimit !== undefined)
                    db.run(
                      "UPDATE provider_model SET output_limit = ? WHERE account_id = ? AND model = ?",
                      patch.outputLimit,
                      id,
                      model,
                    )
                  bus.emit("providers.changed", {})
                  return Effect.void
                }),
              ),
            ),
          setAllModels: (id, hidden) =>
            findRow(id).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  db.run(
                    "UPDATE provider_model SET hidden = ? WHERE account_id = ?",
                    hidden ? 1 : 0,
                    id,
                  )
                  bus.emit("providers.changed", {})
                }),
              ),
              Effect.asVoid,
            ),
          addModel: (id, model) =>
            findRow(id).pipe(
              Effect.flatMap((row) => {
                const name = model.trim()
                if (name.length < 1 || name.length > 200)
                  return Effect.fail(new AppError({ code: "model_id_invalid" }))
                // The models of a vendor program come from the program.
                if (isRuntimeKind(row.kind))
                  return Effect.fail(new AppError({ code: "invalid_input" }))
                return Effect.sync(() => {
                  db.run(
                    `INSERT INTO provider_model (account_id, model, typed) VALUES (?, ?, 1)
                     ON CONFLICT (account_id, model) DO UPDATE SET typed = 1`,
                    id,
                    name,
                  )
                  bus.emit("providers.changed", {})
                })
              }),
            ),
          removeModel: (id, model) =>
            findRow(id).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  // The row stays, so that a model of the provider is not tagged "New" again. Its
                  // fields go with the typed ID.
                  db.run(
                    `UPDATE provider_model SET typed = 0, context_size = NULL, output_limit = NULL
                     WHERE account_id = ? AND model = ?`,
                    id,
                    model,
                  )
                  bus.emit("providers.changed", {})
                }),
              ),
              Effect.asVoid,
            ),
          outputLimit,
          connection,
          isConnected,
          isRuntime,
          runtimeKind,
          runtimeProblem: (id) => {
            const row = lookup(id)
            if (!row || !isRuntimeKind(row.kind)) return null
            const status = runtimes.cached(row.kind, row.sign_in)
            return isBlockingState(status.state)
              ? { kind: row.kind, state: status.state, reason: status.reason }
              : null
          },
          readOnlySupported: (id) =>
            Effect.suspend(() => {
              const row = lookup(id)
              if (!row || !isRuntimeKind(row.kind)) return Effect.succeed(true)
              return runtimes.readOnly(row.kind).pipe(Effect.map((mode) => mode.supported))
            }),
          verify: (id) =>
            Effect.gen(function* () {
              const row = lookup(id)
              if (!row) return false
              if (isRuntimeKind(row.kind)) yield* checked(row.kind, row.sign_in)
              return rowConnected(row)
            }),
          discardSignIn: (kind, signIn) =>
            Effect.suspend(() =>
              db.get("SELECT 1 AS x FROM provider_account WHERE sign_in = ?", signIn)
                ? Effect.void
                : runtimes.forget(kind, signIn),
            ),
          events,
        })
      }),
    )
}
