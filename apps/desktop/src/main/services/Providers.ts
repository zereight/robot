import { randomUUID } from "node:crypto"
import {
  isRuntimeKind,
  type ModelInfo,
  type ProviderAccount,
  type ProviderConnect,
  type ProviderKind,
  type RuntimeKind,
  runtimeHasSeparateSignIn,
  runtimeTakesInput,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { type AgentEvent, runAgent } from "../providers/agent.ts"
import { type Connection, keepEffort, listModels, ProviderFailure } from "../providers/client.ts"
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
  models(accountId: string): Effect.Effect<readonly ModelInfo[], AppError>
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
    ? new AppError({ code: error.code, ...(error.detail ? { detail: error.detail } : {}) })
    : new AppError({ code: "provider_unreachable", detail: String(error) })

export class Providers extends Context.Service<Providers, ProvidersService>()(
  "robot/main/Providers",
) {
  static readonly layer = Layer.effect(
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
        bus.emit("agents.changed", { serverId: "*" })
      }

      const fetchModels = (c: Connection) =>
        Effect.tryPromise({ try: () => listModels(c), catch: toAppError })

      const connection = (id: string) =>
        findRow(id).pipe(
          Effect.flatMap((row): Effect.Effect<Connection, AppError> => {
            const apiKey = secrets.get(secretKey(id))
            return apiKey && !isRuntimeKind(row.kind)
              ? Effect.succeed({ kind: row.kind, baseUrl: row.base_url, apiKey })
              : Effect.fail(new AppError({ code: "provider_not_connected" }))
          }),
        )

      /** A runtime must be on the computer, and signed in with a subscription. */
      const checkRuntime = (kind: RuntimeKind, signIn: string | null, fresh: boolean) =>
        Effect.gen(function* () {
          const status = yield* fresh
            ? runtimes.status(kind, signIn)
            : runtimes.statusIfStale(kind, signIn)
          if (status.source === null) return yield* new AppError({ code: "runtime_missing" })
          if (!status.signedIn) return yield* new AppError({ code: "runtime_not_signed_in" })
          if (status.method !== "subscription")
            return yield* new AppError({ code: "runtime_api_key_login" })
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
          if (!input.baseUrl || !input.apiKey) return yield* new AppError({ code: "invalid_input" })
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
        if (!runtime) modelCache.set(id, models)
        changed()
        return toAccount(yield* findRow(id))
      })

      const events = (id: string, input: TurnInput, hooks: TurnHooks) =>
        Effect.gen(function* () {
          const row = yield* findRow(id)
          if (!isRuntimeKind(row.kind)) {
            const conn = yield* connection(id)
            return runAgent(
              {
                connection: conn,
                model: input.model,
                effort: keepEffort(row.kind, input.model, input.effort, modelCache.get(id)),
                system: input.system,
                turns: input.resume ? [...input.turns, ...input.resume.turns] : input.turns,
                ...(input.tools ? { tools: input.tools } : {}),
                signal: input.signal,
              },
              hooks.execute,
              input.resume?.call,
              input.inbox,
            )
          }
          const kind = row.kind
          if (row.off !== 0) return yield* new AppError({ code: "provider_not_connected" })
          yield* checkRuntime(kind, row.sign_in, false)
          return (async function* () {
            // The program reaches the browser of the agent through the app, for this turn only.
            // When the access cannot open, the turn goes on without the browser.
            const grant =
              input.useTools && hooks.bridge
                ? await grantBridge(hooks.bridge).catch(() => undefined)
                : undefined
            try {
              yield* runtimes.run(
                kind,
                {
                  model: input.model,
                  effort: input.effort,
                  system: input.system,
                  prompt: buildPrompt(input.turns),
                  // Claude Code reads the start of a request from the cache of the model when its
                  // blocks are the same as in the turn before. The other programs get the text.
                  ...(kind === "claude_code" ? { blocks: buildBlocks(input.turns) } : {}),
                  workspace: input.workspace,
                  permission: input.permission,
                  useTools: input.useTools,
                  signal: input.signal,
                  approve: hooks.approve,
                  ...(grant ? { bridge: grant } : {}),
                  ...(input.inbox && runtimeTakesInput(kind) ? { inbox: input.inbox } : {}),
                },
                row.sign_in,
              )
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

      /** Waits for a check, but not for longer than `CHECK_WAIT_MS`. */
      const checked = (kind: RuntimeKind, signIn: string | null) =>
        Effect.raceFirst(
          Effect.asVoid(runtimes.statusIfStale(kind, signIn)),
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
          ({ kind, signIn }) => checked(kind, signIn),
          { concurrency: "unbounded", discard: true },
        )

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
                Effect.tap((models) => Effect.sync(() => modelCache.set(id, models))),
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
                db.run(
                  "UPDATE agent SET model_account_id = NULL, model_name = NULL, model_effort = NULL WHERE model_account_id = ?",
                  id,
                )
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
            Effect.flatMap((row) => {
              if (isRuntimeKind(row.kind)) return runtimes.models(row.kind)
              const cached = modelCache.get(id)
              if (cached) return Effect.succeed(cached)
              return connection(id).pipe(
                Effect.flatMap(fetchModels),
                Effect.tap((models) => Effect.sync(() => modelCache.set(id, models))),
              )
            }),
          ),
        connection,
        isConnected,
        isRuntime,
        runtimeKind,
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
