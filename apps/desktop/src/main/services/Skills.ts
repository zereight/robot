import { randomUUID } from "node:crypto"
import {
  copySkillName,
  mayUseTool,
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
import { audienceOf, givingFor, idList } from "./channelAccess.ts"
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
  /** A JSON list of channel ids (spec 030): the channels in the list of the skill. */
  channels: string
  enabled: number
  created_at: number
}

const toSkill = (row: SkillRow): Skill => ({
  id: row.id,
  name: row.name,
  description: row.description,
  instructions: row.instructions,
  agentIds: row.agents === null ? null : (JSON.parse(row.agents) as string[]),
  channelIds: row.agents === null ? [] : idList(row.channels),
  enabled: row.enabled === 1,
  createdAt: row.created_at,
})

/** The agents in the stored list of a skill. A list that cannot be read names none. */
const namedAgents = (stored: string | null): string[] => {
  if (stored === null) return []
  try {
    const list: unknown = JSON.parse(stored)
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

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
    channelIds?: readonly string[],
  ): Effect.Effect<Skill, AppError>
  /**
   * Edit (spec 017, flow 2): changes every field of a skill. It stays on or off as it was. The
   * checks of the form apply, and the name may stay the one it has. A skill whose list names an
   * archived agent keeps that agent, so a restore brings the agent back to its skill.
   */
  update(
    id: string,
    input: SkillInput,
    agentIds: readonly string[] | null,
    channelIds?: readonly string[],
  ): Effect.Effect<Skill, AppError>
  /**
   * Duplicate (spec 017, flow 3): a copy with the same fields. `suffix` is the word "copy" in the
   * language of the window. The copy is off until the user turns it on.
   */
  duplicate(id: string, suffix: string): Effect.Effect<Skill, AppError>
  /** Turns a skill on or off. */
  setEnabled(id: string, enabled: boolean): Effect.Effect<Skill, AppError>
  /** Deletes a skill. Old messages that used it keep their chip and their copy. */
  remove(id: string): Effect.Effect<void, AppError>
  /**
   * The skills that an agent may use now: on, and for all agents, for this agent, or for a channel
   * that gives it (spec 017, 030).
   */
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
  /** A skill that the agent may use now: it exists, it is on, and it is for this agent (also by a channel). */
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
        options?: {
          readonly numbered?: boolean
          readonly enabled?: boolean
          readonly channelIds?: readonly string[]
        },
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
            `INSERT INTO skill (id, server_id, name, name_key, description, instructions, agents, channels, enabled, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            serverId,
            name,
            key,
            input.description.trim(),
            input.instructions,
            agentIds === null ? null : JSON.stringify(agentIds),
            JSON.stringify(agentIds === null ? [] : (options?.channelIds ?? [])),
            options?.enabled === false ? 0 : 1,
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
        create: (serverId, input, agentIds, channelIds = []) =>
          Effect.gen(function* () {
            if (!db.get("SELECT 1 FROM server WHERE id = ?", serverId))
              return yield* new AppError({ code: "server_not_found" })
            // A list holds agents and channels of this server and is not empty (spec 017, 030).
            if (agentIds !== null) {
              const unique = [...new Set(agentIds)]
              const known = unique.filter((id) =>
                db.get(
                  "SELECT 1 FROM agent WHERE id = ? AND server_id = ? AND archived_at IS NULL",
                  id,
                  serverId,
                ),
              )
              const channels = [...new Set(channelIds)]
              const knownChannels = channels.filter((id) =>
                db.get("SELECT 1 FROM channel WHERE id = ? AND server_id = ?", id, serverId),
              )
              if (
                unique.length + channels.length === 0 ||
                known.length !== unique.length ||
                knownChannels.length !== channels.length
              )
                return yield* new AppError({ code: "skill_agents_invalid", detail: "agents" })
              return yield* insert(serverId, input, known, { channelIds: knownChannels })
            }
            return yield* insert(serverId, input, null)
          }),
        update: (id, input, agentIds, channelIds = []) =>
          Effect.gen(function* () {
            const row = db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", id)
            if (!row) return yield* new AppError({ code: "skill_unavailable" })
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
            let list: string[] | null = null
            let kept: string[] = []
            if (agentIds !== null) {
              const was = namedAgents(row.agents)
              const unique = [...new Set(agentIds)]
              const live = (agentId: string) =>
                Boolean(
                  db.get(
                    "SELECT 1 FROM agent WHERE id = ? AND server_id = ? AND archived_at IS NULL",
                    agentId,
                    row.server_id,
                  ),
                )
              const there = (agentId: string) =>
                Boolean(
                  db.get(
                    "SELECT 1 FROM agent WHERE id = ? AND server_id = ?",
                    agentId,
                    row.server_id,
                  ),
                )
              // An archived agent that the skill already names stays. An id of an agent that is
              // gone and that the skill named goes. Any other id is not an agent of this server.
              list = unique.filter(
                (agentId) => live(agentId) || (was.includes(agentId) && there(agentId)),
              )
              const strange = unique.filter(
                (agentId) => !list?.includes(agentId) && !was.includes(agentId),
              )
              // A channel of this server may be in the list. One that the skill names and that is
              // gone stays out: it gave nothing, and the form does not show it.
              const channels = [...new Set(channelIds)]
              const wasChannels = idList(row.channels)
              const channelsKnown = channels.filter((channelId) =>
                db.get(
                  "SELECT 1 FROM channel WHERE id = ? AND server_id = ?",
                  channelId,
                  row.server_id,
                ),
              )
              const strangeChannels = channels.filter(
                (channelId) =>
                  !channelsKnown.includes(channelId) && !wasChannels.includes(channelId),
              )
              if (
                list.length + channelsKnown.length === 0 ||
                strange.length > 0 ||
                strangeChannels.length > 0
              )
                return yield* new AppError({ code: "skill_agents_invalid", detail: "agents" })
              kept = channelsKnown
            }
            db.run(
              `UPDATE skill SET name = ?, name_key = ?, description = ?, instructions = ?, agents = ?,
                 channels = ?
               WHERE id = ?`,
              name,
              skillNameKey(name),
              input.description.trim(),
              input.instructions,
              list === null ? null : JSON.stringify(list),
              JSON.stringify(list === null ? [] : kept),
              id,
            )
            changed(row.server_id)
            return toSkill(db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", id) as SkillRow)
          }),
        duplicate: (id, suffix) =>
          Effect.gen(function* () {
            const row = db.get<SkillRow>("SELECT * FROM skill WHERE id = ?", id)
            if (!row) return yield* new AppError({ code: "skill_unavailable" })
            const source = toSkill(row)
            const name = copySkillName(source.name, suffix, (candidate) =>
              nameTaken(row.server_id, candidate),
            )
            return yield* insert(
              row.server_id,
              {
                name,
                description: source.description,
                instructions: source.instructions,
              },
              source.agentIds,
              { enabled: false, channelIds: source.channelIds },
            )
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
            // The channels that give their skills to this agent in this turn (spec 030).
            const giving = givingFor(db, agentId)
            return db
              .all<SkillRow>("SELECT * FROM skill WHERE server_id = ? AND enabled = 1", serverId)
              .filter((row) => mayUseTool(audienceOf(row), agentId, giving))
              .map(toSkill)
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
              !row ||
              !skill?.enabled ||
              row.server_id !== serverOf(agentId) ||
              !mayUseTool(audienceOf(row), agentId, givingFor(db, agentId))
            )
              return yield* new AppError({ code: "skill_unavailable" })
            return skill
          }),
        onlyFor: (agentId) => Effect.sync(() => skillsOnlyFor(db, agentId)),
      })
    }),
  )
}
