import { randomUUID } from "node:crypto"
import {
  isSecretValue,
  type SavedSecret,
  SECRETS_PER_AGENT,
  type SecretAuth,
  sameAuth,
  secretNameKey,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Secrets } from "./Secrets.ts"

interface Row {
  id: string
  agent_id: string
  name: string
  origin: string
  auth: string
  value_ref: string | null
  saved_at: number
  last_used_at: number | null
}

/** A saved secret with the means to read its value. Only the main process sees this. */
export interface StoredSecret extends SavedSecret {
  /** The value from the keychain, or null when this computer holds none. */
  readonly value: () => string | null
}

/** What an ask for a secret finds (spec 020, flow 1). */
export type SecretMatch =
  | { readonly kind: "new" }
  | { readonly kind: "same"; readonly secret: StoredSecret }
  | { readonly kind: "conflict"; readonly secret: StoredSecret }
  | { readonly kind: "full" }

export interface SavedSecretsService {
  list(agentId?: string): readonly SavedSecret[]
  find(agentId: string, name: string): StoredSecret | undefined
  match(agentId: string, name: string, origin: string, auth: SecretAuth): SecretMatch
  /**
   * Puts the value in the keychain and saves or updates the secret. A secret with the same name
   * keeps its id. Throws `AppError` when the value or the keychain fails.
   */
  save(
    agentId: string,
    secret: { name: string; origin: string; auth: SecretAuth },
    value: string,
  ): SavedSecret
  /** A new value for a saved secret, from settings. */
  replace(id: string, value: string): SavedSecret
  /** Deletes a secret and its value. False when it does not exist. */
  remove(id: string): boolean
  /** The time of the last use. */
  touch(id: string): void
  /** Every value that this computer holds. An export hides them in the text that it writes. */
  knownValues(): string[]
}

/** The name of a value in the keychain. */
export const savedSecretKey = (ref: string) => `saved-secret:${ref}`

const parseAuth = (text: string): SecretAuth => {
  try {
    const v = JSON.parse(text) as SecretAuth
    if (v.kind === "bearer" || v.kind === "header" || v.kind === "basic") return v
  } catch {}
  return { kind: "bearer" }
}

/** The saved secrets of spec 020. The values are in the keychain; the rows hold none. */
export class SavedSecrets extends Context.Service<SavedSecrets, SavedSecretsService>()(
  "robot/main/SavedSecrets",
) {
  static readonly layer = Layer.effect(
    SavedSecrets,
    Effect.gen(function* () {
      const db = yield* Database
      const keychain = yield* Secrets
      const bus = yield* EventBus

      const read = (ref: string | null): string | null => {
        if (!ref) return null
        try {
          return keychain.get(savedSecretKey(ref))
        } catch {
          // A keychain that cannot be read holds no value for the app.
          return null
        }
      }
      const drop = (ref: string) => {
        try {
          keychain.remove(savedSecretKey(ref))
        } catch {
          // The value is gone already.
        }
      }
      /** Removes the values that a deleted agent left. */
      const sweep = () => {
        for (const { value_ref } of db.all<{ value_ref: string }>(
          "SELECT value_ref FROM saved_secret_drop",
        )) {
          drop(value_ref)
          db.run("DELETE FROM saved_secret_drop WHERE value_ref = ?", value_ref)
        }
      }
      sweep()
      bus.tap((event) => {
        if (event === "agents.changed") sweep()
      })

      const toStored = (r: Row): StoredSecret => ({
        id: r.id,
        agentId: r.agent_id,
        name: r.name,
        origin: r.origin,
        auth: parseAuth(r.auth),
        savedAt: r.saved_at,
        lastUsedAt: r.last_used_at,
        valueMissing: read(r.value_ref) === null,
        value: () => read(r.value_ref),
      })
      const toView = (r: Row): SavedSecret => {
        const { value: _value, ...view } = toStored(r)
        return view
      }
      const changed = () => bus.emit("secrets.changed", {})
      const byId = (id: string) => db.get<Row>("SELECT * FROM saved_secret WHERE id = ?", id)
      const byName = (agentId: string, name: string) =>
        db.get<Row>(
          "SELECT * FROM saved_secret WHERE agent_id = ? AND name_key = ?",
          agentId,
          secretNameKey(name),
        )

      /** Puts a value in the keychain under a new name. */
      const store = (value: string) => {
        if (!isSecretValue(value)) throw new AppError({ code: "secret_value_invalid" })
        const ref = randomUUID()
        try {
          keychain.set(savedSecretKey(ref), value)
        } catch {
          throw new AppError({ code: "secret_keychain" })
        }
        return ref
      }

      const replaceRow = (row: Row, value: string, now: number) => {
        const ref = store(value)
        db.run("UPDATE saved_secret SET value_ref = ?, saved_at = ? WHERE id = ?", ref, now, row.id)
        if (row.value_ref) drop(row.value_ref)
      }

      return SavedSecrets.of({
        list: (agentId) =>
          (agentId
            ? db.all<Row>(
                "SELECT * FROM saved_secret WHERE agent_id = ? ORDER BY name_key",
                agentId,
              )
            : db.all<Row>("SELECT * FROM saved_secret ORDER BY agent_id, name_key")
          ).map(toView),
        find: (agentId, name) => {
          const row = byName(agentId, name)
          return row ? toStored(row) : undefined
        },
        match: (agentId, name, origin, auth) => {
          const row = byName(agentId, name)
          if (row) {
            const secret = toStored(row)
            return secret.origin === origin && sameAuth(secret.auth, auth)
              ? { kind: "same", secret }
              : { kind: "conflict", secret }
          }
          const count =
            db.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM saved_secret WHERE agent_id = ?",
              agentId,
            )?.n ?? 0
          return count >= SECRETS_PER_AGENT ? { kind: "full" } : { kind: "new" }
        },
        save: (agentId, secret, value) => {
          const now = Date.now()
          const row = byName(agentId, secret.name)
          if (row) {
            if (row.origin !== secret.origin || !sameAuth(parseAuth(row.auth), secret.auth))
              throw new AppError({ code: "secret_conflict" })
            replaceRow(row, value, now)
            changed()
            return toView(byId(row.id) as Row)
          }
          if (!db.get("SELECT 1 AS x FROM agent WHERE id = ?", agentId))
            throw new AppError({ code: "agent_not_found" })
          const count =
            db.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM saved_secret WHERE agent_id = ?",
              agentId,
            )?.n ?? 0
          if (count >= SECRETS_PER_AGENT) throw new AppError({ code: "secret_full" })
          const ref = store(value)
          const id = randomUUID()
          db.run(
            `INSERT INTO saved_secret (id, agent_id, name, name_key, origin, auth, value_ref, saved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            agentId,
            secret.name,
            secretNameKey(secret.name),
            secret.origin,
            JSON.stringify(secret.auth),
            ref,
            now,
          )
          changed()
          return toView(byId(id) as Row)
        },
        replace: (id, value) => {
          const row = byId(id)
          if (!row) throw new AppError({ code: "secret_not_found" })
          replaceRow(row, value, Date.now())
          changed()
          return toView(byId(id) as Row)
        },
        remove: (id) => {
          const row = byId(id)
          if (!row) return false
          if (row.value_ref) drop(row.value_ref)
          db.run("DELETE FROM saved_secret WHERE id = ?", id)
          changed()
          return true
        },
        touch: (id) => {
          db.run("UPDATE saved_secret SET last_used_at = ? WHERE id = ?", Date.now(), id)
          changed()
        },
        knownValues: () =>
          db
            .all<{ value_ref: string | null }>("SELECT value_ref FROM saved_secret")
            .map((r) => read(r.value_ref))
            .filter((v): v is string => v !== null),
      })
    }),
  )
}
