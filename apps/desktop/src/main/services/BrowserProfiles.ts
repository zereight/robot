import { randomUUID } from "node:crypto"
import {
  type BrowserProfile,
  browserProfilesFull,
  checkBrowserProfileName,
  nameKey,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"

interface ProfileRow {
  id: string
  name: string
  created_at: number
  purpose: string | null
}

export interface BrowserProfilesService {
  /** Every browser profile of this computer, by name, with the workflows that use it. */
  list: Effect.Effect<readonly BrowserProfile[]>
  create(name: string): Effect.Effect<BrowserProfile, AppError>
  rename(id: string, name: string): Effect.Effect<BrowserProfile, AppError>
  /**
   * Deletes a profile and the browser data it holds. Its workflows go back to their own data, and
   * their open pages close.
   */
  remove(id: string): Effect.Effect<void, AppError>
  /**
   * Gives a workflow a profile, or its own data again (`null`). An open page of the workflow
   * closes.
   */
  assign(workflowId: string, profileId: string | null): Effect.Effect<void, AppError>
}

/**
 * The browser profiles (spec 007, "Rules"): named sets of saved browser data that the user makes,
 * deletes and gives to workflows. A workflow without one keeps its own data, as before. The profiles and
 * the choices stay on this computer.
 */
export class BrowserProfiles extends Context.Service<BrowserProfiles, BrowserProfilesService>()(
  "robot/main/BrowserProfiles",
) {
  static readonly layer = Layer.effect(
    BrowserProfiles,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const platform = yield* Platform

      const SELECT = "SELECT id, name, created_at, purpose FROM browser_profile"
      const rows = () => db.all<ProfileRow>(`${SELECT} ORDER BY name_key, created_at`)
      const userRows = rows
      const workflowsOf = (id: string) =>
        db
          .all<{ workflow_id: string }>(
            "SELECT workflow_id FROM workflow_browser WHERE profile_id = ? ORDER BY workflow_id",
            id,
          )
          .map((r) => r.workflow_id)
      const toProfile = (row: ProfileRow): BrowserProfile => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        workflowIds: workflowsOf(row.id),
      })
      const find = (id: string) =>
        Effect.suspend(() => {
          const row = db.get<ProfileRow>(`${SELECT} WHERE id = ?`, id)
          return row
            ? Effect.succeed(row)
            : Effect.fail(new AppError({ code: "browser_profile_not_found" }))
        })
      const changed = () => bus.emit("browserProfiles.changed", {})

      /** Checks a name against the other profiles. Returns the trimmed name. */
      const goodName = (name: string, exceptId: string) => {
        const others = userRows()
          .filter((r) => r.id !== exceptId)
          .map((r) => r.name)
        const problem = checkBrowserProfileName(name, others)
        if (problem === "taken")
          return Effect.fail(new AppError({ code: "browser_profile_name_taken" }))
        if (problem) return Effect.fail(new AppError({ code: "browser_profile_name_invalid" }))
        return Effect.succeed(name.trim())
      }

      // The browser of each workflow must know its profile before a page opens.
      for (const r of db.all<{ workflow_id: string; profile_id: string }>(
        "SELECT workflow_id, profile_id FROM workflow_browser",
      ))
        platform.setBrowserProfile(r.workflow_id, r.profile_id)

      return BrowserProfiles.of({
        list: Effect.sync(() => rows().map(toProfile)),

        create: Effect.fn("BrowserProfiles.create")(function* (name: string) {
          const next = yield* goodName(name, "")
          if (browserProfilesFull(userRows().length))
            return yield* new AppError({ code: "browser_profile_limit" })
          const id = randomUUID()
          db.run(
            "INSERT INTO browser_profile (id, name, name_key, created_at) VALUES (?, ?, ?, ?)",
            id,
            next,
            nameKey(next),
            Date.now(),
          )
          changed()
          return toProfile(yield* find(id))
        }),

        rename: Effect.fn("BrowserProfiles.rename")(function* (id: string, name: string) {
          const _row = yield* find(id)
          const next = yield* goodName(name, id)
          db.run(
            "UPDATE browser_profile SET name = ?, name_key = ? WHERE id = ?",
            next,
            nameKey(next),
            id,
          )
          changed()
          return toProfile(yield* find(id))
        }),

        remove: Effect.fn("BrowserProfiles.remove")(function* (id: string) {
          yield* find(id)
          const users = workflowsOf(id)
          // The workflows let go first: this closes their pages, so that no page uses the data
          // while it is deleted.
          for (const workflowId of users) platform.setBrowserProfile(workflowId, undefined)
          db.run("DELETE FROM browser_profile WHERE id = ?", id)
          yield* Effect.tryPromise({
            try: () => platform.clearBrowserProfile(id),
            catch: (e) => new AppError({ code: "browser_profile_clear_failed", detail: String(e) }),
          })
          changed()
        }),

        assign: Effect.fn("BrowserProfiles.assign")(function* (
          workflowId: string,
          profileId: string | null,
        ) {
          if (!db.get("SELECT 1 AS x FROM workflow WHERE id = ?", workflowId))
            return yield* new AppError({ code: "workflow_not_found" })
          if (profileId !== null) yield* find(profileId)
          const before =
            db.get<{ profile_id: string }>(
              "SELECT profile_id FROM workflow_browser WHERE workflow_id = ?",
              workflowId,
            )?.profile_id ?? null
          if (before === profileId) return
          if (profileId === null)
            db.run("DELETE FROM workflow_browser WHERE workflow_id = ?", workflowId)
          else
            db.run(
              "INSERT OR REPLACE INTO workflow_browser (workflow_id, profile_id) VALUES (?, ?)",
              workflowId,
              profileId,
            )
          platform.setBrowserProfile(workflowId, profileId ?? undefined)
          changed()
        }),
      })
    }),
  )
}
