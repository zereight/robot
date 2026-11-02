import { readFileSync, statSync, writeFileSync } from "node:fs"
import {
  AGENT_FILE_MAX_AGENTS,
  AGENT_FILE_MAX_BYTES,
  AGENT_NAME_MAX,
  AGENT_ROLE_MAX,
  type AgentFileAgent,
  type AgentFileFailure,
  type AgentFileImported,
  type AgentFilePreview,
  type AgentModel,
  faceFromName,
  nameKey,
  parseAgentFile,
  planNames,
  ROUTINE_NAME_MAX,
  redactSecrets,
  writeAgentFile,
} from "@robot/shared"
import { Cause, Context, Effect, Exit, Layer } from "effect"
import { Agents } from "./Agents.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"
import { Providers, secretKey } from "./Providers.ts"
import { Routines } from "./Routines.ts"
import { Secrets } from "./Secrets.ts"

export interface AgentFilesService {
  /** Writes one file with these agents and their routines. `path` is null when cancelled. */
  export(input: {
    serverId: string
    agentIds: readonly string[]
  }): Effect.Effect<{ path: string | null; count: number }, AppError>
  /** Asks for an agent file and reads it. Returns what an import would make, or null if cancelled. */
  open(serverId: string): Effect.Effect<AgentFilePreview | null, AppError>
  /** Makes the agents of the file that `open` read, all with the one model. */
  import(input: {
    serverId: string
    model: AgentModel | null
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
      /** The file that `open` read last. `import` makes its agents. */
      let pending: string | undefined

      /** Hides what looks like a secret, and every key that is stored on this computer. */
      const hider = Effect.gen(function* () {
        const known = (yield* providers.list)
          .map((a) => secrets.get(secretKey(a.id)))
          .filter((k): k is string => k !== null)
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
        return {
          agents: cleaned,
          names: planNames(
            cleaned.map((a) => a.name),
            taken,
          ),
        }
      })

      const exportAgents = Effect.fn("AgentFiles.export")(function* (input: {
        serverId: string
        agentIds: readonly string[]
      }) {
        const ids = [...new Set(input.agentIds)]
        if (ids.length === 0) return yield* new AppError({ code: "agent_file_empty" })
        if (ids.length > AGENT_FILE_MAX_AGENTS)
          return yield* new AppError({ code: "agent_file_too_many", detail: String(ids.length) })
        const chosen = []
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
        const text = writeAgentFile(
          chosen.map((a, i) => ({
            name: names[i] ?? a.name,
            role: clip(hide(a.role), AGENT_ROLE_MAX),
            instructions: hide(a.instructions),
            face: a.face,
            // The file has no place for a routine: on import it posts in the chat of its agent.
            routines: all
              .filter((r) => r.agentId === a.id)
              .map((r) => ({ name: hide(r.name), prompt: hide(r.prompt), schedule: r.schedule })),
          })),
        )
        if (Buffer.byteLength(text) > AGENT_FILE_MAX_BYTES)
          return yield* new AppError({ code: "agent_file_too_large" })
        const stamp = new Date().toISOString().slice(0, 10)
        const target = yield* Effect.promise(() =>
          platform.pickAgentFileSave(`ROBot-agents-${stamp}.json`),
        )
        if (!target) return { path: null, count: 0 }
        yield* Effect.try({
          try: () => writeFileSync(target, text),
          catch: (e) => new AppError({ code: "agent_file_write", detail: String(e) }),
        })
        return { path: target, count: chosen.length }
      })

      const open = Effect.fn("AgentFiles.open")(function* (serverId: string) {
        const path = yield* Effect.promise(() => platform.pickAgentFile())
        if (!path) return null
        const loaded = yield* load(path, serverId)
        pending = path
        return {
          agents: loaded.agents.map((a, i) => {
            const name = loaded.names[i] ?? a.name
            return {
              name,
              fileName: name === a.name ? null : a.name,
              role: a.role,
              face: a.face ?? faceFromName(name),
              routines: a.routines.length,
            }
          }),
        } satisfies AgentFilePreview
      })

      const importAgents = Effect.fn("AgentFiles.apply")(function* (input: {
        serverId: string
        model: AgentModel | null
      }) {
        if (!pending) return yield* new AppError({ code: "invalid_input" })
        const { model } = input
        if (model && !(yield* providers.list).some((a) => a.id === model.accountId))
          return yield* new AppError({ code: "provider_not_found" })
        const loaded = yield* load(pending, input.serverId)

        let made = 0
        let routineCount = 0
        // The file never gives a model, a folder or a permission: only the fields below are set.
        const makeOne = Effect.fn("AgentFiles.makeOne")(function* (
          agent: AgentFileAgent,
          name: string,
        ) {
          const created = yield* agents.create({
            serverId: input.serverId,
            name,
            role: agent.role,
            instructions: agent.instructions,
            ...(agent.face ? { face: agent.face } : {}),
            model,
          })
          made++
          for (const r of agent.routines) {
            yield* routines.create(
              {
                serverId: input.serverId,
                agentId: created.id,
                name: r.name,
                prompt: r.prompt,
                schedule: r.schedule,
                place: { kind: "agent" },
              },
              { paused: true },
            )
            routineCount++
          }
        })

        for (const [i, agent] of loaded.agents.entries()) {
          const name = loaded.names[i] ?? agent.name
          const exit = yield* Effect.exit(makeOne(agent, name))
          if (Exit.isFailure(exit)) {
            // The agents made so far stay. The error names the one that stopped the import.
            const failed = exit.cause.reasons.find(Cause.isFailReason)
            const failure: AgentFileFailure = {
              name,
              made,
              code: failed ? failed.error.code : "internal",
              detail: failed?.error.detail ?? null,
            }
            return yield* new AppError({
              code: "agent_file_failed",
              detail: JSON.stringify(failure),
            })
          }
        }
        pending = undefined
        return { agents: made, routines: routineCount }
      })

      return AgentFiles.of({ export: exportAgents, open, import: importAgents })
    }),
  )
}
