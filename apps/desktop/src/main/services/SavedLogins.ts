import { randomUUID } from "node:crypto"
import {
  isLoginUser,
  isSecretName,
  isSecretValue,
  LOGINS_PER_WORKFLOW,
  parseOrigin,
  type SavedLogin,
  secretNameKey,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Rules } from "./Rules.ts"
import { Secrets } from "./Secrets.ts"

interface Row {
  id: string
  workflow_id: string
  name: string
  origin: string
  value_ref: string | null
  saved_at: number
  last_used_at: number | null
}

/** A saved login with the means to read its values. Only the main process sees this. */
export interface StoredLogin extends SavedLogin {
  /** The user name from the keychain, or null when this computer holds none. */
  readonly userValue: () => string | null
  /** The password from the keychain, or null when this computer holds none. */
  readonly passwordValue: () => string | null
}

/** What an ask for a login finds (spec 020, "Saved logins"). */
export type LoginMatch =
  | { readonly kind: "new" }
  | { readonly kind: "same"; readonly login: StoredLogin }
  | { readonly kind: "conflict"; readonly login: StoredLogin }
  | { readonly kind: "full" }

export interface SavedLoginsService {
  list(workflowId?: string): readonly SavedLogin[]
  find(workflowId: string, name: string): StoredLogin | undefined
  match(workflowId: string, name: string, origin: string): LoginMatch
  /**
   * Puts both values in the keychain and saves or updates the login. A login with the same name
   * keeps its id. Throws `AppError` when a value or the keychain fails. A local origin needs
   * `allowLocal`: the switch "Allow saved secrets on this computer and the local network".
   */
  save(
    workflowId: string,
    login: { name: string; origin: string; user: string },
    password: string,
    allowLocal?: boolean,
  ): SavedLogin
  /**
   * Adds a login by hand in the vault (spec 020, "Manage"). A name that the vault already holds
   * is refused. Otherwise it saves like `save`.
   */
  add(
    workflowId: string,
    login: { name: string; origin: string; user: string },
    password: string,
    allowLocal?: boolean,
  ): SavedLogin
  /**
   * Renames a login (spec 020, "Manage"). The permission rules of 007 that name the old name move
   * to the new name. A name that the vault already holds is refused.
   */
  rename(id: string, name: string): SavedLogin
  /** New values for a saved login: the user name and the password together. */
  replace(id: string, user: string, password: string): SavedLogin
  /** Deletes a login and its values. False when it does not exist. */
  remove(id: string): boolean
  /** The time of the last fill. */
  touch(id: string): void
}

/** The names of the two values in the keychain. */
export const savedLoginUserKey = (ref: string) => `saved-login-user:${ref}`
export const savedLoginPasswordKey = (ref: string) => `saved-login-password:${ref}`

/** The saved logins of spec 020. The values are in the keychain; the rows hold none. */
export class SavedLogins extends Context.Service<SavedLogins, SavedLoginsService>()(
  "robot/main/SavedLogins",
) {
  static readonly layer = Layer.effect(
    SavedLogins,
    Effect.gen(function* () {
      const db = yield* Database
      const keychain = yield* Secrets
      const rules = yield* Rules
      const bus = yield* EventBus

      /**
       * The origin in canonical form. A public origin must use https; an address on this
       * computer or the local network needs the switch (spec 020).
       */
      const checkOrigin = (origin: string, allowLocal: boolean) => {
        const parsed = parseOrigin(origin)
        if (!parsed.ok) throw new AppError({ code: "secret_origin_invalid" })
        if (parsed.local && !allowLocal) throw new AppError({ code: "secret_origin_local" })
        return parsed.origin
      }

      const read = (key: string | null): string | null => {
        if (!key) return null
        try {
          return keychain.get(key)
        } catch {
          // A keychain that cannot be read holds no value for the app.
          return null
        }
      }
      const drop = (ref: string) => {
        for (const key of [savedLoginUserKey(ref), savedLoginPasswordKey(ref)]) {
          try {
            keychain.remove(key)
          } catch {
            // The value is gone already.
          }
        }
      }
      /** Removes the values that a deleted workflow left. */
      const sweep = () => {
        for (const { kind, value_ref } of db.all<{ kind: string; value_ref: string }>(
          "SELECT kind, value_ref FROM saved_login_drop",
        )) {
          try {
            keychain.remove(
              kind === "user" ? savedLoginUserKey(value_ref) : savedLoginPasswordKey(value_ref),
            )
          } catch {
            // The value is gone already.
          }
          db.run("DELETE FROM saved_login_drop WHERE kind = ? AND value_ref = ?", kind, value_ref)
        }
      }
      sweep()
      bus.tap((event) => {
        if (event === "workflows.changed") sweep()
      })

      const toStored = (r: Row): StoredLogin => ({
        id: r.id,
        workflowId: r.workflow_id,
        name: r.name,
        origin: r.origin,
        user: read(r.value_ref ? savedLoginUserKey(r.value_ref) : null) ?? "",
        savedAt: r.saved_at,
        lastUsedAt: r.last_used_at,
        valueMissing:
          read(r.value_ref ? savedLoginUserKey(r.value_ref) : null) === null ||
          read(r.value_ref ? savedLoginPasswordKey(r.value_ref) : null) === null,
        userValue: () => read(r.value_ref ? savedLoginUserKey(r.value_ref) : null),
        passwordValue: () => read(r.value_ref ? savedLoginPasswordKey(r.value_ref) : null),
      })
      const toView = (r: Row): SavedLogin => {
        const { userValue: _userValue, passwordValue: _passwordValue, ...view } = toStored(r)
        return view
      }
      const changed = () => bus.emit("secrets.changed", {})
      const byId = (id: string) => db.get<Row>("SELECT * FROM saved_login WHERE id = ?", id)
      const byName = (workflowId: string, name: string) =>
        db.get<Row>(
          "SELECT * FROM saved_login WHERE workflow_id = ? AND name_key = ?",
          workflowId,
          secretNameKey(name),
        )

      /** Puts both values in the keychain under a new name. */
      const store = (user: string, password: string) => {
        if (!isLoginUser(user) || !isSecretValue(password))
          throw new AppError({ code: "login_value_invalid" })
        const ref = randomUUID()
        try {
          keychain.set(savedLoginUserKey(ref), user)
          keychain.set(savedLoginPasswordKey(ref), password)
        } catch {
          throw new AppError({ code: "secret_keychain" })
        }
        return ref
      }

      const replaceRow = (row: Row, user: string, password: string, now: number) => {
        const ref = store(user, password)
        db.run("UPDATE saved_login SET value_ref = ?, saved_at = ? WHERE id = ?", ref, now, row.id)
        if (row.value_ref) drop(row.value_ref)
      }

      return SavedLogins.of({
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
                  "SELECT * FROM saved_login WHERE workflow_id = ? ORDER BY name_key",
                  workflowId,
                )
              : db.all<Row>("SELECT * FROM saved_login ORDER BY workflow_id, name_key")
          ).map(toView)
        },
        find: (workflowId, name) => {
          const row = byName(workflowId, name)
          return row ? toStored(row) : undefined
        },
        match: (workflowId, name, origin) => {
          const row = byName(workflowId, name)
          if (row) {
            const login = toStored(row)
            return login.origin === origin ? { kind: "same", login } : { kind: "conflict", login }
          }
          const count =
            db.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM saved_login WHERE workflow_id = ?",
              workflowId,
            )?.n ?? 0
          return count >= LOGINS_PER_WORKFLOW ? { kind: "full" } : { kind: "new" }
        },
        save: (workflowId, login, password, allowLocal = false) => {
          if (!isSecretName(login.name)) throw new AppError({ code: "login_name_invalid" })
          const origin = checkOrigin(login.origin, allowLocal)
          const now = Date.now()
          const row = byName(workflowId, login.name)
          if (row) {
            if (row.origin !== origin) throw new AppError({ code: "login_conflict" })
            replaceRow(row, login.user, password, now)
            changed()
            return toView(byId(row.id) as Row)
          }
          if (!db.get("SELECT 1 AS x FROM workflow WHERE id = ?", workflowId))
            throw new AppError({ code: "workflow_not_found" })
          const count =
            db.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM saved_login WHERE workflow_id = ?",
              workflowId,
            )?.n ?? 0
          if (count >= LOGINS_PER_WORKFLOW) throw new AppError({ code: "login_full" })
          const ref = store(login.user, password)
          const id = randomUUID()
          db.run(
            `INSERT INTO saved_login (id, workflow_id, name, name_key, origin, value_ref, saved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            id,
            workflowId,
            login.name,
            secretNameKey(login.name),
            origin,
            ref,
            now,
          )
          changed()
          return toView(byId(id) as Row)
        },
        add: (workflowId, login, password, allowLocal = false) => {
          if (!isSecretName(login.name)) throw new AppError({ code: "login_name_invalid" })
          const origin = checkOrigin(login.origin, allowLocal)
          if (byName(workflowId, login.name)) throw new AppError({ code: "login_name_taken" })
          if (!db.get("SELECT 1 AS x FROM workflow WHERE id = ?", workflowId))
            throw new AppError({ code: "workflow_not_found" })
          const count =
            db.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM saved_login WHERE workflow_id = ?",
              workflowId,
            )?.n ?? 0
          if (count >= LOGINS_PER_WORKFLOW) throw new AppError({ code: "login_full" })
          const ref = store(login.user, password)
          const id = randomUUID()
          db.run(
            `INSERT INTO saved_login (id, workflow_id, name, name_key, origin, value_ref, saved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            id,
            workflowId,
            login.name,
            secretNameKey(login.name),
            origin,
            ref,
            Date.now(),
          )
          changed()
          return toView(byId(id) as Row)
        },
        rename: (id, name) => {
          const row = byId(id)
          if (!row) throw new AppError({ code: "login_not_found" })
          if (!isSecretName(name)) throw new AppError({ code: "login_name_invalid" })
          const taken = byName(row.workflow_id, name)
          if (taken && taken.id !== id) throw new AppError({ code: "login_name_taken" })
          db.run(
            "UPDATE saved_login SET name = ?, name_key = ? WHERE id = ?",
            name,
            secretNameKey(name),
            id,
          )
          rules.renameSecret(row.workflow_id, row.name, name)
          changed()
          return toView(byId(id) as Row)
        },
        replace: (id, user, password) => {
          const row = byId(id)
          if (!row) throw new AppError({ code: "login_not_found" })
          replaceRow(row, user, password, Date.now())
          changed()
          return toView(byId(id) as Row)
        },
        remove: (id) => {
          const row = byId(id)
          if (!row) return false
          if (row.value_ref) drop(row.value_ref)
          db.run("DELETE FROM saved_login WHERE id = ?", id)
          changed()
          return true
        },
        touch: (id) => {
          db.run("UPDATE saved_login SET last_used_at = ? WHERE id = ?", Date.now(), id)
          changed()
        },
      })
    }),
  )
}
