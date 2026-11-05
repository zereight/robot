import {
  type Agent,
  type AgentModel,
  type AgentPatch,
  describeAgent,
  describeSettings,
  type Face,
  type InstructionSource,
  type InstructionVersion,
  isAppSettingField,
  type MakeAgentPlan,
  type MessagePart,
  nameKey,
  planMakeAgent,
  planSettings,
  type SettingChange,
  type SettingsAccount,
  type SettingsCurrent,
  type SettingsLineState,
  type SettingsNote,
  type SettingsPatch,
  type SettingsPlan,
  type SettingValue,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { offeredEfforts } from "../providers/client.ts"
import { Agents } from "./Agents.ts"
import { Database } from "./Database.ts"
import { AppError } from "./errors.ts"
import { getVersion, listVersions, newestVersion } from "./instructionHistory.ts"
import { Providers } from "./Providers.ts"
import { SettingsStore } from "./Settings.ts"

/**
 * Changes from the chat (spec 002): the settings tool of an agent reads and changes some fields of
 * the agent and some settings of the app. The tool itself is in Tools, behind the guard of spec
 * 007; this service plans, applies and undoes the changes, and keeps the instruction history.
 */
export interface AgentSettingsService {
  /** Plans a call of the tool. A call with no field reads; `text` is then what the agent reads. */
  plan(
    agentId: string,
    args: Readonly<Record<string, unknown>>,
  ): Effect.Effect<{ plan: SettingsPlan; text: string }, AppError>
  /**
   * Plans a call of "Make an agent" for the caller (spec 037). It uses the checks of `plan`, with
   * the accounts, the models and the names of the server of the caller.
   */
  planNew(
    callerId: string,
    args: Readonly<Record<string, unknown>>,
  ): Effect.Effect<MakeAgentPlan, AppError>
  /**
   * The text of "Read an agent" (spec 037): the fields of the agent that has this name on the
   * server of the caller, or null when no agent that is not archived has it.
   */
  describeOther(callerId: string, name: string): Effect.Effect<string | null, AppError>
  /** Makes the changes of a plan. The agent changes count from its next turn. */
  apply(
    agentId: string,
    changes: readonly SettingChange[],
    source: InstructionSource,
  ): Effect.Effect<SettingsNote, AppError>
  /** Whether the line of a change in a message can still undo it. */
  lineState(agentId: string, messageId: string, callId: string): Effect.Effect<SettingsLineState>
  /** Puts back the values from before the change, and marks the line as undone. */
  undo(agentId: string, messageId: string, callId: string): Effect.Effect<void, AppError>
  history(agentId: string): Effect.Effect<readonly InstructionVersion[], AppError>
  /** Makes the text of a version the instructions again, as a new version from a restore. */
  restore(agentId: string, versionId: string): Effect.Effect<Agent, AppError>
}

type ToolPart = Extract<MessagePart, { kind: "tool" }>

const same = (a: SettingValue, b: SettingValue) => JSON.stringify(a) === JSON.stringify(b)

export class AgentSettings extends Context.Service<AgentSettings, AgentSettingsService>()(
  "robot/main/AgentSettings",
) {
  static readonly layer = Layer.effect(
    AgentSettings,
    Effect.gen(function* () {
      const db = yield* Database
      const agents = yield* Agents
      const settings = yield* SettingsStore
      const providers = yield* Providers

      /** The connected accounts and their models. A list that cannot be read is empty. */
      const accounts = Effect.gen(function* () {
        const out: (SettingsAccount & { kind: string })[] = []
        for (const account of yield* providers.list) {
          if (!account.connected) continue
          const models = yield* providers
            .models(account.id)
            .pipe(Effect.orElseSucceed(() => [] as const))
          out.push({ id: account.id, name: account.name, kind: account.kind, models })
        }
        return out
      })

      /** The effort levels of a model of an account, as the account offers them. */
      const effortsFor =
        (list: readonly (SettingsAccount & { kind: string })[]) =>
        (accountId: string, model: string): readonly string[] => {
          const account = list.find((a) => a.id === accountId)
          return account ? offeredEfforts(account.kind as never, model, account.models) : []
        }

      const planNew = Effect.fn("AgentSettings.planNew")(function* (
        callerId: string,
        args: Readonly<Record<string, unknown>>,
      ) {
        const caller = yield* agents.get(callerId)
        const list = yield* accounts
        const taken = (name: string) =>
          db.get(
            "SELECT 1 AS x FROM agent WHERE server_id = ? AND name_key = ?",
            caller.serverId,
            nameKey(name),
          ) !== undefined
        return planMakeAgent(args, list, taken, effortsFor(list))
      })

      const describeOther = Effect.fn("AgentSettings.describeOther")(function* (
        callerId: string,
        name: string,
      ) {
        const caller = yield* agents.get(callerId)
        const row = db.get<{ id: string }>(
          "SELECT id FROM agent WHERE server_id = ? AND name_key = ? AND archived_at IS NULL",
          caller.serverId,
          nameKey(name),
        )
        if (!row) return null
        return describeAgent(yield* agents.get(row.id), yield* accounts)
      })

      const currentOf = (agent: Agent) =>
        Effect.gen(function* () {
          const app = yield* settings.get
          const current: SettingsCurrent = {
            name: agent.name,
            role: agent.role,
            instructions: agent.instructions,
            face: agent.face,
            model: agent.model,
            app: {
              language: app.language,
              theme: app.theme,
              textSize: app.textSize,
              compactPlaces: app.compactPlaces,
              reduceMotion: app.reduceMotion,
            },
          }
          return current
        })

      const fieldValue = (current: SettingsCurrent, field: SettingChange["field"]): SettingValue =>
        isAppSettingField(field) ? current.app[field] : current[field]

      const plan = Effect.fn("AgentSettings.plan")(function* (
        agentId: string,
        args: Readonly<Record<string, unknown>>,
      ) {
        const agent = yield* agents.get(agentId)
        const current = yield* currentOf(agent)
        const list = yield* accounts
        const nameTaken = (name: string) =>
          db.get(
            "SELECT 1 AS x FROM agent WHERE server_id = ? AND name_key = ? AND id != ?",
            agent.serverId,
            nameKey(name),
            agent.id,
          ) !== undefined
        const result = planSettings(args, current, list, nameTaken, effortsFor(list))
        return { plan: result, text: result.kind === "read" ? describeSettings(current, list) : "" }
      })

      /** Writes values: the agent fields in one update, the app settings in one patch. */
      const write = (
        agentId: string,
        values: readonly { field: SettingChange["field"]; value: SettingValue }[],
        source: InstructionSource,
      ) =>
        Effect.gen(function* () {
          const patch: { -readonly [K in keyof AgentPatch]: AgentPatch[K] } = {}
          const app: Record<string, unknown> = {}
          for (const { field, value } of values) {
            if (isAppSettingField(field)) app[field] = value
            else if (field === "name") patch.name = value as string
            else if (field === "role") patch.role = value as string
            else if (field === "instructions") patch.instructions = value as string
            else if (field === "face") patch.face = value as Face
            else if (field === "model") patch.model = value as AgentModel | null
          }
          if (Object.keys(patch).length > 0) yield* agents.update(agentId, patch, { source })
          // A change of the app settings applies at once.
          if (Object.keys(app).length > 0) yield* settings.update(app as SettingsPatch)
        })

      const apply = Effect.fn("AgentSettings.apply")(function* (
        agentId: string,
        changes: readonly SettingChange[],
        source: InstructionSource,
      ) {
        yield* write(
          agentId,
          changes.map((c) => ({ field: c.field, value: c.after })),
          source,
        )
        const version = changes.some((c) => c.field === "instructions")
          ? newestVersion(db, agentId)
          : undefined
        const note: SettingsNote = { changes, ...(version ? { versionId: version.id } : {}) }
        return note
      })

      const partOf = (agentId: string, messageId: string, callId: string) => {
        const row = db.get<{ parts: string; agent_id: string; status: string }>(
          "SELECT parts, agent_id, status FROM message WHERE id = ?",
          messageId,
        )
        if (!row || row.agent_id !== agentId) return undefined
        const parts = JSON.parse(row.parts) as MessagePart[]
        const index = parts.findIndex((p) => p.kind === "tool" && p.id === callId)
        const part = parts[index] as ToolPart | undefined
        return part?.settings
          ? { parts, index, part, note: part.settings, streaming: row.status === "streaming" }
          : undefined
      }

      const stateOf = (agent: Agent, current: SettingsCurrent, note: SettingsNote) => {
        if (note.undone) return "undone" as const
        for (const change of note.changes) {
          if (!same(fieldValue(current, change.field), change.after)) return "changed" as const
          // The text can come back to the same words through another change.
          if (change.field === "instructions" && note.versionId) {
            const newest = newestVersion(db, agent.id)
            if (newest && newest.id !== note.versionId) return "changed" as const
          }
        }
        return "ready" as const
      }

      const lineState = (agentId: string, messageId: string, callId: string) =>
        Effect.gen(function* () {
          const found = partOf(agentId, messageId, callId)
          if (!found) return "undone" as SettingsLineState
          const agent = yield* agents.get(agentId)
          return stateOf(agent, yield* currentOf(agent), found.note)
        }).pipe(Effect.orElseSucceed((): SettingsLineState => "undone"))

      const undo = Effect.fn("AgentSettings.undo")(function* (
        agentId: string,
        messageId: string,
        callId: string,
      ) {
        const found = partOf(agentId, messageId, callId)
        if (!found) return yield* new AppError({ code: "settings_not_found" })
        const agent = yield* agents.get(agentId)
        const state = stateOf(agent, yield* currentOf(agent), found.note)
        if (state === "undone") return yield* new AppError({ code: "settings_undone" })
        if (state === "changed") return yield* new AppError({ code: "settings_changed_again" })
        // The reply still streams, and its turn would write over the line.
        if (found.streaming) return yield* new AppError({ code: "agent_working" })
        yield* write(
          agentId,
          found.note.changes.map((c) => ({ field: c.field, value: c.before })),
          "undo",
        )
        const parts = found.parts.slice()
        parts[found.index] = { ...found.part, settings: { ...found.note, undone: true } }
        db.run("UPDATE message SET parts = ? WHERE id = ?", JSON.stringify(parts), messageId)
      })

      return AgentSettings.of({
        plan,
        planNew,
        describeOther,
        apply,
        lineState,
        undo,
        history: (agentId) => agents.get(agentId).pipe(Effect.map(() => listVersions(db, agentId))),
        restore: Effect.fn("AgentSettings.restore")(function* (agentId: string, versionId: string) {
          const version = getVersion(db, versionId)
          if (!version || version.agentId !== agentId)
            return yield* new AppError({ code: "version_not_found" })
          return yield* agents.update(
            agentId,
            { instructions: version.text },
            { source: "restore" },
          )
        }),
      })
    }),
  )
}
