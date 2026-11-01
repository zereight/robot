import { randomUUID } from "node:crypto"
import {
  isRuntimeKind,
  type ModelInfo,
  type ProviderAccount,
  type ProviderConnect,
  type ProviderKind,
  type RuntimeKind,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { type AgentEvent, runAgent } from "../providers/agent.ts"
import { type Connection, listModels, ProviderFailure } from "../providers/client.ts"
import type { TurnHooks, TurnInput } from "../providers/turn.ts"
import { buildPrompt } from "../runtimes/prompt.ts"
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
}

export interface ProvidersService {
  readonly list: Effect.Effect<readonly ProviderAccount[]>
  /** Checks the key with one request, then stores the account and the key. */
  connect(input: ProviderConnect): Effect.Effect<ProviderAccount, AppError>
  check(accountId: string): Effect.Effect<void, AppError>
  disconnect(accountId: string): Effect.Effect<void, AppError>
  remove(accountId: string): Effect.Effect<void, AppError>
  models(accountId: string): Effect.Effect<readonly ModelInfo[], AppError>
  /** The connection of an API account, with its key. Fails when no key is stored. */
  connection(accountId: string): Effect.Effect<Connection, AppError>
  isConnected(accountId: string): boolean
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
          ? row.off === 0 && runtimes.ready(row.kind)
          : secrets.get(secretKey(row.id)) !== null
      const toAccount = (row: AccountRow): ProviderAccount => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        baseUrl: row.base_url,
        connected: rowConnected(row),
        ...(isRuntimeKind(row.kind) ? { runtime: runtimes.cached(row.kind) } : {}),
      })
      const lookup = (id: string) =>
        db.get<AccountRow>(
          "SELECT id, kind, name, base_url, off FROM provider_account WHERE id = ?",
          id,
        )
      const isConnected = (id: string) => {
        const row = lookup(id)
        return row ? rowConnected(row) : false
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
      const checkRuntime = (kind: RuntimeKind, fresh: boolean) =>
        Effect.gen(function* () {
          const status = yield* fresh ? runtimes.status(kind) : runtimes.statusIfStale(kind)
          if (status.source === null) return yield* new AppError({ code: "runtime_missing" })
          if (!status.signedIn) return yield* new AppError({ code: "runtime_not_signed_in" })
          if (status.method !== "subscription")
            return yield* new AppError({ code: "runtime_api_key_login" })
        })

      const connect = Effect.fn("Providers.connect")(function* (input: ProviderConnect) {
        const runtime = isRuntimeKind(input.kind) ? input.kind : null
        let models: readonly ModelInfo[] = []
        if (runtime) {
          yield* checkRuntime(runtime, true)
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
        if (input.accountId) {
          yield* findRow(input.accountId)
          db.run(
            "UPDATE provider_account SET kind = ?, name = ?, base_url = ?, off = 0 WHERE id = ?",
            input.kind,
            input.name.trim(),
            baseUrl,
            id,
          )
        } else {
          db.run(
            "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES (?, ?, ?, ?, ?)",
            id,
            input.kind,
            input.name.trim(),
            baseUrl,
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
                effort: input.effort,
                system: input.system,
                turns: input.turns,
                ...(input.tools ? { tools: input.tools } : {}),
                signal: input.signal,
              },
              hooks.execute,
            )
          }
          const kind = row.kind
          if (row.off !== 0) return yield* new AppError({ code: "provider_not_connected" })
          yield* checkRuntime(kind, false)
          const turn = runtimes.run(kind, {
            model: input.model,
            effort: input.effort,
            system: input.system,
            prompt: buildPrompt(input.turns),
            workspace: input.workspace,
            permission: input.permission,
            useTools: input.useTools,
            signal: input.signal,
            approve: hooks.approve,
          })
          return (async function* () {
            try {
              yield* turn
            } catch (error) {
              // The sign-in is gone: look again, so that the account shows the truth.
              if (error instanceof ProviderFailure && error.code === "runtime_signed_out")
                runtimes.invalidate(kind)
              throw error
            }
          })()
        })

      const refreshRuntimes = () =>
        Effect.forEach(
          [
            ...new Set(
              db
                .all<{ kind: ProviderKind }>("SELECT DISTINCT kind FROM provider_account")
                .map((r) => r.kind)
                .filter(isRuntimeKind),
            ),
          ],
          (kind) => runtimes.statusIfStale(kind),
          { concurrency: "unbounded", discard: true },
        )

      return Providers.of({
        list: Effect.gen(function* () {
          yield* refreshRuntimes()
          return db
            .all<AccountRow>(
              "SELECT id, kind, name, base_url, off FROM provider_account ORDER BY created_at",
            )
            .map(toAccount)
        }),
        connect,
        check: (id) =>
          findRow(id).pipe(
            Effect.flatMap((row) => {
              if (isRuntimeKind(row.kind)) {
                const kind = row.kind
                return checkRuntime(kind, true).pipe(
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
        verify: (id) =>
          Effect.gen(function* () {
            const row = lookup(id)
            if (!row) return false
            if (isRuntimeKind(row.kind)) yield* runtimes.statusIfStale(row.kind)
            return rowConnected(row)
          }),
        events,
      })
    }),
  )
}
