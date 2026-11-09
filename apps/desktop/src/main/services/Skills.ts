import { randomUUID } from "node:crypto"
import {
  checkSkill,
  copySkillName,
  numberedSkillName,
  SKILLS_MAX,
  type Skill,
  type SkillFactResult,
  type SkillInput,
  skillName,
  skillNameKey,
  skillProblems,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"

interface SkillRow {
  id: string
  server_id: string
  name: string
  description: string
  instructions: string
  enabled: number
  created_at: number
}

const toSkill = (row: SkillRow): Skill => ({
  id: row.id,
  name: row.name,
  description: row.description,
  instructions: row.instructions,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
})

/** Skills (spec 017) belong to the server. Every workflow of the server can use them. */
export interface SkillsService {
  /** The skills of a server, in alphabetical order of their names. */
  list(serverId: string): Effect.Effect<readonly Skill[]>
  /**
   * Makes a skill on a server (spec 017, flow 1), turned on. The checks of the form apply: the
   * reason of a failure is the code of the first problem. A name that is taken is refused, and so
   * is a full server (100).
   */
  create(serverId: string, input: SkillInput): Effect.Effect<Skill, AppError>
  /**
   * Edit (spec 017, flow 2): changes every field of a skill. It stays on or off as it was. The
   * checks of the form apply, and the name may stay the one it has.
   */
  update(id: string, input: SkillInput): Effect.Effect<Skill, AppError>
  /**
   * Duplicate (spec 017, flow 3): a copy with the same fields. `suffix` is the word "copy" in the
   * language of the window. The copy is off until the user turns it on.
   */
  duplicate(id: string, suffix: string): Effect.Effect<Skill, AppError>
  /** Turns a skill on or off. */
  setEnabled(id: string, enabled: boolean): Effect.Effect<Skill, AppError>
  /** Deletes a skill. Old messages that used it keep their chip and their copy. */
  remove(id: string): Effect.Effect<void, AppError>
  /** The skills of a server that are on. */
  enabled(serverId: string): Effect.Effect<readonly Skill[]>
  /** True when a skill of the server has this name, ignoring case and a slash at the start. */
  nameTaken(serverId: string, name: string): boolean
  /** How many more skills a server can hold (the limit is 100). */
  room(serverId: string): Effect.Effect<number>
  /** A skill that a workflow may use now: it exists and it is on. */
  usable(skillId: string): Effect.Effect<Skill, AppError>
  /**
   * The skill check (spec 017): facts about one skill and the other skills of its server. It reads
   * only and asks no model. A skill that is gone gives "Saved" as failed and the rest not checked.
   */
  check(id: string): Effect.Effect<readonly SkillFactResult[]>
}

export class Skills extends Context.Service<Skills, SkillsService>()("robot/main/Skills") {
  static readonly layer = Layer.effect(
    Skills,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus

      const nameTaken = (serverId: string, name: string) =>
        Boolean(
          db.get(
            "SELECT 1 FROM skill WHERE server_id = ? AND name_key = ?",
            serverId,
            skillNameKey(name),
          ),
        )

      const changed = (serverId: string) => bus.emit("skills.changed", { serverId })

      const insert = (
        serverId: string,
        input: SkillInput,
        options?: { readonly numbered?: boolean; readonly enabled?: boolean },
      ) =>
        Effect.gen(function* () {
          const problem = skillProblems(input)[0]
          if (problem) return yield* new AppError({ code: problem.code, detail: problem.field })
          const taken = (candidate: string) => nameTaken(serverId, candidate)
          const wanted = skillName(input.name)
          if (!options?.numbered && taken(wanted))
            return yield* new AppError({ code: "skill_name_taken", detail: "name" })
          const name = options?.numbered ? numberedSkillName(wanted, taken) : wanted
          const count =
            db.get<{ n: number }>("SELECT COUNT(*) AS n FROM skill WHERE server_id = ?", serverId)
              ?.n ?? 0
          if (count >= SKILLS_MAX) return yield* new AppError({ code: "skills_full" })
          const id = randomUUID()
          db.run(
            `INSERT INTO skill (id, server_id, name, name_key, description, instructions, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            serverId,
            name,
            skillNameKey(name),
            input.description.trim(),
            input.instructions,
            options?.enabled === false ? 0 : 1,
            Date.now(),
          )
          changed(serverId)
          return toSkill(db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", id) as SkillRow)
        })

      const find = (id: string) => {
        const row = db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", id)
        return row ? Effect.succeed(row) : Effect.fail(new AppError({ code: "skill_unavailable" }))
      }

      return Skills.of({
        list: (serverId) =>
          Effect.sync(() =>
            db
              .all<SkillRow>("SELECT * FROM skill WHERE server_id = ?", serverId)
              .map(toSkill)
              .sort((a, b) => a.name.localeCompare(b.name)),
          ),
        create: (serverId, input) =>
          Effect.gen(function* () {
            if (!db.get("SELECT 1 FROM server WHERE id = ?", serverId))
              return yield* new AppError({ code: "server_not_found" })
            return yield* insert(serverId, input)
          }),
        update: (id, input) =>
          Effect.gen(function* () {
            const row = yield* find(id)
            const problem = skillProblems(input)[0]
            if (problem) return yield* new AppError({ code: problem.code, detail: problem.field })
            const name = skillName(input.name)
            const other = db.get(
              "SELECT 1 FROM skill WHERE server_id = ? AND name_key = ? AND id <> ?",
              row.server_id,
              skillNameKey(name),
              id,
            )
            if (other) return yield* new AppError({ code: "skill_name_taken", detail: "name" })
            db.run(
              `UPDATE skill SET name = ?, name_key = ?, description = ?, instructions = ? WHERE id = ?`,
              name,
              skillNameKey(name),
              input.description.trim(),
              input.instructions,
              id,
            )
            changed(row.server_id)
            return toSkill(db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", id) as SkillRow)
          }),
        duplicate: (id, suffix) =>
          Effect.gen(function* () {
            const row = yield* find(id)
            const source = toSkill(row)
            const name = copySkillName(source.name, suffix, (candidate) =>
              nameTaken(row.server_id, candidate),
            )
            return yield* insert(
              row.server_id,
              { name, description: source.description, instructions: source.instructions },
              { enabled: false },
            )
          }),
        setEnabled: (id, enabled) =>
          Effect.gen(function* () {
            const row = yield* find(id)
            db.run("UPDATE skill SET enabled = ? WHERE id = ?", enabled ? 1 : 0, id)
            changed(row.server_id)
            return toSkill({ ...row, enabled: enabled ? 1 : 0 })
          }),
        remove: (id) =>
          Effect.gen(function* () {
            const row = yield* find(id)
            db.run("DELETE FROM skill WHERE id = ?", id)
            changed(row.server_id)
          }),
        enabled: (serverId) =>
          Effect.sync(() =>
            db
              .all<SkillRow>("SELECT * FROM skill WHERE server_id = ? AND enabled = 1", serverId)
              .map(toSkill)
              .sort((a, b) => a.name.localeCompare(b.name)),
          ),
        nameTaken,
        room: (serverId) =>
          Effect.sync(() => {
            const count =
              db.get<{ n: number }>("SELECT COUNT(*) AS n FROM skill WHERE server_id = ?", serverId)
                ?.n ?? 0
            return Math.max(0, SKILLS_MAX - count)
          }),
        check: (id) =>
          Effect.sync(() => {
            const row = db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", id)
            if (!row) return checkSkill(null, [])
            const all = db.all<SkillRow>("SELECT * FROM skill WHERE server_id = ?", row.server_id)
            return checkSkill(toSkill(row), all.map(toSkill))
          }),
        usable: (skillId) =>
          Effect.gen(function* () {
            const row = yield* find(skillId)
            if (row.enabled !== 1) return yield* new AppError({ code: "skill_unavailable" })
            return toSkill(row)
          }),
      })
    }),
  )
}
