import { randomUUID } from "node:crypto"
import {
  SKILLS_MAX,
  type Skill,
  type SkillInput,
  skillName,
  skillNameKey,
  skillProblems,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
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
  /**
   * Makes a skill on the server of the agent, for this agent only, turned on. The checks of the
   * skill form apply (spec 017): the reason of a failure is the code of the first problem.
   */
  createForAgent(agentId: string, input: SkillInput): Effect.Effect<Skill, AppError>
  /** A skill that the agent may use now: it exists, it is on, and it is for this agent. */
  usable(agentId: string, skillId: string): Effect.Effect<Skill, AppError>
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

      return Skills.of({
        createForAgent: (agentId, input) =>
          Effect.gen(function* () {
            const serverId = serverOf(agentId)
            if (!serverId) return yield* new AppError({ code: "agent_not_found" })
            const problem = skillProblems(input)[0]
            if (problem) return yield* new AppError({ code: problem.code, detail: problem.field })
            const name = skillName(input.name)
            const key = skillNameKey(name)
            if (db.get("SELECT 1 FROM skill WHERE server_id = ? AND name_key = ?", serverId, key))
              return yield* new AppError({ code: "skill_name_taken", detail: "name" })
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
              JSON.stringify([agentId]),
              Date.now(),
            )
            return toSkill(db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", id) as SkillRow)
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
      })
    }),
  )
}
