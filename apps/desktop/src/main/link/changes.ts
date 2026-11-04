import {
  type Agent,
  ClientAgentCreate,
  ClientAgentPatch,
  ClientChannelCreate,
  ClientChannelPatch,
  isLooser,
  MEMORY_TEXT_MAX,
  type ModelChoice,
} from "@robot/shared"
import type { Effect } from "effect"
import { Effect as E, Schema } from "effect"
import type { AppServices } from "../layers.ts"
import { Activity } from "../services/Activity.ts"
import { Agents } from "../services/Agents.ts"
import { CurrentActor } from "../services/actor.ts"
import { Channels } from "../services/Channels.ts"
import { Devices } from "../services/Devices.ts"
import { AppError } from "../services/errors.ts"
import { Memory } from "../services/Memory.ts"
import { Providers } from "../services/Providers.ts"
import { Servers } from "../services/Servers.ts"

/**
 * What a linked device may do to agents, channels and memory (spec 012, "Create and change
 * agents"). Every request here is untrusted: it passes the switch of the device, then a schema
 * that refuses fields it does not know, then the checks of the server. The window of this
 * computer does not use these handlers.
 */
export type ChangeHandler = (input: unknown) => Effect.Effect<unknown, AppError, AppServices>

/** Checks a request against a schema. A field that the schema does not list refuses the request. */
export const strict =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })(input).pipe(
      E.mapError((e) => new AppError({ code: "invalid_input", detail: e.message })),
    )

export const Id = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))
const ById = Schema.Struct({ id: Id })

/**
 * The device that asks, once the switch is on for it. The switch is read at each request, so a
 * device that lost it a moment ago gets the error also on a connection that was open before.
 */
export const allowed = E.gen(function* () {
  const actor = yield* CurrentActor
  if (!actor) return yield* new AppError({ code: "not_allowed" })
  const devices = yield* Devices
  if (!devices.canChange(actor.id)) {
    // The detail names this computer; the client puts the name that it shows for it.
    return yield* new AppError({ code: "change_off", detail: devices.deviceName() })
  }
  return actor
})

/** A client never sees where the folder of an agent is (spec 012, "Workspace"). */
export const forClient = (agent: Agent): Agent => ({ ...agent, workspace: "" })

/** The id of this server must be the one that the request names. */
export const ownServer = (serverId: string) =>
  Servers.use((s) => s.local).pipe(
    E.flatMap((local) =>
      local.id === serverId ? E.void : E.fail(new AppError({ code: "invalid_input" })),
    ),
  )

/**
 * A model that a client picks must be one that the server offers now: the account is connected
 * here and the model (and effort) is on the list of that account. A client sends no key.
 */
export const checkModel = (
  model: { accountId: string; model: string; effort: string | null } | null,
) =>
  E.gen(function* () {
    if (model === null) return
    const providers = yield* Providers
    const unknown = new AppError({ code: "model_not_found" })
    if (!providers.isConnected(model.accountId)) return yield* unknown
    const list = yield* providers
      .models(model.accountId)
      .pipe(E.mapError(() => new AppError({ code: "model_not_found" })))
    const info = list.find((m) => m.id === model.model)
    if (!info) return yield* unknown
    if (model.effort !== null && !info.efforts.includes(model.effort)) return yield* unknown
  })

/** The connected accounts and their models, without any key. */
export const modelChoices = E.gen(function* () {
  const providers = yield* Providers
  const accounts = yield* providers.list
  const out: ModelChoice[] = []
  for (const account of accounts) {
    if (!account.connected) continue
    const models = yield* providers.models(account.id).pipe(E.orElseSucceed(() => []))
    out.push({
      accountId: account.id,
      accountName: account.name,
      kind: account.kind,
      readOnly: yield* providers.readOnlySupported(account.id),
      models,
    })
  }
  return out
})

const memoryText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MEMORY_TEXT_MAX * 2),
)

export const changeHandlers: Record<string, ChangeHandler> = {
  "agents.create": (input) =>
    E.gen(function* () {
      yield* allowed
      const data = yield* strict(ClientAgentCreate)(input)
      yield* ownServer(data.serverId)
      if (data.model) yield* checkModel(data.model)
      if (data.backupModel) yield* checkModel(data.backupModel)
      // The server makes a new, empty folder in its own default folder, and the level starts at
      // the default for a new agent. Neither can come from the request.
      return forClient(yield* Agents.use((a) => a.create(data)))
    }),

  "agents.update": (input) =>
    E.gen(function* () {
      yield* allowed
      const { id, patch } = yield* strict(Schema.Struct({ id: Id, patch: ClientAgentPatch }))(input)
      if (patch.model) yield* checkModel(patch.model)
      if (patch.backupModel) yield* checkModel(patch.backupModel)
      // The level is compared with the level now, in the same step as the change.
      const agents = yield* Agents
      const current = yield* agents.get(id)
      if (patch.permission !== undefined && isLooser(patch.permission, current.permission)) {
        return yield* new AppError({ code: "not_allowed" })
      }
      return forClient(yield* agents.update(id, patch))
    }),

  "agents.duplicate": (input) =>
    E.gen(function* () {
      yield* allowed
      const { id, suffix } = yield* strict(
        Schema.Struct({ id: Id, suffix: Schema.String.check(Schema.isMaxLength(20)) }),
      )(input)
      return forClient(yield* Agents.use((a) => a.duplicate(id, suffix)))
    }),

  "agents.archive": (input) =>
    E.gen(function* () {
      yield* allowed
      const { id } = yield* strict(ById)(input)
      const agents = yield* Agents
      yield* agents.get(id)
      // The agent has to be stopped first; the client does not stop it as a side effect.
      const activity = yield* Activity
      if (activity.isWorking(id)) return yield* new AppError({ code: "agent_working_archive" })
      return forClient(yield* agents.archive(id))
    }),

  "agents.useMain": (input) =>
    E.gen(function* () {
      yield* allowed
      const { id } = yield* strict(ById)(input)
      return forClient(yield* Agents.use((a) => a.useMain(id)))
    }),

  "channels.create": (input) =>
    E.gen(function* () {
      yield* allowed
      const data = yield* strict(ClientChannelCreate)(input)
      yield* ownServer(data.serverId)
      return yield* Channels.use((c) => c.create(data))
    }),

  "channels.update": (input) =>
    E.gen(function* () {
      yield* allowed
      const { id, patch } = yield* strict(Schema.Struct({ id: Id, patch: ClientChannelPatch }))(
        input,
      )
      return yield* Channels.use((c) => c.update(id, patch))
    }),

  "memory.list": (input) =>
    E.gen(function* () {
      yield* allowed
      const { agentId, query } = yield* strict(
        Schema.Struct({
          agentId: Id,
          query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
        }),
      )(input)
      return yield* Memory.use((m) => m.list(agentId, query))
    }),

  "memory.add": (input) =>
    E.gen(function* () {
      yield* allowed
      const { agentId, text } = yield* strict(Schema.Struct({ agentId: Id, text: memoryText }))(
        input,
      )
      return yield* Memory.use((m) => m.add(agentId, text, "user"))
    }),

  "memory.update": (input) =>
    E.gen(function* () {
      yield* allowed
      const { id, text } = yield* strict(Schema.Struct({ id: Id, text: memoryText }))(input)
      return yield* Memory.use((m) => m.update(id, text))
    }),

  "memory.delete": (input) =>
    E.gen(function* () {
      yield* allowed
      const { id } = yield* strict(ById)(input)
      yield* Memory.use((m) => m.remove(id))
    }),

  "models.available": (input) =>
    E.gen(function* () {
      yield* allowed
      if (input !== undefined && input !== null)
        return yield* new AppError({ code: "invalid_input" })
      return yield* modelChoices
    }),
}
