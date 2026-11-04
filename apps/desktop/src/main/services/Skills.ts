import { randomUUID } from "node:crypto"
import {
  numberedSkillName,
  SKILLS_MAX,
  type Skill,
  type SkillInput,
  skillName,
  skillNameKey,
  skillProblems,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { skillsOnlyFor } from "./agentSkills.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"

interface SkillRow {
  id: string
  server_id: string
  name: string
  description: string
  instructions: string
  agents: string | null
  enabled: number
  created_at: number
}

const toSkill = (row: SkillRow): Skill => ({
  id: row.id,
  name: row.name,
  description: row.description,
  instructions: row.instructions,
  agentIds: row.agents === null ? null : (JSON.parse(row.agents) as string[]),
  enabled: row.enabled === 1,
  createdAt: row.created_at,
})

export interface SkillsService {
  /** The skills of a server, in alphabetical order of their names. */
  list(serverId: string): Effect.Effect<readonly Skill[]>
  /**
   * Makes a skill on a server (spec 017, flow 1), turned on. `agentIds` is the list of agents that
   * may use it, or `null` for all agents. The checks of the form apply: the reason of a failure is
   * the code of the first problem. A name that is taken is refused, and so is a full server (100).
   */
  create(
    serverId: string,
    input: SkillInput,
    agentIds: readonly string[] | null,
  ): Effect.Effect<Skill, AppError>
  /** Turns a skill on or off. */
  setEnabled(id: string, enabled: boolean): Effect.Effect<Skill, AppError>
  /** Deletes a skill. Old messages that used it keep their chip and their copy. */
  remove(id: string): Effect.Effect<void, AppError>
  /** The skills that an agent may use now: on, and for this agent or for all agents. */
  forAgent(agentId: string): Effect.Effect<readonly Skill[]>
  /** True when a skill of the server has this name, ignoring case and a slash at the start. */
  nameTaken(serverId: string, name: string): boolean
  /**
   * Makes a skill on the server of the agent, for this agent only, turned on. The checks of the
   * skill form apply (spec 017): the reason of a failure is the code of the first problem.
   * With `numbered`, a name that is taken gets a number ("Name 2") and is not refused. A starter
   * uses it (spec 002).
   */
  createForAgent(
    agentId: string,
    input: SkillInput,
    options?: { readonly numbered?: boolean },
  ): Effect.Effect<Skill, AppError>
  /** A skill that the agent may use now: it exists, it is on, and it is for this agent. */
  usable(agentId: string, skillId: string): Effect.Effect<Skill, AppError>
  /**
   * How many skills a delete of the agent deletes too: those that are only for this agent (spec
   * 002, flow 9; spec 017). The confirm text of the delete says this number.
   */
  onlyFor(agentId: string): Effect.Effect<number>
}

export class Skills extends Context.Service<Skills, SkillsService>()("robot/main/Skills") {
  static readonly layer = Layer.effect(
    Skills,
    Effect.gen(function* () {
      const db = yield* Database

      const serverOf = (agentId: string) =>
        db.get<{ server_id: string }>(
          "SELECT server_id FROM agent WHERE id = ? AND archived_at IS NULL",
          agentId,
        )?.server_id

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
        agentIds: readonly string[] | null,
        options?: { readonly numbered?: boolean },
      ) =>
        Effect.gen(function* () {
          const problem = skillProblems(input)[0]
          if (problem) return yield* new AppError({ code: problem.code, detail: problem.field })
          const taken = (candidate: string) => nameTaken(serverId, candidate)
          const wanted = skillName(input.name)
          if (!options?.numbered && taken(wanted))
            return yield* new AppError({ code: "skill_name_taken", detail: "name" })
          const name = options?.numbered ? numberedSkillName(wanted, taken) : wanted
          const key = skillNameKey(name)
          const count =
            db.get<{ n: number }>("SELECT COUNT(*) AS n FROM skill WHERE server_id = ?", serverId)
              ?.n ?? 0
          if (count >= SKILLS_MAX) return yield* new AppError({ code: "skills_full" })
          const id = randomUUID()
          db.run(
            `INSERT INTO skill (id, server_id, name, name_key, description, instructions, agents, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
            id,
            serverId,
            name,
            key,
            input.description.trim(),
            input.instructions,
            agentIds === null ? null : JSON.stringify(agentIds),
            Date.now(),
          )
          changed(serverId)
          return toSkill(db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", id) as SkillRow)
        })

      return Skills.of({
        list: (serverId) =>
          Effect.sync(() =>
            db
              .all<SkillRow>("SELECT * FROM skill WHERE server_id = ?", serverId)
              .map(toSkill)
              .sort((a, b) => a.name.localeCompare(b.name)),
          ),
        create: (serverId, input, agentIds) =>
          Effect.gen(function* () {
            if (!db.get("SELECT 1 FROM server WHERE id = ?", serverId))
              return yield* new AppError({ code: "server_not_found" })
            // A list of agents holds agents of this server and is not empty (spec 017).
            if (agentIds !== null) {
              const unique = [...new Set(agentIds)]
              const known = unique.filter((id) =>
                db.get(
                  "SELECT 1 FROM agent WHERE id = ? AND server_id = ? AND archived_at IS NULL",
                  id,
                  serverId,
                ),
              )
              if (unique.length === 0 || known.length !== unique.length)
                return yield* new AppError({ code: "skill_agents_invalid", detail: "agents" })
              return yield* insert(serverId, input, known)
            }
            return yield* insert(serverId, input, null)
          }),
        setEnabled: (id, enabled) =>
          Effect.gen(function* () {
            const row = db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", id)
            if (!row) return yield* new AppError({ code: "skill_unavailable" })
            db.run("UPDATE skill SET enabled = ? WHERE id = ?", enabled ? 1 : 0, id)
            changed(row.server_id)
            return toSkill({ ...row, enabled: enabled ? 1 : 0 })
          }),
        remove: (id) =>
          Effect.gen(function* () {
            const row = db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", id)
            if (!row) return yield* new AppError({ code: "skill_unavailable" })
            db.run("DELETE FROM skill WHERE id = ?", id)
            changed(row.server_id)
          }),
        forAgent: (agentId) =>
          Effect.sync(() => {
            const serverId = serverOf(agentId)
            if (!serverId) return []
            return db
              .all<SkillRow>("SELECT * FROM skill WHERE server_id = ? AND enabled = 1", serverId)
              .map(toSkill)
              .filter((skill) => skill.agentIds === null || skill.agentIds.includes(agentId))
              .sort((a, b) => a.name.localeCompare(b.name))
          }),
        nameTaken,
        createForAgent: (agentId, input, options) =>
          Effect.gen(function* () {
            const serverId = serverOf(agentId)
            if (!serverId) return yield* new AppError({ code: "agent_not_found" })
            return yield* insert(serverId, input, [agentId], options)
          }),
        usable: (agentId, skillId) =>
          Effect.gen(function* () {
            const row = db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", skillId)
            const skill = row ? toSkill(row) : undefined
            if (
              !skill?.enabled ||
              row?.server_id !== serverOf(agentId) ||
              (skill.agentIds !== null && !skill.agentIds.includes(agentId))
            )
              return yield* new AppError({ code: "skill_unavailable" })
            return skill
          }),
        onlyFor: (agentId) => Effect.sync(() => skillsOnlyFor(db, agentId)),
      })
    }),
  )
}
