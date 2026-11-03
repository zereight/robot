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
import { Tools } from "./Tools.ts"

interface ProfileRow {
  id: string
  name: string
  created_at: number
  purpose: string | null
}

/** The `purpose` of the sign-in profile that the app makes for the Teams link (spec 028). */
const TEAMS_PURPOSE = "teams"
/**
 * The name key of that profile. It starts with a control character, which a name typed in a form
 * does not hold, so the profile does not clash with the name of a profile of the user.
 */
const TEAMS_NAME_KEY = "\u0001teams-link"

export interface BrowserProfilesService {
  /** Every browser profile of this computer, by name, with the agents that use it. */
  list: Effect.Effect<readonly BrowserProfile[]>
  create(name: string): Effect.Effect<BrowserProfile, AppError>
  rename(id: string, name: string): Effect.Effect<BrowserProfile, AppError>
  /**
   * Deletes a profile and the browser data it holds. Its agents go back to their own data, and
   * their open pages close.
   */
  remove(id: string): Effect.Effect<void, AppError>
  /**
   * Gives an agent a profile, or its own data again (`null`). An open page of the agent closes.
   * It fails while the user holds the browser of the agent. It refuses the sign-in profile of the
   * Teams link: no agent can get it (spec 028).
   */
  assign(agentId: string, profileId: string | null): Effect.Effect<void, AppError>
  /**
   * The sign-in profile of the Teams link (spec 028). The app makes it the first time it is needed.
   * It has no agent, and it is not in the limit of profiles. The user cannot rename or delete it:
   * "Remove link" does.
   */
  teamsProfile: Effect.Effect<BrowserProfile>
  /** Deletes the saved sign-in of the Teams link. The profile stays. */
  clearTeamsSignIn: Effect.Effect<void, AppError>
  /** Deletes the sign-in profile and the saved data in it ("Remove link"). */
  removeTeamsProfile: Effect.Effect<void, AppError>
}

/**
 * The browser profiles (spec 007, "Rules"): named sets of saved browser data that the user makes,
 * deletes and gives to agents. An agent without one keeps its own data, as before. The profiles and
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
      const tools = yield* Tools

      const SELECT = "SELECT id, name, created_at, purpose FROM browser_profile"
      /** Every profile, with the sign-in profile of the Teams link. */
      const rows = () => db.all<ProfileRow>(`${SELECT} ORDER BY name_key, created_at`)
      /** The profiles that the user made. The sign-in profile of the Teams link is not one. */
      const userRows = () => rows().filter((r) => r.purpose === null)
      const teamsRow = () => db.get<ProfileRow>(`${SELECT} WHERE purpose = ?`, TEAMS_PURPOSE)
      const agentsOf = (id: string) =>
        db
          .all<{ agent_id: string }>(
            "SELECT agent_id FROM agent_browser WHERE profile_id = ? ORDER BY agent_id",
            id,
          )
          .map((r) => r.agent_id)
      const toProfile = (row: ProfileRow): BrowserProfile => ({
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        agentIds: row.purpose === null ? agentsOf(row.id) : [],
        teamsLink: row.purpose === TEAMS_PURPOSE,
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

      // The browser of each agent must know its profile before a page opens.
      for (const r of db.all<{ agent_id: string; profile_id: string }>(
        "SELECT agent_id, profile_id FROM agent_browser",
      ))
        platform.setBrowserProfile(r.agent_id, r.profile_id)

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
          const row = yield* find(id)
          if (row.purpose !== null) return yield* new AppError({ code: "browser_profile_reserved" })
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
          const row = yield* find(id)
          if (row.purpose !== null) return yield* new AppError({ code: "browser_profile_reserved" })
          const users = agentsOf(id)
          // The user may hold the browser of an agent that uses the profile. Wait for that.
          if (users.some((agentId) => tools.browserState(agentId).control))
            return yield* new AppError({ code: "browser_profile_busy" })
          // The agents let go first: this closes their pages, so that no page uses the data while
          // it is deleted.
          for (const agentId of users) platform.setBrowserProfile(agentId, undefined)
          db.run("DELETE FROM browser_profile WHERE id = ?", id)
          yield* Effect.tryPromise({
            try: () => platform.clearBrowserProfile(id),
            catch: (e) => new AppError({ code: "browser_profile_clear_failed", detail: String(e) }),
          })
          changed()
        }),

        assign: Effect.fn("BrowserProfiles.assign")(function* (
          agentId: string,
          profileId: string | null,
        ) {
          if (!db.get("SELECT 1 AS x FROM agent WHERE id = ?", agentId))
            return yield* new AppError({ code: "agent_not_found" })
          if (profileId !== null) {
            const target = yield* find(profileId)
            // The sign-in profile of the Teams link is for the link only (spec 028).
            if (target.purpose !== null)
              return yield* new AppError({ code: "browser_profile_reserved" })
          }
          const before =
            db.get<{ profile_id: string }>(
              "SELECT profile_id FROM agent_browser WHERE agent_id = ?",
              agentId,
            )?.profile_id ?? null
          if (before === profileId) return
          // A page that the user holds, or teaches in, does not close under the user's hands.
          if (tools.browserState(agentId).control)
            return yield* new AppError({ code: "browser_profile_busy" })
          if (profileId === null) db.run("DELETE FROM agent_browser WHERE agent_id = ?", agentId)
          else
            db.run(
              "INSERT OR REPLACE INTO agent_browser (agent_id, profile_id) VALUES (?, ?)",
              agentId,
              profileId,
            )
          platform.setBrowserProfile(agentId, profileId ?? undefined)
          changed()
        }),

        teamsProfile: Effect.sync(() => {
          const known = teamsRow()
          if (known) return toProfile(known)
          const id = randomUUID()
          db.run(
            "INSERT INTO browser_profile (id, name, name_key, created_at, purpose) VALUES (?, ?, ?, ?, ?)",
            id,
            "Teams link",
            TEAMS_NAME_KEY,
            Date.now(),
            TEAMS_PURPOSE,
          )
          changed()
          return toProfile(teamsRow() as ProfileRow)
        }),

        clearTeamsSignIn: Effect.suspend(() => {
          const row = teamsRow()
          if (!row) return Effect.void
          return Effect.tryPromise({
            try: () => platform.clearBrowserProfile(row.id),
            catch: (e) => new AppError({ code: "browser_profile_clear_failed", detail: String(e) }),
          })
        }),

        removeTeamsProfile: Effect.suspend(() => {
          const row = teamsRow()
          if (!row) return Effect.void
          db.run("DELETE FROM browser_profile WHERE id = ?", row.id)
          return Effect.tryPromise({
            try: () => platform.clearBrowserProfile(row.id),
            catch: (e) => new AppError({ code: "browser_profile_clear_failed", detail: String(e) }),
          }).pipe(Effect.tap(() => Effect.sync(changed)))
        }),
      })
    }),
  )
}
