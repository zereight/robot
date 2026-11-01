import { randomUUID } from "node:crypto"
import type { ModelInfo, ProviderAccount, ProviderConnect, ProviderKind } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { type Connection, listModels, ProviderFailure } from "../providers/client.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Secrets } from "./Secrets.ts"

interface AccountRow {
  id: string
  kind: ProviderKind
  name: string
  base_url: string
}

export interface ProvidersService {
  readonly list: Effect.Effect<readonly ProviderAccount[]>
  /** Checks the key with one request, then stores the account and the key. */
  connect(input: ProviderConnect): Effect.Effect<ProviderAccount, AppError>
  check(accountId: string): Effect.Effect<void, AppError>
  disconnect(accountId: string): Effect.Effect<void, AppError>
  remove(accountId: string): Effect.Effect<void, AppError>
  models(accountId: string): Effect.Effect<readonly ModelInfo[], AppError>
  /** The connection of an account, with its key. Fails when no key is stored. */
  connection(accountId: string): Effect.Effect<Connection, AppError>
  isConnected(accountId: string): boolean
}

const secretKey = (accountId: string) => `provider:${accountId}`

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
      const modelCache = new Map<string, readonly ModelInfo[]>()

      const isConnected = (id: string) => secrets.get(secretKey(id)) !== null
      const toAccount = (row: AccountRow): ProviderAccount => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        baseUrl: row.base_url,
        connected: isConnected(row.id),
      })
      const findRow = (id: string) =>
        Effect.suspend(() => {
          const row = db.get<AccountRow>(
            "SELECT id, kind, name, base_url FROM provider_account WHERE id = ?",
            id,
          )
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
          Effect.flatMap((row) => {
            const apiKey = secrets.get(secretKey(id))
            return apiKey
              ? Effect.succeed({ kind: row.kind, baseUrl: row.base_url, apiKey })
              : Effect.fail(new AppError({ code: "provider_not_connected" }))
          }),
        )

      const connect = Effect.fn("Providers.connect")(function* (input: ProviderConnect) {
        const models = yield* fetchModels({
          kind: input.kind,
          baseUrl: input.baseUrl,
          apiKey: input.apiKey,
        })
        const id = input.accountId ?? randomUUID()
        if (input.accountId) {
          yield* findRow(input.accountId)
          db.run(
            "UPDATE provider_account SET kind = ?, name = ?, base_url = ? WHERE id = ?",
            input.kind,
            input.name.trim(),
            input.baseUrl,
            id,
          )
        } else {
          db.run(
            "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES (?, ?, ?, ?, ?)",
            id,
            input.kind,
            input.name.trim(),
            input.baseUrl,
            Date.now(),
          )
        }
        secrets.set(secretKey(id), input.apiKey)
        modelCache.set(id, models)
        changed()
        return toAccount(yield* findRow(id))
      })

      return Providers.of({
        list: Effect.sync(() =>
          db
            .all<AccountRow>(
              "SELECT id, kind, name, base_url FROM provider_account ORDER BY created_at",
            )
            .map(toAccount),
        ),
        connect,
        check: (id) =>
          connection(id).pipe(
            Effect.flatMap(fetchModels),
            Effect.tap((models) => Effect.sync(() => modelCache.set(id, models))),
            Effect.asVoid,
          ),
        disconnect: (id) =>
          findRow(id).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                secrets.remove(secretKey(id))
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
        models: (id) => {
          const cached = modelCache.get(id)
          if (cached) return Effect.succeed(cached)
          return connection(id).pipe(
            Effect.flatMap(fetchModels),
            Effect.tap((models) => Effect.sync(() => modelCache.set(id, models))),
          )
        },
        connection,
        isConnected,
      })
    }),
  )
}
