import { randomUUID } from "node:crypto"
import {
  isSecretName,
  isSecretValue,
  parseOrigin,
  type SavedSecret,
  SECRETS_PER_AGENT,
  type SecretAuth,
  type SecretTestResult,
  sameAuth,
  secretNameKey,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Rules } from "./Rules.ts"
import { type SecretLookup, testSecretRequest } from "./SecretRequest.ts"
import { Secrets } from "./Secrets.ts"

interface Row {
  id: string
  workflow_id: string
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
  list(workflowId?: string): readonly SavedSecret[]
  find(workflowId: string, name: string): StoredSecret | undefined
  match(workflowId: string, name: string, origin: string, auth: SecretAuth): SecretMatch
  /**
   * Puts the value in the keychain and saves or updates the secret. A secret with the same name
   * keeps its id. Throws `AppError` when the name, the origin, the value or the keychain fails.
   * A local origin needs `allowLocal`: the switch "Allow saved secrets on this computer and the
   * local network" (spec 020).
   */
  save(
    workflowId: string,
    secret: { name: string; origin: string; auth: SecretAuth },
    value: string,
    allowLocal?: boolean,
  ): SavedSecret
  /**
   * Adds a secret by hand in the vault (spec 020, flow 4, "Add"). A name that the vault already
   * holds is refused. Otherwise it saves like `save`.
   */
  add(
    workflowId: string,
    secret: { name: string; origin: string; auth: SecretAuth },
    value: string,
    allowLocal?: boolean,
  ): SavedSecret
  /**
   * Renames a secret (spec 020, flow 4, "Rename"). The permission rules of 007 that name the old
   * name move to the new name. A name that the vault already holds is refused.
   */
  rename(id: string, name: string): SavedSecret
  /**
   * Test (spec 020, flow 4, "Test"): sends a GET request to the origin with the secret. It shows
   * the status code on the row, or the reason, and never the value. Test does not change the
   * date last used.
   */
  test(
    id: string,
    allowLocal: boolean,
    options?: { timeoutMs?: number; lookup?: SecretLookup },
  ): Promise<SecretTestResult>
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
      const rules = yield* Rules
      const bus = yield* EventBus

      /**
       * The origin in canonical form. A public origin must use https; an address on this
       * computer or the local network needs the switch (spec 020, "Rules" and flow 4, "Add").
       */
      const checkOrigin = (origin: string, allowLocal: boolean) => {
        const parsed = parseOrigin(origin)
        if (!parsed.ok) throw new AppError({ code: "secret_origin_invalid" })
        if (parsed.local && !allowLocal) throw new AppError({ code: "secret_origin_local" })
        return parsed.origin
      }

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
      /** Removes the values that a deleted workflow left. */
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
        if (event === "workflows.changed") sweep()
      })

      const toStored = (r: Row): StoredSecret => ({
        id: r.id,
        workflowId: r.workflow_id,
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
      const byName = (workflowId: string, name: string) =>
        db.get<Row>(
          "SELECT * FROM saved_secret WHERE workflow_id = ? AND name_key = ?",
          workflowId,
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

      /** The name and the origin of a new or replaced secret, or the reason they are refused. */
      const validated = (secret: { name: string; origin: string }, allowLocal: boolean) => {
        if (!isSecretName(secret.name)) throw new AppError({ code: "secret_name_invalid" })
        return checkOrigin(secret.origin, allowLocal)
      }

      /** Inserts the row of a secret that the vault does not hold yet. */
      const insertNew = (
        workflowId: string,
        secret: { name: string; auth: SecretAuth },
        origin: string,
        value: string,
        now: number,
      ) => {
        if (!db.get("SELECT 1 AS x FROM workflow WHERE id = ?", workflowId))
          throw new AppError({ code: "workflow_not_found" })
        const count =
          db.get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM saved_secret WHERE workflow_id = ?",
            workflowId,
          )?.n ?? 0
        if (count >= SECRETS_PER_AGENT) throw new AppError({ code: "secret_full" })
        const ref = store(value)
        const id = randomUUID()
        db.run(
          `INSERT INTO saved_secret (id, workflow_id, name, name_key, origin, auth, value_ref, saved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          workflowId,
          secret.name,
          secretNameKey(secret.name),
          origin,
          JSON.stringify(secret.auth),
          ref,
          now,
        )
        changed()
        return toView(byId(id) as Row)
      }

      return SavedSecrets.of({
        list: (workflowId) => {
          try {
            // When the keychain cannot be read, the vault shows "Cannot read the vault."
            keychain.check()
          } catch {
            throw new AppError({ code: "secret_keychain_read" })
          }
          return (
            workflowId
              ? db.all<Row>(
                  "SELECT * FROM saved_secret WHERE workflow_id = ? ORDER BY name_key",
                  workflowId,
                )
              : db.all<Row>("SELECT * FROM saved_secret ORDER BY workflow_id, name_key")
          ).map(toView)
        },
        find: (workflowId, name) => {
          const row = byName(workflowId, name)
          return row ? toStored(row) : undefined
        },
        match: (workflowId, name, origin, auth) => {
          const row = byName(workflowId, name)
          if (row) {
            const secret = toStored(row)
            return secret.origin === origin && sameAuth(secret.auth, auth)
              ? { kind: "same", secret }
              : { kind: "conflict", secret }
          }
          const count =
            db.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM saved_secret WHERE workflow_id = ?",
              workflowId,
            )?.n ?? 0
          return count >= SECRETS_PER_AGENT ? { kind: "full" } : { kind: "new" }
        },
        save: (workflowId, secret, value, allowLocal = false) => {
          const origin = validated(secret, allowLocal)
          const now = Date.now()
          const row = byName(workflowId, secret.name)
          if (row) {
            if (row.origin !== origin || !sameAuth(parseAuth(row.auth), secret.auth))
              throw new AppError({ code: "secret_conflict" })
            replaceRow(row, value, now)
            changed()
            return toView(byId(row.id) as Row)
          }
          return insertNew(workflowId, secret, origin, value, now)
        },
        add: (workflowId, secret, value, allowLocal = false) => {
          const origin = validated(secret, allowLocal)
          if (byName(workflowId, secret.name)) throw new AppError({ code: "secret_name_taken" })
          return insertNew(workflowId, secret, origin, value, Date.now())
        },
        rename: (id, name) => {
          const row = byId(id)
          if (!row) throw new AppError({ code: "secret_not_found" })
          if (!isSecretName(name)) throw new AppError({ code: "secret_name_invalid" })
          const taken = byName(row.workflow_id, name)
          if (taken && taken.id !== id) throw new AppError({ code: "secret_name_taken" })
          db.run(
            "UPDATE saved_secret SET name = ?, name_key = ? WHERE id = ?",
            name,
            secretNameKey(name),
            id,
          )
          rules.renameSecret(row.workflow_id, row.name, name)
          changed()
          return toView(byId(id) as Row)
        },
        test: async (id, allowLocal, options) => {
          const row = byId(id)
          if (!row) throw new AppError({ code: "secret_not_found" })
          let value: string | null
          try {
            value = row.value_ref ? keychain.get(savedSecretKey(row.value_ref)) : null
          } catch {
            // Until the keychain can be read again, Test fails with the keychain reason.
            return { ok: false, reason: "keychain" } as const
          }
          if (value === null) return { ok: false, reason: "value_missing" } as const
          return testSecretRequest(row.origin, row.origin, parseAuth(row.auth), value, {
            allowLocal,
            ...options,
          })
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
