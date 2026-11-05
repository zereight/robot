import { readFileSync, statSync, writeFileSync } from "node:fs"
import {
  AGENT_FILE_MAX_AGENTS,
  AGENT_FILE_MAX_BYTES,
  AGENT_FILE_MAX_CHANNELS,
  AGENT_FILE_MAX_SKILLS,
  AGENT_NAME_MAX,
  AGENT_ROLE_MAX,
  type Agent,
  type AgentFileAgent,
  type AgentFileChannelOut,
  type AgentFileExported,
  type AgentFileFailure,
  type AgentFileImported,
  type AgentFilePreview,
  type AgentFileSkillOut,
  type AgentModel,
  type AgentPick,
  agentsForSkill,
  CHANNEL_INSTRUCTIONS_MAX,
  CHANNEL_NAME_MAX,
  CHANNEL_TOPIC_MAX,
  type ChecklistItem,
  channelNameKey,
  channelsForFile,
  faceFromName,
  givingByAgent,
  HANDBOOK_FROM_FILE,
  HANDBOOK_MAX,
  ignoredAgentFields,
  nameKey,
  parseAgentFile,
  planNames,
  planTeam,
  ROUTINE_NAME_MAX,
  redactSecrets,
  SKILL_DESCRIPTION_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  skillName,
  skillNameKey,
  skillsForFile,
  writeAgentFile,
} from "@robot/shared"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Checklists } from "./Checklists.ts"
import { Connections } from "./Connections.ts"
import { DECISION_KEY } from "./Decision.ts"
import { AppError } from "./errors.ts"
import { Handbook } from "./Handbook.ts"
import { Platform } from "./Platform.ts"
import { Providers, secretKey } from "./Providers.ts"
import { Routines } from "./Routines.ts"
import { SavedSecrets } from "./SavedSecrets.ts"
import { Secrets } from "./Secrets.ts"
import { Skills } from "./Skills.ts"

export interface AgentFilesService {
  /**
   * Writes one file with these agents and their routines (spec 002). `path` is null when
   * cancelled. With `channels`, the file also holds each channel whose members are all among the
   * agents; with `skills`, each skill that one of them may use; with `handbook`, the handbook (an
   * empty handbook is not written). A file over a limit is refused.
   */
  export(input: {
    serverId: string
    agentIds: readonly string[]
    channels?: boolean | undefined
    skills?: boolean | undefined
    handbook?: boolean | undefined
  }): Effect.Effect<AgentFileExported, AppError>
  /** Asks for an agent file and reads it. Returns what an import would make, or null if cancelled. */
  open(serverId: string): Effect.Effect<AgentFilePreview | null, AppError>
  /**
   * Makes the agents of the file that `open` read that the user ticked, all with the one model.
   * A new agent with a routine gets a checklist in its chat. Then it makes the ticked channels
   * (`channels`, places in the file) and skills (`skills`), and with `handbook` it replaces the
   * handbook of the server (spec 002, "Agent file"; spec 014, the review before it).
   */
  import(input: {
    serverId: string
    model: AgentModel | null
    pick: readonly AgentPick[]
    channels?: readonly number[] | undefined
    skills?: readonly number[] | undefined
    handbook?: boolean | undefined
  }): Effect.Effect<AgentFileImported, AppError>
}

const clip = (text: string, max: number) => [...text].slice(0, max).join("")

export class AgentFiles extends Context.Service<AgentFiles, AgentFilesService>()(
  "robot/main/AgentFiles",
) {
  static readonly layer = Layer.effect(
    AgentFiles,
    Effect.gen(function* () {
      const agents = yield* Agents
      const routines = yield* Routines
      const providers = yield* Providers
      const secrets = yield* Secrets
      const platform = yield* Platform
      const checklists = yield* Checklists
      const channels = yield* Channels
      const skills = yield* Skills
      const handbook = yield* Handbook
      const savedSecrets = yield* SavedSecrets
      const connections = yield* Connections
      /** The file that `open` read last. `import` makes its agents. */
      let pending: string | undefined

      /** Hides what looks like a secret, and every key that is stored on this computer. */
      const hider = Effect.gen(function* () {
        const known = [
          ...(yield* providers.list)
            .map((a) => secrets.get(secretKey(a.id)))
            .filter((k): k is string => k !== null),
          // The same stored values that an export of all data hides (spec 014), so that no text
          // of the file holds one, and the handbook and the channels accept what the file brings.
          ...[secrets.get(DECISION_KEY)].filter((k): k is string => k !== null),
          ...savedSecrets.knownValues(),
          ...connections.knownValues(),
        ]
        return (text: string) => redactSecrets(text, known)
      })

      const refusal = (parsed: { code: string; detail?: string | undefined }) =>
        new AppError({ code: parsed.code, ...(parsed.detail ? { detail: parsed.detail } : {}) })

      /** Reads, checks and cleans a file. The names are the ones that the agents will get. */
      const load = Effect.fn("AgentFiles.load")(function* (path: string, serverId: string) {
        const text = yield* Effect.try({
          try: () =>
            statSync(path).size > AGENT_FILE_MAX_BYTES
              ? null
              : new TextDecoder().decode(readFileSync(path)),
          catch: (e) => new AppError({ code: "file_unreadable", detail: String(e) }),
        })
        if (text === null) return yield* new AppError({ code: "agent_file_too_large" })
        const parsed = parseAgentFile(text)
        if (!parsed.ok) return yield* refusal(parsed)
        const hide = yield* hider
        /** True when the app hid a secret in one of these texts. */
        const hidden = (...texts: string[]) => texts.some((text) => hide(text) !== text)
        const secrets = parsed.file.agents.map((a) => ({
          agent: hidden(a.name, a.role),
          instructions: hidden(a.instructions),
          routines: a.routines.map((r) => hidden(r.name, r.prompt)),
        }))
        const cleaned: AgentFileAgent[] = parsed.file.agents.map((a) => ({
          name: clip(hide(a.name).trim(), AGENT_NAME_MAX),
          role: clip(hide(a.role).trim(), AGENT_ROLE_MAX),
          instructions: hide(a.instructions),
          face: a.face,
          routines: a.routines.map((r) => ({
            name: clip(hide(r.name).trim(), ROUTINE_NAME_MAX),
            prompt: hide(r.prompt),
            schedule: r.schedule,
          })),
        }))
        const taken = [
          ...(yield* agents.list(serverId, false)),
          ...(yield* agents.list(serverId, true)),
        ].map((a) => a.name)
        const file = parsed.file
        // The channels and skills of a version 2 file, cleaned like the agents. A channel or a
        // skill where the app hid a secret is marked, and starts not ticked on the review.
        const cleanedChannels = file.channels.map((c) => ({
          ...c,
          name: clip(hide(c.name).trim(), CHANNEL_NAME_MAX),
          topic: clip(hide(c.topic).trim(), CHANNEL_TOPIC_MAX),
          instructions: clip(hide(c.instructions), CHANNEL_INSTRUCTIONS_MAX),
          parent: c.parent === null ? null : clip(hide(c.parent).trim(), CHANNEL_NAME_MAX) || null,
          secret: hidden(c.name, c.topic, c.instructions),
        }))
        const cleanedSkills = file.skills.map((k) => ({
          ...k,
          name: clip(skillName(hide(k.name)), SKILL_NAME_MAX),
          description: clip(hide(k.description).trim(), SKILL_DESCRIPTION_MAX),
          instructions: clip(hide(k.instructions), SKILL_INSTRUCTIONS_MAX),
          channels: k.channels
            .map((name) => clip(hide(name).trim(), CHANNEL_NAME_MAX))
            .filter((name) => name !== ""),
          secret: hidden(k.name, k.description, k.instructions),
        }))
        const cleanedHandbook = clip(hide(file.handbook), HANDBOOK_MAX)
        return {
          version: file.version,
          agents: cleaned,
          secrets,
          channels: cleanedChannels,
          skills: cleanedSkills,
          handbook: cleanedHandbook,
          handbookSecret: hidden(file.handbook),
          ignored: ignoredAgentFields(text),
          taken,
          names: planNames(
            cleaned.map((a) => a.name),
            taken,
          ),
        }
      })

      const exportAgents = Effect.fn("AgentFiles.export")(function* (input: {
        serverId: string
        agentIds: readonly string[]
        channels?: boolean | undefined
        skills?: boolean | undefined
        handbook?: boolean | undefined
      }) {
        const ids = [...new Set(input.agentIds)]
        if (ids.length === 0) return yield* new AppError({ code: "agent_file_empty" })
        if (ids.length > AGENT_FILE_MAX_AGENTS)
          return yield* new AppError({ code: "agent_file_too_many", detail: String(ids.length) })
        const chosen: Agent[] = []
        for (const id of ids) {
          const agent = yield* agents.get(id)
          if (agent.serverId !== input.serverId)
            return yield* new AppError({ code: "agent_not_found" })
          chosen.push(agent)
        }
        chosen.sort((a, b) => (nameKey(a.name) < nameKey(b.name) ? -1 : 1))
        const hide = yield* hider
        const all = yield* routines.list(input.serverId)
        // Two names can look alike once hidden. The file may not hold two of one name.
        const names = planNames(
          chosen.map((a) => clip(hide(a.name), AGENT_NAME_MAX)),
          [],
        )
        // The name that the file gives to each agent: channels and skills tell agents by it.
        const fileName = new Map(chosen.map((a, i) => [a.id, names[i] ?? a.name]))
        const picked = new Set(chosen.map((a) => a.id))

        const listed = yield* channels.list(input.serverId)
        const giving = givingByAgent(listed, [...picked])
        // "Channels of these agents": each channel whose members are all among the picked agents.
        let channelParts: AgentFileChannelOut[] | undefined
        /** The name the file gives a channel, so a skill can name it (spec 030). */
        const exportedChannelName = new Map<string, string>()
        if (input.channels) {
          const found = channelsForFile(listed, picked)
          if (found.length > AGENT_FILE_MAX_CHANNELS)
            return yield* new AppError({
              code: "agent_file_too_many_channels",
              detail: String(found.length),
            })
          const sorted = [...found].sort((a, b) =>
            channelNameKey(a.name) < channelNameKey(b.name) ? -1 : 1,
          )
          const channelNames = planNames(
            sorted.map((c) => clip(hide(c.name).trim(), CHANNEL_NAME_MAX)),
            [],
            CHANNEL_NAME_MAX,
            channelNameKey,
          )
          // The name the file gives each channel, so a parent points at that name (spec 002, 030).
          const parentName = new Map(sorted.map((c, i) => [c.id, channelNames[i] ?? c.name]))
          for (const [id, name] of parentName) exportedChannelName.set(id, name)
          channelParts = sorted.map((c, i) => {
            const parent = c.parentId ? parentName.get(c.parentId) : undefined
            return {
              name: channelNames[i] ?? c.name,
              topic: clip(hide(c.topic), CHANNEL_TOPIC_MAX),
              instructions: hide(c.instructions),
              reviewParts: c.reviewParts,
              members: c.memberIds.map((id) => fileName.get(id) ?? ""),
              lead: c.leadId === null ? null : (fileName.get(c.leadId) ?? null),
              ...(parent ? { parent } : {}),
              ...(typeof c.dailyTokenLimit === "number"
                ? { dailyTokenLimit: c.dailyTokenLimit }
                : {}),
            }
          })
        }

        // "Skills of these agents": each skill that a picked agent may use. A skill for all
        // agents is written for the picked agents only.
        let skillParts: AgentFileSkillOut[] | undefined
        if (input.skills) {
          const found = skillsForFile(yield* skills.list(input.serverId), picked, giving)
          if (found.length > AGENT_FILE_MAX_SKILLS)
            return yield* new AppError({
              code: "agent_file_too_many_skills",
              detail: String(found.length),
            })
          const skillNames = planNames(
            found.map((k) => clip(skillName(hide(k.name)), SKILL_NAME_MAX)),
            [],
            SKILL_NAME_MAX,
            skillNameKey,
          )
          skillParts = found.map((k, i) => ({
            name: skillNames[i] ?? k.name,
            description: clip(hide(k.description), SKILL_DESCRIPTION_MAX),
            instructions: hide(k.instructions),
            agents: agentsForSkill(k, chosen, giving).map((a) => fileName.get(a.id) ?? a.name),
            channels: k.channelIds.flatMap((id) => {
              const name = exportedChannelName.get(id)
              return name ? [name] : []
            }),
          }))
        }

        // "Handbook": the text of the handbook. A handbook that is empty gives the file nothing.
        const handbookText = input.handbook
          ? clip(hide((yield* handbook.get(input.serverId)).text), HANDBOOK_MAX)
          : ""
        const text = writeAgentFile(
          chosen.map((a, i) => ({
            name: names[i] ?? a.name,
            role: clip(hide(a.role), AGENT_ROLE_MAX),
            instructions: hide(a.instructions),
            face: a.face,
            // The file has no place for a routine: on import it posts in the chat of its agent.
            // The file has no field for a watch (docs/agent-file-format.md): a watch routine
            // stays out of the file. Nor does it hold the model of a routine.
            routines: all.flatMap((r) =>
              r.agentId === a.id && r.schedule
                ? [{ name: hide(r.name), prompt: hide(r.prompt), schedule: r.schedule }]
                : [],
            ),
          })),
          {
            ...(channelParts ? { channels: channelParts } : {}),
            ...(skillParts ? { skills: skillParts } : {}),
            ...(handbookText.trim() !== "" ? { handbook: handbookText } : {}),
          },
        )
        if (Buffer.byteLength(text) > AGENT_FILE_MAX_BYTES)
          return yield* new AppError({ code: "agent_file_too_large" })
        const stamp = new Date().toISOString().slice(0, 10)
        const target = yield* Effect.promise(() =>
          platform.pickAgentFileSave(`ROBot-agents-${stamp}.json`),
        )
        if (!target) return { path: null, count: 0, channels: 0, skills: 0, handbook: false }
        yield* Effect.try({
          try: () => writeFileSync(target, text),
          catch: (e) => new AppError({ code: "agent_file_write", detail: String(e) }),
        })
        return {
          path: target,
          count: chosen.length,
          channels: channelParts?.length ?? 0,
          skills: skillParts?.length ?? 0,
          handbook: handbookText.trim() !== "",
        } satisfies AgentFileExported
      })

      const open = Effect.fn("AgentFiles.open")(function* (serverId: string) {
        const path = yield* Effect.promise(() => platform.pickAgentFile())
        if (!path) return null
        const loaded = yield* load(path, serverId)
        pending = path
        // Channels and skills get the names they would get if every part were ticked.
        const channelNames = planNames(
          loaded.channels.map((c) => c.name),
          (yield* channels.list(serverId)).map((c) => c.name),
          CHANNEL_NAME_MAX,
          channelNameKey,
        )
        const skillNames = planNames(
          loaded.skills.map((k) => k.name),
          (yield* skills.list(serverId)).map((k) => k.name),
          SKILL_NAME_MAX,
          skillNameKey,
        )
        return {
          version: loaded.version,
          agents: loaded.agents.map((a, i) => {
            const name = loaded.names[i] ?? a.name
            const secret = loaded.secrets[i]
            return {
              name,
              fileName: name === a.name ? null : a.name,
              role: a.role,
              face: a.face ?? faceFromName(name),
              secretRemoved: secret?.agent ?? false,
              instructions: {
                length: [...a.instructions].length,
                secretRemoved: secret?.instructions ?? false,
              },
              routines: a.routines.map((r, j) => ({
                name: r.name,
                schedule: r.schedule,
                secretRemoved: secret?.routines[j] ?? false,
              })),
            }
          }),
          channels: loaded.channels.map((c, i) => {
            const name = channelNames[i] ?? c.name
            return {
              name,
              fileName: name === c.name ? null : c.name,
              topic: c.topic,
              reviewParts: c.reviewParts,
              members: c.members,
              lead: c.lead,
              instructionsLength: [...c.instructions].length,
              secretRemoved: c.secret,
            }
          }),
          skills: loaded.skills.map((k, i) => {
            const name = skillNames[i] ?? k.name
            return {
              name,
              fileName: name === k.name ? null : k.name,
              description: k.description,
              agents: k.agents,
              instructionsLength: [...k.instructions].length,
              secretRemoved: k.secret,
            }
          }),
          handbook:
            loaded.handbook.trim() === ""
              ? null
              : {
                  text: loaded.handbook,
                  length: [...loaded.handbook].length,
                  secretRemoved: loaded.handbookSecret,
                },
          skillRoom: yield* skills.room(serverId),
          notImported: loaded.ignored.map((f) => ({ reason: "unknown_field" as const, ...f })),
        } satisfies AgentFilePreview
      })

      const importAgents = Effect.fn("AgentFiles.apply")(function* (input: {
        serverId: string
        model: AgentModel | null
        pick: readonly AgentPick[]
        channels?: readonly number[] | undefined
        skills?: readonly number[] | undefined
        handbook?: boolean | undefined
      }) {
        if (!pending) return yield* new AppError({ code: "invalid_input" })
        const { model } = input
        if (model && !(yield* providers.list).some((a) => a.id === model.accountId))
          return yield* new AppError({ code: "provider_not_found" })
        const loaded = yield* load(pending, input.serverId)
        // The ticks of the review. Nothing ticked makes nothing; a place that the file does not
        // have is refused.
        const picks = new Map<number, AgentPick>()
        for (const p of input.pick) {
          const agent = loaded.agents[p.index]
          if (
            !agent ||
            picks.has(p.index) ||
            p.routines.some((j) => agent.routines[j] === undefined) ||
            new Set(p.routines).size !== p.routines.length
          )
            return yield* new AppError({ code: "invalid_input" })
          picks.set(p.index, p)
        }
        const channelPicks = [...new Set(input.channels ?? [])]
        const skillPicks = [...new Set(input.skills ?? [])]
        if (
          channelPicks.some((i) => loaded.channels[i] === undefined) ||
          skillPicks.some((i) => loaded.skills[i] === undefined) ||
          // The handbook can be ticked only when the file holds one.
          (input.handbook === true && loaded.handbook.trim() === "")
        )
          return yield* new AppError({ code: "invalid_input" })
        if (picks.size === 0 && input.handbook !== true)
          return yield* new AppError({ code: "import_nothing_picked" })
        const chosen = loaded.agents.flatMap((agent, index) => {
          const p = picks.get(index)
          if (!p) return []
          const routines = new Set(p.routines)
          return [
            {
              index,
              agent: {
                ...agent,
                instructions: p.instructions ? agent.instructions : "",
                routines: agent.routines.filter((_, j) => routines.has(j)),
              },
            },
          ]
        })
        // Only the agents that are made take a name: an agent that is not ticked keeps none.
        const names = planNames(
          chosen.map((c) => c.agent.name),
          loaded.taken,
        )

        let made = 0
        let routineCount = 0
        let channelCount = 0
        let skillCount = 0
        /** The id of each new agent, by its place in the file. */
        const created = new Map<number, string>()
        const failed = (
          kind: NonNullable<AgentFileFailure["kind"]>,
          name: string,
          cause: Cause.Cause<AppError>,
        ) => {
          // What is made so far stays. The error names the part that stopped the import.
          const reason = cause.reasons.find(Cause.isFailReason)
          const failure: AgentFileFailure = {
            kind,
            name,
            made,
            madeChannels: channelCount,
            madeSkills: skillCount,
            code: reason ? reason.error.code : "internal",
            detail: reason?.error.detail ?? null,
          }
          return new AppError({ code: "agent_file_failed", detail: JSON.stringify(failure) })
        }
        // The file never gives a model, a folder or a permission: only the fields below are set.
        const makeOne = Effect.fn("AgentFiles.makeOne")(function* (
          index: number,
          agent: AgentFileAgent,
          name: string,
        ) {
          const newAgent = yield* agents.create({
            serverId: input.serverId,
            name,
            role: agent.role,
            instructions: agent.instructions,
            ...(agent.face ? { face: agent.face } : {}),
            model,
          })
          made++
          created.set(index, newAgent.id)
          const todo: ChecklistItem[] = []
          for (const r of agent.routines) {
            const routine = yield* routines.create(
              {
                serverId: input.serverId,
                agentId: newAgent.id,
                name: r.name,
                prompt: r.prompt,
                schedule: r.schedule,
                place: { kind: "agent" },
              },
              { paused: true, fromFile: true },
            )
            routineCount++
            todo.push({ kind: "routine", routineId: routine.id, name: routine.name })
          }
          // The chat of the new agent shows what still needs the user.
          yield* checklists.create({ agentId: newAgent.id }, todo)
        })

        for (const [i, { index, agent }] of chosen.entries()) {
          const name = names[i] ?? agent.name
          const exit = yield* Effect.exit(makeOne(index, agent, name))
          if (Exit.isFailure(exit)) return yield* failed("agent", name, exit.cause)
        }

        // The channels and skills need the agents that are made (spec 002, "Agent file").
        const plan = planTeam({
          channels: loaded.channels,
          skills: loaded.skills,
          made: (agent) => created.has(agent),
          channelPicks,
          skillPicks,
          skillRoom: yield* skills.room(input.serverId),
        })
        const channelNames = planNames(
          plan.channels.map((c) => loaded.channels[c.index]?.name ?? ""),
          (yield* channels.list(input.serverId)).map((c) => c.name),
          CHANNEL_NAME_MAX,
          channelNameKey,
        )
        /** The id of each channel that this import made, by the name in the file. */
        const madeChannel = new Map<string, string>()
        for (const [i, planned] of plan.channels.entries()) {
          const channel = loaded.channels[planned.index]
          if (!channel) continue
          const name = channelNames[i] ?? channel.name
          const exit = yield* Effect.exit(
            Effect.gen(function* () {
              const row = yield* channels.create({
                serverId: input.serverId,
                name,
                topic: channel.topic,
                instructions: channel.instructions,
                memberIds: planned.members.flatMap((m) => created.get(m) ?? []),
                leadId: planned.lead === null ? null : (created.get(planned.lead) ?? null),
              })
              channelCount++
              madeChannel.set(channelNameKey(channel.name), row.id)
              if (channel.reviewParts || channel.dailyTokenLimit !== null)
                yield* channels.update(row.id, {
                  ...(channel.reviewParts ? { reviewParts: true } : {}),
                  ...(channel.dailyTokenLimit !== null
                    ? { dailyTokenLimit: channel.dailyTokenLimit }
                    : {}),
                })
            }),
          )
          if (Exit.isFailure(exit)) return yield* failed("channel", name, exit.cause)
        }
        // The parent is set after every channel exists. A parent that was not made stays none.
        for (const planned of plan.channels) {
          const channel = loaded.channels[planned.index]
          if (!channel?.parent) continue
          const childId = madeChannel.get(channelNameKey(channel.name))
          const parentId = madeChannel.get(channelNameKey(channel.parent))
          if (!childId || !parentId) continue
          const exit = yield* Effect.exit(channels.update(childId, { parentId }))
          if (Exit.isFailure(exit)) return yield* failed("channel", channel.name, exit.cause)
        }
        for (const planned of plan.skills) {
          const skill = loaded.skills[planned.index]
          if (!skill) continue
          const exit = yield* Effect.exit(
            skills.createImported(
              input.serverId,
              {
                name: skill.name,
                description: skill.description,
                instructions: skill.instructions,
              },
              planned.agents.flatMap((a) => created.get(a) ?? []),
              skill.channels.flatMap((name) => {
                const id = madeChannel.get(channelNameKey(name))
                return id ? [id] : []
              }),
            ),
          )
          if (Exit.isFailure(exit)) return yield* failed("skill", skill.name, exit.cause)
          skillCount++
        }

        // The handbook of the server is replaced. The old text stays in its history.
        let replaced = false
        if (input.handbook === true) {
          const exit = yield* Effect.exit(
            handbook.save(input.serverId, loaded.handbook, HANDBOOK_FROM_FILE),
          )
          if (Exit.isFailure(exit)) return yield* failed("handbook", "", exit.cause)
          replaced = true
        }
        pending = undefined
        return {
          agents: made,
          routines: routineCount,
          channels: channelCount,
          skills: skillCount,
          handbook: replaced,
        } satisfies AgentFileImported
      })

      return AgentFiles.of({ export: exportAgents, open, import: importAgents })
    }),
  )
}
