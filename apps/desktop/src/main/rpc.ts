import {
  ACTION_KINDS,
  AgentCreate,
  AgentModel,
  AgentPatch,
  AgentStarterCreate,
  BrowserProfileCreate,
  ChannelCreate,
  ChannelPatch,
  ChatSend,
  CONNECTION_TOOLS_MAX,
  DEVICE_NAME_MAX,
  DecisionKeys,
  HAND_OFF_RULES,
  isClientMethod,
  MEMORY_MODES,
  MESSAGE_MAX,
  MOVE_DIRECTIONS,
  MUTE_CHOICES,
  PlaceKind,
  ProviderConnect,
  parseAddress,
  REVIEW_CHANGES_MAX,
  RoutineInput,
  RoutinePatch,
  type RpcInput,
  type RpcMethod,
  type RpcOutput,
  type RpcResult,
  RUNTIME_KINDS,
  redactSecrets,
  SEARCH_CAP,
  SEARCH_QUERY_MAX,
  SectionCreate,
  SettingsPatch,
  SIGN_IN_ID,
  SYNC_MODES,
  TeamsPatch,
  UiStatePatch,
  USAGE_RANGES,
  WorkflowInput,
  WorkflowPatch,
} from "@robot/shared"
import { Cause, Effect, Exit, type ManagedRuntime, Schema } from "effect"
import type { AppServices } from "./layers.ts"
import { Id, modelChoices, ownServer, strict } from "./link/changes.ts"
import { linkHandlers, withUploads } from "./link/handlers.ts"
import { ActionLog } from "./services/ActionLog.ts"
import { Activity } from "./services/Activity.ts"
import { AgentFiles } from "./services/AgentFiles.ts"
import { AgentSettings } from "./services/AgentSettings.ts"
import { Agents } from "./services/Agents.ts"
import type { Actor } from "./services/actor.ts"
import { CurrentActor } from "./services/actor.ts"
import { BrowserProfiles } from "./services/BrowserProfiles.ts"
import { Channels } from "./services/Channels.ts"
import { ChannelTools } from "./services/ChannelTools.ts"
import { Chat } from "./services/Chat.ts"
import { Checklists } from "./services/Checklists.ts"
import { Connections } from "./services/Connections.ts"
import { Data } from "./services/Data.ts"
import { Decision } from "./services/Decision.ts"
import { Devices } from "./services/Devices.ts"
import { EventBus } from "./services/EventBus.ts"
import { AppError } from "./services/errors.ts"
import { FollowUps } from "./services/FollowUps.ts"
import { Handbook } from "./services/Handbook.ts"
import { Handover } from "./services/Handover.ts"
import { Host, type HostMethod, isHostMethod } from "./services/Host.ts"
import { KeepAwake } from "./services/KeepAwake.ts"
import { Knowledge } from "./services/Knowledge.ts"
import { Memory, MemoryFilterSchema } from "./services/Memory.ts"
import { MemoryCheck } from "./services/MemoryCheck.ts"
import { Notifier } from "./services/Notifier.ts"
import { Organization } from "./services/Organization.ts"
import { OrgChart } from "./services/OrgChart.ts"
import { PlaceMarks } from "./services/PlaceMarks.ts"
import { Places } from "./services/Places.ts"
import { Platform } from "./services/Platform.ts"
import { Providers } from "./services/Providers.ts"
import { Remote } from "./services/Remote.ts"
import { Routines } from "./services/Routines.ts"
import { Rules } from "./services/Rules.ts"
import { Runtimes } from "./services/Runtimes.ts"
import { SavedSecrets } from "./services/SavedSecrets.ts"
import { Search } from "./services/Search.ts"
import { Sections } from "./services/Sections.ts"
import { Servers } from "./services/Servers.ts"
import { SettingsStore } from "./services/Settings.ts"
import { SkillDrafts } from "./services/SkillDrafts.ts"
import { Skills } from "./services/Skills.ts"
import { Starters } from "./services/Starters.ts"
import { Sync } from "./services/Sync.ts"
import { Tasks } from "./services/Tasks.ts"
import { Teach } from "./services/Teach.ts"
import { TeamsLink } from "./services/TeamsLink.ts"
import { Today } from "./services/Today.ts"
import { Tools } from "./services/Tools.ts"
import { UiStore } from "./services/UiStore.ts"
import { Usage } from "./services/Usage.ts"
import { WorkflowFiles } from "./services/WorkflowFiles.ts"
import { Workflows } from "./services/Workflows.ts"
import { STAGE_ROOT, stageFile } from "./staging.ts"

export type Services = AppServices

type Handler<M extends RpcMethod> = (
  input: RpcInput<M>,
) => Effect.Effect<RpcOutput<M>, AppError, Services>

/** Every window call has a handler here, except the calls that the host program answers. */
type Handlers = { [M in Exclude<RpcMethod, HostMethod>]: Handler<M> }

/** Checks untrusted input from the renderer against a schema. */
const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((e) => new AppError({ code: "invalid_input", detail: e.message })),
    )

const ById = Schema.Struct({ id: Schema.String })
/** A rule that the user adds or edits in the rules list (spec 007). */
const RuleInputSchema = Schema.Struct({
  agentId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["file", "shell", "web", "connection", "secret"]),
  text: Schema.String,
  detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  decision: Schema.Literals(["allow", "deny"]),
})
/** A line of the connection form: an environment value or a header (spec 018). */
const ConnectionEntrySchema = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(1000)),
  value: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100_000))),
  secret: Schema.Boolean,
})
/** The form of a connection (spec 018). The service checks the limits of each field. */
const ConnectionInputSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(1000)),
  kind: Schema.Literals(["program", "web"]),
  command: Schema.String.check(Schema.isMaxLength(10_000)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(20_000))).check(
    Schema.isMaxLength(1000),
  ),
  folder: Schema.String.check(Schema.isMaxLength(10_000)),
  env: Schema.Array(ConnectionEntrySchema).check(Schema.isMaxLength(1000)),
  address: Schema.String.check(Schema.isMaxLength(20_000)),
  headers: Schema.Array(ConnectionEntrySchema).check(Schema.isMaxLength(1000)),
  agents: Schema.Union([
    Schema.Literal("all"),
    Schema.Array(Schema.String).check(Schema.isMaxLength(1000)),
  ]),
  /** The channels in the list of the connection (spec 018, 030). */
  channels: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(1000))),
})
const SettingsLine = Schema.Struct({
  agentId: Schema.String,
  messageId: Schema.String,
  callId: Schema.String,
})
const ByAccount = Schema.Struct({ accountId: Schema.String })
const SignInId = Schema.String.check(Schema.isPattern(SIGN_IN_ID))
const ByRuntime = Schema.Struct({
  kind: Schema.Literals(RUNTIME_KINDS),
  signIn: Schema.optionalKey(Schema.NullOr(SignInId)),
})
const ByAgent = Schema.Struct({ agentId: Schema.String })
/** A conversation of an agent: the main thread when `threadId` is missing or null (spec 003). */
const ByThread = Schema.Struct({
  agentId: Schema.String,
  threadId: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
const placeOf = (input: { readonly agentId: string; readonly threadId?: string | null }) => ({
  agentId: input.agentId,
  threadId: input.threadId ?? null,
})
const FileOfMessage = Schema.Struct({
  agentId: Schema.String,
  path: Schema.String.check(Schema.isMaxLength(300)),
  size: Schema.Number,
  messageId: Schema.String,
})
const MessageText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MESSAGE_MAX))
const done = Effect.as(undefined)

/**
 * The options of a retry. A request of a linked device asks about steps that are on this
 * computer, so the retry note names this computer and shows no list (spec 005, 012).
 */
const retryOptions = (confirmed: boolean | undefined) =>
  Effect.gen(function* () {
    const actor = yield* CurrentActor
    const awayFrom = actor
      ? yield* Devices.use((d) => Effect.sync(() => d.deviceName()))
      : undefined
    return {
      ...(confirmed ? { confirmed } : {}),
      ...(awayFrom !== undefined ? { awayFrom } : {}),
    }
  })
const ByLink = Schema.Struct({ linkId: Schema.String })

/**
 * Answers an approval or a question card. A card of a task that runs on the other computer of a
 * sync pair (spec 019) goes to that computer, as the answer of a client does.
 */
const answerCard = (agentId: string, callId: string, answer: string) =>
  Sync.use((s) => s.respond(agentId, callId, answer)).pipe(
    Effect.flatMap((sent) =>
      sent ? Effect.void : Tools.use((t) => t.respond(agentId, callId, answer)),
    ),
  )

const applySystemSettings = Effect.fn("applySystemSettings")(function* (
  patch: typeof SettingsPatch.Type,
) {
  const platform = yield* Platform
  if (patch.startAtLogin !== undefined) platform.setStartAtLogin(patch.startAtLogin)
  if (patch.theme !== undefined) platform.setThemeSource(patch.theme)
})

export const handlers: Handlers = {
  "app.info": () =>
    Effect.gen(function* () {
      const p = yield* Platform
      return {
        name: p.appName,
        version: p.appVersion,
        platform: p.platform,
        systemLocale: p.systemLocale(),
        dataDir: p.dataDir,
        defaultWorkspaceRoot: p.defaultWorkspaceRoot,
      }
    }),
  "app.copy": (input) =>
    decode(Schema.Struct({ text: Schema.String }))(input).pipe(
      Effect.flatMap(({ text }) => Platform.use((p) => Effect.sync(() => p.copyText(text)))),
      done,
    ),
  "app.diagnosticReport": () =>
    Platform.use((p) =>
      Effect.promise(async () => {
        const { text, path } = await p.diagnosticReport()
        p.copyText(text)
        return { path }
      }),
    ),
  "app.openExternal": (input) =>
    decode(Schema.Struct({ url: Schema.String }))(input).pipe(
      Effect.flatMap(({ url }) =>
        /^(https?:|mailto:)/i.test(url)
          ? Platform.use((p) => Effect.promise(() => p.openExternal(url)))
          : Effect.fail(new AppError({ code: "invalid_input" })),
      ),
      done,
    ),
  "settings.get": () => SettingsStore.use((s) => s.get),
  "settings.update": (input) =>
    Effect.gen(function* () {
      const decoded = yield* decode(SettingsPatch)(input)
      // The device name and the switch go through "devices.update", which also opens or closes
      // the listener. The saved port is the app's own.
      const { deviceName: _name, acceptLinks: _accept, linkPort: _port, ...patch } = decoded
      // The switch "Permission checks" can go on only when the decision model is set up (spec 013).
      if (patch.permissionChecks === true && !(yield* Decision.use((d) => d.ready)))
        return yield* new AppError({ code: "decision_not_set_up" })
      const next = yield* SettingsStore.use((s) => s.update(patch))
      yield* applySystemSettings(patch)
      if (patch.island !== undefined) yield* Notifier.use((n) => Effect.sync(() => n.refresh()))
      return next
    }),
  "settings.pickWorkspaceRoot": () =>
    Effect.gen(function* () {
      const p = yield* Platform
      const store = yield* SettingsStore
      const current = yield* store.get
      const picked = yield* Effect.promise(() =>
        p.pickFolder(current.workspaceRoot || p.defaultWorkspaceRoot),
      )
      return picked ? yield* store.update({ workspaceRoot: picked }) : current
    }),
  "data.openFolder": () =>
    Effect.gen(function* () {
      const p = yield* Platform
      yield* Effect.promise(() => p.openPath(p.dataDir))
      return undefined
    }),
  "servers.list": () =>
    Effect.gen(function* () {
      const devices = yield* Devices
      const local = yield* Servers.use((s) => s.list)
      const linked = yield* Remote.use((r) => Effect.succeed(r.servers()))
      // This computer shows under the name that linked devices see.
      return [
        ...local.map((s) => (s.kind === "local" ? { ...s, name: devices.deviceName() } : s)),
        ...linked,
      ]
    }),
  "servers.retry": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Remote.use((r) => Effect.sync(() => r.retry(serverId)))),
      done,
    ),
  "devices.get": () =>
    Effect.gen(function* () {
      const devices = yield* Devices
      const remote = yield* Remote
      return { ...devices.state(), servers: remote.entries() }
    }),
  "devices.update": (input) =>
    decode(
      Schema.Struct({
        name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DEVICE_NAME_MAX))),
        accept: Schema.optionalKey(Schema.Boolean),
      }),
    )(input).pipe(
      Effect.flatMap((patch) => Devices.use((d) => d.update(patch))),
      Effect.flatMap((state) =>
        Remote.use((r) => Effect.succeed({ ...state, servers: r.entries() })),
      ),
    ),
  "devices.pair.start": () => Devices.use((d) => d.pairStart()),
  "devices.pair.get": () => Devices.use((d) => Effect.sync(() => d.pairing())),
  "devices.pair.stop": () => Devices.use((d) => Effect.sync(() => d.pairStop())),
  "devices.join.list": () => Devices.use((d) => Effect.sync(() => d.joins())),
  "devices.join.decide": (input) =>
    decode(
      Schema.Struct({
        id: Schema.String,
        allow: Schema.Boolean,
        canChange: Schema.optionalKey(Schema.Boolean),
      }),
    )(input).pipe(
      Effect.flatMap(({ id, allow, canChange }) =>
        Devices.use((d) => d.decide(id, allow, canChange === true)),
      ),
      done,
    ),
  "devices.client.remove": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Devices.use((d) => d.removeClient(id))),
      done,
    ),
  "devices.client.setChange": (input) =>
    decode(Schema.Struct({ id: Schema.String, canChange: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ id, canChange }) => Devices.use((d) => d.setCanChange(id, canChange))),
      done,
    ),
  "devices.server.remove": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Remote.use((r) => r.remove(id))),
      done,
    ),
  "devices.server.setAddresses": (input) =>
    decode(Schema.Struct({ id: Schema.String, addresses: Schema.Array(Schema.String) }))(
      input,
    ).pipe(
      Effect.flatMap(({ id, addresses }) =>
        Effect.gen(function* () {
          const list = addresses.map((a) => a.trim()).filter(Boolean)
          if (list.length === 0 || list.length > 16 || list.some((a) => !parseAddress(a))) {
            return yield* new AppError({ code: "invalid_address" })
          }
          const devices = yield* Devices
          const remote = yield* Remote
          yield* devices.setAddresses(id, list)
          const entry = remote.entries().find((e) => e.id === id)
          if (entry) remote.retry(entry.serverId)
          return remote.entries().find((e) => e.id === id) ?? entry
        }),
      ),
      Effect.flatMap((entry) =>
        entry ? Effect.succeed(entry) : Effect.fail(new AppError({ code: "server_not_found" })),
      ),
    ),
  "devices.connect.probe": (input) =>
    decode(
      Schema.Struct({
        link: Schema.optionalKey(Schema.String),
        address: Schema.optionalKey(Schema.String),
        code: Schema.optionalKey(Schema.String),
      }),
    )(input).pipe(Effect.flatMap((v) => Remote.use((r) => r.probe(v)))),
  "devices.connect.finish": (input) =>
    decode(Schema.Struct({ session: Schema.String, twoWay: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ session, twoWay }) => Remote.use((r) => r.finish(session, twoWay))),
    ),
  "devices.connect.cancel": (input) =>
    decode(Schema.Struct({ session: Schema.String }))(input).pipe(
      Effect.flatMap(({ session }) => Remote.use((r) => r.cancel(session))),
      done,
    ),
  "devices.nearby": () => Devices.use((d) => d.nearby()),
  "sync.list": () => Sync.use((s) => Effect.sync(() => s.statuses())),
  "sync.preview": (input) =>
    decode(ByLink)(input).pipe(Effect.flatMap(({ linkId }) => Sync.use((s) => s.preview(linkId)))),
  "sync.start": (input) =>
    decode(Schema.Struct({ linkId: Schema.String, mode: Schema.Literals(SYNC_MODES) }))(input).pipe(
      Effect.flatMap(({ linkId, mode }) => Sync.use((s) => s.start(linkId, mode))),
    ),
  "sync.cancelOffer": (input) =>
    decode(ByLink)(input).pipe(
      Effect.flatMap(({ linkId }) => Sync.use((s) => s.cancelOffer(linkId))),
      done,
    ),
  "sync.pause": (input) =>
    decode(ByLink)(input).pipe(
      Effect.flatMap(({ linkId }) => Sync.use((s) => s.setPaused(linkId, true))),
      done,
    ),
  "sync.resume": (input) =>
    decode(ByLink)(input).pipe(
      Effect.flatMap(({ linkId }) => Sync.use((s) => s.setPaused(linkId, false))),
      done,
    ),
  "sync.stop": (input) =>
    decode(ByLink)(input).pipe(
      Effect.flatMap(({ linkId }) => Sync.use((s) => s.stop(linkId))),
      done,
    ),
  "sync.dismiss": (input) =>
    decode(ByLink)(input).pipe(
      Effect.flatMap(({ linkId }) => Sync.use((s) => s.dismiss(linkId))),
      done,
    ),
  "sync.requests": () => Sync.use((s) => Effect.sync(() => s.requests())),
  "sync.decide": (input) =>
    decode(Schema.Struct({ id: Schema.String, allow: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ id, allow }) => Sync.use((s) => s.decide(id, allow))),
      done,
    ),
  "sync.changes": () => Sync.use((s) => Effect.sync(() => s.changes())),
  "sync.guard": () => Sync.use((s) => Effect.sync(() => s.guard())),
  "sync.guard.decide": (input) =>
    decode(Schema.Struct({ remove: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ remove }) => Sync.use((s) => s.decideGuard(remove))),
      done,
    ),
  "sync.file.here": (input) =>
    decode(FileOfMessage)(input).pipe(
      Effect.flatMap(({ agentId, path, size, messageId }) =>
        Sync.use((s) => Effect.succeed(s.fileHere(agentId, path, size, messageId))),
      ),
    ),
  "sync.file.open": (input) =>
    decode(FileOfMessage)(input).pipe(
      Effect.flatMap((file) => Sync.use((s) => s.openFile(file))),
      done,
    ),
  // Saving a file of a linked server is carried out over the link, see `Remote.invoke`.
  "attachments.save": () => Effect.fail(new AppError({ code: "not_allowed" })),
  // The picture of a file of this computer. A linked server sends it over the link.
  "attachments.picture": (input) =>
    decode(FileOfMessage)(input).pipe(
      Effect.flatMap((file) => Sync.use((s) => Effect.promise(() => s.picture(file)))),
    ),
  "places.list": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Places.use((p) => p.list(serverId))),
    ),
  "places.move": (input) =>
    decode(
      Schema.Struct({
        kind: PlaceKind,
        id: Schema.String,
        sectionId: Schema.NullOr(Schema.String),
      }),
    )(input).pipe(
      Effect.flatMap(({ kind, id, sectionId }) =>
        Sections.use((s) => s.assign({ kind, id }, sectionId)),
      ),
      done,
    ),
  "sections.create": (input) =>
    decode(SectionCreate)(input).pipe(
      Effect.flatMap((data) => Sections.use((s) => s.create(data))),
    ),
  "sections.rename": (input) =>
    decode(Schema.Struct({ id: Schema.String, name: Schema.String }))(input).pipe(
      Effect.flatMap(({ id, name }) => Sections.use((s) => s.rename(id, name))),
    ),
  "sections.move": (input) =>
    decode(Schema.Struct({ id: Schema.String, direction: Schema.Literals(MOVE_DIRECTIONS) }))(
      input,
    ).pipe(
      Effect.flatMap(({ id, direction }) => Sections.use((s) => s.move(id, direction))),
      done,
    ),
  "sections.delete": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Sections.use((s) => s.remove(id))),
      done,
    ),
  "teams.get": () => TeamsLink.use((t) => t.view),
  "teams.setup": () => TeamsLink.use((t) => t.setup),
  "teams.update": (input) =>
    decode(TeamsPatch)(input).pipe(
      Effect.flatMap((patch) => TeamsLink.use((t) => t.update(patch))),
    ),
  "teams.setEnabled": (input) =>
    decode(Schema.Struct({ enabled: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ enabled }) => TeamsLink.use((t) => t.setEnabled(enabled))),
    ),
  "teams.showPage": () => TeamsLink.use((t) => t.showPage),
  "teams.hidePage": () => TeamsLink.use((t) => t.hidePage),
  "teams.place": (input) =>
    decode(
      Schema.Struct({
        bounds: Schema.NullOr(
          Schema.Struct({
            x: Schema.Number,
            y: Schema.Number,
            width: Schema.Number,
            height: Schema.Number,
          }),
        ),
      }),
    )(input).pipe(
      Effect.flatMap(({ bounds }) => TeamsLink.use((t) => t.place(bounds ?? undefined))),
      done,
    ),
  "teams.useChat": () => TeamsLink.use((t) => t.useChat),
  "teams.readSenders": () => TeamsLink.use((t) => t.readSenders),
  "teams.resume": () => TeamsLink.use((t) => t.resume),
  "teams.signOut": () => TeamsLink.use((t) => t.signOut),
  "teams.remove": () => TeamsLink.use((t) => t.remove),
  "browserProfiles.list": () => BrowserProfiles.use((b) => b.list),
  "browserProfiles.create": (input) =>
    decode(BrowserProfileCreate)(input).pipe(
      Effect.flatMap(({ name }) => BrowserProfiles.use((b) => b.create(name))),
    ),
  "browserProfiles.rename": (input) =>
    decode(Schema.Struct({ id: Schema.String, name: Schema.String }))(input).pipe(
      Effect.flatMap(({ id, name }) => BrowserProfiles.use((b) => b.rename(id, name))),
    ),
  "browserProfiles.delete": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => BrowserProfiles.use((b) => b.remove(id))),
      done,
    ),
  "browserProfiles.assign": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, profileId: Schema.NullOr(Schema.String) }))(
      input,
    ).pipe(
      Effect.flatMap(({ agentId, profileId }) =>
        BrowserProfiles.use((b) => b.assign(agentId, profileId)),
      ),
      done,
    ),
  "ui.get": () => UiStore.use((s) => s.get),
  "ui.update": (input) =>
    decode(UiStatePatch)(input).pipe(
      Effect.flatMap((patch) => UiStore.use((s) => s.update(patch))),
    ),
  "agents.list": (input) =>
    decode(Schema.Struct({ serverId: Schema.String, archived: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ serverId, archived }) => Agents.use((a) => a.list(serverId, archived))),
    ),
  "agents.get": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Agents.use((a) => a.get(id)))),
  "agents.create": (input) =>
    decode(AgentCreate)(input).pipe(Effect.flatMap((data) => Agents.use((a) => a.create(data)))),
  "agents.createFromStarter": (input) =>
    decode(AgentStarterCreate)(input).pipe(
      Effect.flatMap((data) => Starters.use((s) => s.create(data))),
    ),
  "agents.update": (input) =>
    decode(Schema.Struct({ id: Schema.String, patch: AgentPatch }))(input).pipe(
      Effect.flatMap(({ id, patch }) => Agents.use((a) => a.update(id, patch))),
    ),
  "agents.duplicate": (input) =>
    decode(
      Schema.Struct({ id: Schema.String, suffix: Schema.String.check(Schema.isMaxLength(20)) }),
    )(input).pipe(Effect.flatMap(({ id, suffix }) => Agents.use((a) => a.duplicate(id, suffix)))),
  "agents.archive": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Agents.use((a) => a.archive(id)))),
  "agents.useMain": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Agents.use((a) => a.useMain(id)))),
  "agents.restore": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Agents.use((a) => a.restore(id)))),
  "agents.delete": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Agents.use((a) => a.remove(id))),
      Effect.as(undefined),
    ),
  "agents.setFaceImage": (input) =>
    decode(Schema.Struct({ id: Schema.String, dataUrl: Schema.NullOr(Schema.String) }))(input).pipe(
      Effect.flatMap(({ id, dataUrl }) => Agents.use((a) => a.setFaceImage(id, dataUrl))),
    ),
  "agents.history.list": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => AgentSettings.use((s) => s.history(agentId))),
    ),
  "agents.history.restore": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, versionId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, versionId }) =>
        AgentSettings.use((s) => s.restore(agentId, versionId)),
      ),
    ),
  "agents.settings.line": (input) =>
    decode(SettingsLine)(input).pipe(
      Effect.flatMap(({ agentId, messageId, callId }) =>
        AgentSettings.use((s) => s.lineState(agentId, messageId, callId)),
      ),
    ),
  "agents.settings.undo": (input) =>
    decode(SettingsLine)(input).pipe(
      Effect.flatMap(({ agentId, messageId, callId }) =>
        Effect.gen(function* () {
          yield* AgentSettings.use((s) => s.undo(agentId, messageId, callId))
          // The line of the message shows that it was undone.
          yield* Chat.use((c) => Effect.sync(() => c.announce(messageId)))
        }),
      ),
      Effect.as(undefined),
    ),
  "models.available": () => modelChoices,
  "agentFile.export": (input) =>
    decode(
      Schema.Struct({
        serverId: Schema.String,
        agentIds: Schema.Array(Schema.String),
        channels: Schema.optionalKey(Schema.Boolean),
        skills: Schema.optionalKey(Schema.Boolean),
        handbook: Schema.optionalKey(Schema.Boolean),
      }),
    )(input).pipe(Effect.flatMap((data) => AgentFiles.use((f) => f.export(data)))),
  "agentFile.open": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => AgentFiles.use((f) => f.open(serverId))),
    ),
  "agentFile.apply": (input) =>
    decode(
      Schema.Struct({
        serverId: Schema.String,
        model: Schema.NullOr(AgentModel),
        pick: Schema.Array(
          Schema.Struct({
            index: Schema.Int,
            instructions: Schema.Boolean,
            routines: Schema.Array(Schema.Int),
          }),
        ),
        channels: Schema.optionalKey(Schema.Array(Schema.Int)),
        skills: Schema.optionalKey(Schema.Array(Schema.Int)),
        handbook: Schema.optionalKey(Schema.Boolean),
      }),
    )(input).pipe(Effect.flatMap((data) => AgentFiles.use((f) => f.import(data)))),
  "checklists.forAgent": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => Checklists.use((c) => c.forAgent(agentId))),
    ),
  "checklists.forWorkflow": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) => Checklists.use((c) => c.forWorkflow(workflowId))),
    ),
  "providers.list": () => Providers.use((p) => p.list),
  "providers.connect": (input) =>
    decode(ProviderConnect)(input).pipe(
      Effect.flatMap((data) => Providers.use((p) => p.connect(data))),
    ),
  "providers.check": (input) =>
    decode(ByAccount)(input).pipe(
      Effect.flatMap(({ accountId }) => Providers.use((p) => p.check(accountId))),
      Effect.as(undefined),
    ),
  "providers.disconnect": (input) =>
    decode(ByAccount)(input).pipe(
      Effect.flatMap(({ accountId }) => Providers.use((p) => p.disconnect(accountId))),
      Effect.as(undefined),
    ),
  "providers.remove": (input) =>
    decode(ByAccount)(input).pipe(
      Effect.flatMap(({ accountId }) => Providers.use((p) => p.remove(accountId))),
      Effect.as(undefined),
    ),
  "providers.models": (input) =>
    decode(ByAccount)(input).pipe(
      Effect.flatMap(({ accountId }) => Providers.use((p) => p.models(accountId))),
    ),
  "providers.setModel": (input) =>
    decode(
      Schema.Struct({
        accountId: Schema.String,
        model: Schema.String,
        hidden: Schema.optionalKey(Schema.Boolean),
        contextSize: Schema.optionalKey(Schema.NullOr(Schema.Number)),
        outputLimit: Schema.optionalKey(Schema.NullOr(Schema.Number)),
      }),
    )(input).pipe(
      Effect.flatMap(({ accountId, model, ...patch }) =>
        Providers.use((p) => p.setModel(accountId, model, patch)),
      ),
      Effect.as(undefined),
    ),
  "providers.setAllModels": (input) =>
    decode(Schema.Struct({ accountId: Schema.String, hidden: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ accountId, hidden }) =>
        Providers.use((p) => p.setAllModels(accountId, hidden)),
      ),
      Effect.as(undefined),
    ),
  "providers.addModel": (input) =>
    decode(Schema.Struct({ accountId: Schema.String, model: Schema.String }))(input).pipe(
      Effect.flatMap(({ accountId, model }) => Providers.use((p) => p.addModel(accountId, model))),
      Effect.as(undefined),
    ),
  "providers.removeModel": (input) =>
    decode(Schema.Struct({ accountId: Schema.String, model: Schema.String }))(input).pipe(
      Effect.flatMap(({ accountId, model }) =>
        Providers.use((p) => p.removeModel(accountId, model)),
      ),
      Effect.as(undefined),
    ),
  "runtimes.status": (input) =>
    decode(ByRuntime)(input).pipe(
      Effect.flatMap(({ kind, signIn }) => Runtimes.use((r) => r.status(kind, signIn))),
    ),
  "runtimes.install": (input) =>
    decode(ByRuntime)(input).pipe(
      Effect.flatMap(({ kind, signIn }) => Runtimes.use((r) => r.install(kind, signIn))),
    ),
  "runtimes.signIn": (input) =>
    decode(ByRuntime)(input).pipe(
      Effect.flatMap(({ kind, signIn }) => Runtimes.use((r) => r.signIn(kind, signIn))),
    ),
  "runtimes.repair": (input) =>
    decode(ByRuntime)(input).pipe(
      Effect.flatMap(({ kind, signIn }) => Runtimes.use((r) => r.repair(kind, signIn))),
    ),
  "runtimes.readOnly": (input) =>
    decode(ByRuntime)(input).pipe(
      Effect.flatMap(({ kind }) => Runtimes.use((r) => r.readOnly(kind))),
    ),
  "runtimes.cancel": (input) =>
    decode(ByRuntime)(input).pipe(
      Effect.flatMap(({ kind, signIn }) => Runtimes.use((r) => r.cancel(kind, signIn))),
      Effect.as(undefined),
    ),
  "providers.discardSignIn": (input) =>
    decode(Schema.Struct({ kind: Schema.Literals(RUNTIME_KINDS), signIn: SignInId }))(input).pipe(
      Effect.flatMap(({ kind, signIn }) => Providers.use((p) => p.discardSignIn(kind, signIn))),
      Effect.as(undefined),
    ),
  "files.pick": () => Platform.use((p) => Effect.promise(() => p.pickFiles())),
  "files.stage": (input) =>
    decode(Schema.Struct({ name: Schema.String, data: Schema.Uint8Array }))(input).pipe(
      Effect.flatMap(({ name, data }) =>
        Effect.try({
          try: () => stageFile(STAGE_ROOT, name, data),
          catch: (e) =>
            e instanceof AppError ? e : new AppError({ code: "file_unreadable", detail: name }),
        }),
      ),
    ),
  "data.export": () => Data.use((d) => d.export()),
  "data.restore": () => Data.use((d) => d.import()),
  "tasks.list": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Tasks.use((t) => t.list(serverId))),
    ),
  "tasks.get": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Tasks.use((t) => t.get(id)))),
  "tasks.recent": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => Tasks.use((t) => Effect.sync(() => t.recent(agentId)))),
    ),
  "tasks.stop": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Tasks.use((t) => t.stopAny(id))),
      done,
    ),
  "tasks.runNext": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Tasks.use((t) => t.runNext(id))),
      done,
    ),
  "tasks.retry": (input) =>
    decode(Schema.Struct({ id: Schema.String, confirmed: Schema.optionalKey(Schema.Boolean) }))(
      input,
    ).pipe(
      Effect.flatMap(({ id, confirmed }) =>
        retryOptions(confirmed).pipe(Effect.flatMap((o) => Tasks.use((t) => t.retry(id, o)))),
      ),
    ),
  "tasks.accept": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Tasks.use((t) => t.accept(id))),
      done,
    ),
  "tasks.requestChanges": (input) =>
    decode(
      Schema.Struct({
        id: Schema.String,
        // The text is checked for its length after it is trimmed (spec 005).
        text: Schema.String.check(Schema.isMaxLength(REVIEW_CHANGES_MAX * 2)),
      }),
    )(input).pipe(
      Effect.flatMap(({ id, text }) => Tasks.use((t) => t.requestChanges(id, text))),
      done,
    ),
  "tasks.endRequest": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Tasks.use((t) => t.endRequest(id))),
      done,
    ),
  "followups.list": (input) =>
    decode(Schema.Struct({ taskId: Schema.String }))(input).pipe(
      Effect.flatMap(({ taskId }) => FollowUps.use((f) => f.ofTask(taskId))),
    ),
  "followups.remove": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => FollowUps.use((f) => f.remove(id))),
      done,
    ),
  "channels.list": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Channels.use((c) => c.list(serverId))),
    ),
  "channels.create": (input) =>
    decode(ChannelCreate)(input).pipe(
      Effect.flatMap((data) => Channels.use((c) => c.create(data))),
    ),
  "channels.update": (input) =>
    decode(Schema.Struct({ id: Schema.String, patch: ChannelPatch }))(input).pipe(
      Effect.flatMap(({ id, patch }) => Channels.use((c) => c.update(id, patch))),
    ),
  "channels.setPicture": (input) =>
    decode(Schema.Struct({ id: Schema.String, dataUrl: Schema.NullOr(Schema.String) }))(input).pipe(
      Effect.flatMap(({ id, dataUrl }) => Channels.use((c) => c.setPicture(id, dataUrl))),
    ),
  "channels.delete": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Channels.use((c) => c.remove(id))),
      done,
    ),
  "channels.history": (input) =>
    decode(Schema.Struct({ channelId: Schema.String }))(input).pipe(
      Effect.flatMap(({ channelId }) => Channels.use((c) => c.history(channelId))),
    ),
  "channels.send": (input) =>
    decode(
      Schema.Struct({
        channelId: Schema.String,
        text: Schema.String,
        replyTo: Schema.optionalKey(Schema.NullOr(Schema.String)),
      }),
    )(input).pipe(
      Effect.flatMap(({ channelId, text, replyTo }) =>
        Channels.use((c) => c.send(channelId, text, replyTo)),
      ),
    ),
  "channels.assign": (input) =>
    decode(
      Schema.Struct({ channelId: Schema.String, messageId: Schema.String, agentId: Schema.String }),
    )(input).pipe(
      Effect.flatMap(({ channelId, messageId, agentId }) =>
        Channels.use((c) => c.assign(channelId, messageId, agentId)),
      ),
      done,
    ),
  "channels.stop": (input) =>
    decode(Schema.Struct({ channelId: Schema.String }))(input).pipe(
      Effect.flatMap(({ channelId }) => Channels.use((c) => c.stopAll(channelId))),
      done,
    ),
  "channels.activity": (input) =>
    decode(Schema.Struct({ channelId: Schema.String }))(input).pipe(
      Effect.flatMap(({ channelId }) => Channels.use((c) => c.activity(channelId))),
    ),
  "channels.markRead": (input) =>
    decode(Schema.Struct({ channelId: Schema.String }))(input).pipe(
      Effect.flatMap(({ channelId }) => Channels.use((c) => c.markRead(channelId))),
      done,
    ),
  // The handbook of a server (spec 002). The window of this computer saves with the source "page".
  "handbook.get": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Handbook.use((h) => h.get(serverId))),
    ),
  "handbook.history": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Handbook.use((h) => h.history(serverId))),
    ),
  "handbook.save": (input) =>
    decode(
      Schema.Struct({
        serverId: Schema.String,
        text: Schema.String.check(Schema.isMaxLength(200_000)),
      }),
    )(input).pipe(
      Effect.flatMap(({ serverId, text }) => Handbook.use((h) => h.save(serverId, text, "page"))),
    ),
  "handbook.restore": (input) =>
    decode(Schema.Struct({ serverId: Schema.String, versionId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId, versionId }) =>
        Handbook.use((h) => h.restore(serverId, versionId)),
      ),
    ),
  "memory.list": (input) =>
    decode(
      Schema.Struct({
        agentId: Schema.String,
        query: Schema.optionalKey(Schema.String),
        filter: Schema.optionalKey(MemoryFilterSchema),
      }),
    )(input).pipe(
      Effect.flatMap(({ agentId, query, filter }) =>
        Memory.use((m) => m.list(agentId, query, filter)),
      ),
    ),
  "memory.scopes": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => Memory.use((m) => m.scopes(agentId))),
    ),
  "memory.move": (input) =>
    decode(Schema.Struct({ id: Schema.String, channelId: Schema.NullOr(Schema.String) }))(
      input,
    ).pipe(Effect.flatMap(({ id, channelId }) => Memory.use((m) => m.move(id, channelId)))),
  // Only the window of this computer clears a mark: the method is not on the list of a linked
  // device, so the phone and a linked computer get "not allowed" (spec 007, 012).
  "placeMarks.clear": (input) =>
    decode(
      Schema.Struct({
        place: Schema.Struct({
          kind: Schema.Literals(["agent", "channel", "thread"]),
          id: Schema.String,
        }),
      }),
    )(input).pipe(
      Effect.flatMap(({ place }) => PlaceMarks.use((m) => Effect.sync(() => m.clear(place)))),
    ),
  "actionLog.list": (input) =>
    decode(
      Schema.Struct({
        agentId: Schema.optionalKey(Schema.String),
        result: Schema.optionalKey(Schema.Literals(["ran", "failed", "refused", "stopped"])),
        kind: Schema.optionalKey(Schema.Literals(ACTION_KINDS)),
        search: Schema.optionalKey(Schema.String),
      }),
    )(input).pipe(Effect.flatMap((filter) => ActionLog.use((log) => log.list(filter)))),
  "rules.list": (input) =>
    decode(
      Schema.Struct({
        agentId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        decision: Schema.optionalKey(Schema.Literals(["allow", "deny"])),
      }),
    )(input).pipe(Effect.flatMap((filter) => Rules.use((r) => r.list(filter)))),
  "rules.add": (input) =>
    decode(RuleInputSchema)(input).pipe(Effect.flatMap((rule) => Rules.use((r) => r.add(rule)))),
  "rules.update": (input) =>
    decode(Schema.Struct({ id: Schema.String, rule: RuleInputSchema }))(input).pipe(
      Effect.flatMap(({ id, rule }) => Rules.use((r) => r.update(id, rule))),
    ),
  "rules.delete": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Rules.use((r) => r.remove(id))),
      done,
    ),
  "connections.list": () => Connections.use((c) => c.list),
  "connections.save": (input) =>
    decode(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        connection: ConnectionInputSchema,
        confirmed: Schema.Boolean,
      }),
    )(input).pipe(Effect.flatMap((saved) => Connections.use((c) => c.save(saved)))),
  "connections.test": (input) =>
    decode(
      Schema.Struct({
        id: Schema.optionalKey(Schema.String),
        connection: Schema.optionalKey(ConnectionInputSchema),
      }),
    )(input).pipe(Effect.flatMap((form) => Connections.use((c) => c.test(form)))),
  "connections.setEnabled": (input) =>
    decode(Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ id, enabled }) => Connections.use((c) => c.setEnabled(id, enabled))),
    ),
  "connections.setTool": (input) =>
    decode(
      Schema.Struct({
        id: Schema.String,
        tool: Schema.String.check(Schema.isMaxLength(1000)),
        enabled: Schema.Boolean,
      }),
    )(input).pipe(
      Effect.flatMap(({ id, tool, enabled }) =>
        Connections.use((c) => c.setTool(id, tool, enabled)),
      ),
    ),
  "connections.setTrust": (input) =>
    decode(Schema.Struct({ id: Schema.String, trust: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ id, trust }) => Connections.use((c) => c.setTrust(id, trust))),
    ),
  "connections.held": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Connections.use((c) => c.held(id)))),
  "connections.accept": (input) =>
    decode(
      Schema.Struct({
        id: Schema.String,
        tools: Schema.Array(
          Schema.Struct({
            name: Schema.String.check(Schema.isMaxLength(1000)),
            key: Schema.String.check(Schema.isMaxLength(100)),
          }),
        ).check(Schema.isMaxLength(CONNECTION_TOOLS_MAX)),
      }),
    )(input).pipe(Effect.flatMap(({ id, tools }) => Connections.use((c) => c.accept(id, tools)))),
  "connections.delete": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Connections.use((c) => c.remove(id))),
      done,
    ),
  "secrets.list": (input) =>
    decode(Schema.Struct({ agentId: Schema.optionalKey(Schema.String) }))(input).pipe(
      Effect.flatMap(({ agentId }) => SavedSecrets.use((s) => Effect.sync(() => s.list(agentId)))),
    ),
  // The value of a secret goes from the window to the keychain only (spec 020).
  "secrets.answer": (input) =>
    decode(
      Schema.Struct({
        agentId: Schema.String,
        callId: Schema.String,
        value: Schema.NullOr(Schema.String),
      }),
    )(input).pipe(
      Effect.flatMap(({ agentId, callId, value }) =>
        Tools.use((t) => t.answerSecret(agentId, callId, value)),
      ),
      done,
    ),
  "secrets.replace": (input) =>
    decode(Schema.Struct({ id: Schema.String, value: Schema.String }))(input).pipe(
      Effect.flatMap(({ id, value }) =>
        SavedSecrets.use((s) =>
          Effect.try({
            try: () => s.replace(id, value),
            catch: (e) => (e instanceof AppError ? e : new AppError({ code: "secret_keychain" })),
          }),
        ),
      ),
    ),
  // The key of the decision model goes from the window to the keychain only (spec 013). The page
  // learns whether a key is saved, never the key.
  "decision.status": () => Decision.use((d) => d.status),
  "decision.keys": (input) =>
    decode(DecisionKeys)(input).pipe(Effect.flatMap((keys) => Decision.use((d) => d.keys(keys)))),
  "decision.test": () => Decision.use((d) => d.test),
  "secrets.delete": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => SavedSecrets.use((s) => Effect.sync(() => s.remove(id)))),
      done,
    ),
  "memory.add": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, text: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, text }) => Memory.use((m) => m.add(agentId, text, "user"))),
    ),
  "memory.update": (input) =>
    decode(Schema.Struct({ id: Schema.String, text: Schema.String }))(input).pipe(
      Effect.flatMap(({ id, text }) => Memory.use((m) => m.update(id, text))),
    ),
  "memory.delete": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Memory.use((m) => m.remove(id))),
      done,
    ),
  "memory.mode": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => Memory.use((m) => m.mode(agentId))),
    ),
  "memory.setMode": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, mode: Schema.Literals(MEMORY_MODES) }))(
      input,
    ).pipe(
      Effect.flatMap(({ agentId, mode }) => Memory.use((m) => m.setMode(agentId, mode))),
      done,
    ),
  "memory.check": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => MemoryCheck.use((m) => m.info(agentId))),
    ),
  "memory.check.set": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, on: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ agentId, on }) => MemoryCheck.use((m) => m.setOn(agentId, on))),
      done,
    ),
  "memory.check.now": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => MemoryCheck.use((m) => m.checkNow(agentId))),
      done,
    ),
  "memory.proposals": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => Memory.use((m) => m.proposals(agentId))),
    ),
  "memory.proposal.accept": (input) =>
    decode(Schema.Struct({ id: Schema.String, text: Schema.optionalKey(Schema.String) }))(
      input,
    ).pipe(Effect.flatMap(({ id, text }) => Memory.use((m) => m.accept(id, text)))),
  "memory.proposal.dismiss": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Memory.use((m) => m.dismiss(id))),
      done,
    ),
  "memory.history": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => Memory.use((m) => m.history(agentId))),
    ),
  "memory.history.get": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Memory.use((m) => m.historyRow(id)))),
  "memory.undo": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Memory.use((m) => m.undo(id))),
      done,
    ),
  "knowledge.list": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, query: Schema.optionalKey(Schema.String) }))(
      input,
    ).pipe(Effect.flatMap(({ agentId, query }) => Knowledge.use((k) => k.list(agentId, query)))),
  "knowledge.get": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, file: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, file }) => Knowledge.use((k) => k.get(agentId, file))),
    ),
  "knowledge.save": (input) =>
    decode(
      Schema.Struct({
        agentId: Schema.String,
        file: Schema.NullOr(Schema.String),
        title: Schema.String,
        summary: Schema.String,
        body: Schema.String,
      }),
    )(input).pipe(
      Effect.flatMap(({ agentId, ...article }) => Knowledge.use((k) => k.save(agentId, article))),
    ),
  "knowledge.delete": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, file: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, file }) => Knowledge.use((k) => k.remove(agentId, file))),
      done,
    ),
  "knowledge.deleteSource": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, name: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, name }) => Knowledge.use((k) => k.removeSource(agentId, name))),
      done,
    ),
  "knowledge.openSource": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, name: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, name }) =>
        Effect.gen(function* () {
          const path = yield* Knowledge.use((k) => k.sourcePath(agentId, name))
          yield* Platform.use((p) => Effect.promise(() => p.openPath(path)))
        }),
      ),
      done,
    ),
  "knowledge.openFolder": (input) =>
    decode(ByAgent)(input).pipe(
      Effect.flatMap(({ agentId }) =>
        Effect.gen(function* () {
          const folder = yield* Knowledge.use((k) => k.folder(agentId))
          // The folder can exist for a source before the first article is saved. It stays shut then.
          if (!folder.saved) return yield* new AppError({ code: "knowledge_not_found" })
          yield* Platform.use((p) => Effect.promise(() => p.openPath(folder.path)))
        }),
      ),
      done,
    ),
  "knowledge.changes": (input) =>
    decode(ByAgent)(input).pipe(
      Effect.flatMap(({ agentId }) => Knowledge.use((k) => k.changes(agentId))),
    ),
  "knowledge.change": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, changeId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, changeId }) => Knowledge.use((k) => k.change(agentId, changeId))),
    ),
  "knowledge.undo": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, changeId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, changeId }) => Knowledge.use((k) => k.undo(agentId, changeId))),
      done,
    ),
  "knowledge.findings": (input) =>
    decode(ByAgent)(input).pipe(
      Effect.flatMap(({ agentId }) => Knowledge.use((k) => k.findings(agentId))),
    ),
  "tools.respond": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, callId: Schema.String, answer: Schema.String }))(
      input,
    ).pipe(
      Effect.flatMap(({ agentId, callId, answer }) => answerCard(agentId, callId, answer)),
      done,
    ),
  "keepAwake.state": () => KeepAwake.use((k) => k.state),
  "browser.state": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) =>
        Tools.use((t) =>
          Effect.succeed({ ...t.browserState(agentId), suggest: t.browserSuggestion(agentId) }),
        ),
      ),
    ),
  "browser.dismissSuggest": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) =>
        Tools.use((t) => Effect.sync(() => t.dismissBrowserSuggestion(agentId))),
      ),
      done,
    ),
  "browser.control": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, control: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ agentId, control }) =>
        Tools.use((t) => Effect.sync(() => t.setBrowserControl(agentId, control))),
      ),
      done,
    ),
  "browser.close": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => Tools.use((t) => Effect.sync(() => t.closeBrowser(agentId)))),
      done,
    ),
  "browser.place": (input) =>
    decode(
      Schema.Struct({
        agentId: Schema.String,
        bounds: Schema.NullOr(
          Schema.Struct({
            x: Schema.Number,
            y: Schema.Number,
            width: Schema.Number,
            height: Schema.Number,
          }),
        ),
      }),
    )(input).pipe(
      Effect.flatMap(({ agentId, bounds }) =>
        Tools.use((t) => Effect.sync(() => t.placeBrowser(agentId, bounds ?? undefined))),
      ),
      done,
    ),
  "teach.state": () => Teach.use((t) => t.state),
  "teach.start": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, result: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, result }) => Teach.use((t) => t.start(agentId, result))),
    ),
  "teach.open": (input) =>
    decode(Schema.Struct({ url: Schema.String.check(Schema.isMaxLength(4000)) }))(input).pipe(
      Effect.flatMap(({ url }) => Teach.use((t) => t.open(url))),
      done,
    ),
  "teach.pause": (input) =>
    decode(Schema.Struct({ paused: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ paused }) => Teach.use((t) => t.pause(paused))),
      done,
    ),
  "teach.stop": () => Teach.use((t) => t.stop),
  "teach.cancel": () => Teach.use((t) => t.cancel).pipe(done),
  "teach.retry": () => Teach.use((t) => t.retry).pipe(done),
  "teach.save": (input) =>
    decode(
      Schema.Struct({
        name: Schema.String.check(Schema.isMaxLength(1000)),
        description: Schema.String.check(Schema.isMaxLength(10_000)),
        instructions: Schema.String.check(Schema.isMaxLength(100_000)),
      }),
    )(input).pipe(Effect.flatMap((draft) => Teach.use((t) => t.save(draft)))),
  "teach.discard": () => Teach.use((t) => t.discard).pipe(done),
  "skills.list": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Skills.use((s) => s.list(serverId))),
    ),
  "skills.forAgent": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => Skills.use((s) => s.forAgent(agentId))),
    ),
  "skills.onlyFor": (input) =>
    decode(Schema.Struct({ agentId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId }) => Skills.use((s) => s.onlyFor(agentId))),
      Effect.map((count) => ({ count })),
    ),
  "skills.create": (input) =>
    decode(
      Schema.Struct({
        serverId: Schema.String,
        name: Schema.String.check(Schema.isMaxLength(1000)),
        description: Schema.String.check(Schema.isMaxLength(10_000)),
        instructions: Schema.String.check(Schema.isMaxLength(100_000)),
        agentIds: Schema.NullOr(Schema.Array(Schema.String).check(Schema.isMaxLength(1000))),
        channelIds: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(1000))),
      }),
    )(input).pipe(
      Effect.flatMap(({ serverId, agentIds, channelIds, ...skill }) =>
        Skills.use((s) => s.create(serverId, skill, agentIds, channelIds)),
      ),
    ),
  "skills.update": (input) =>
    decode(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String.check(Schema.isMaxLength(1000)),
        description: Schema.String.check(Schema.isMaxLength(10_000)),
        instructions: Schema.String.check(Schema.isMaxLength(100_000)),
        agentIds: Schema.NullOr(Schema.Array(Schema.String).check(Schema.isMaxLength(1000))),
        channelIds: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(1000))),
      }),
    )(input).pipe(
      Effect.flatMap(({ id, agentIds, channelIds, ...skill }) =>
        Skills.use((s) => s.update(id, skill, agentIds, channelIds)),
      ),
    ),
  "skills.duplicate": (input) =>
    decode(
      Schema.Struct({ id: Schema.String, suffix: Schema.String.check(Schema.isMaxLength(20)) }),
    )(input).pipe(Effect.flatMap(({ id, suffix }) => Skills.use((s) => s.duplicate(id, suffix)))),
  "skills.setEnabled": (input) =>
    decode(Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ id, enabled }) => Skills.use((s) => s.setEnabled(id, enabled))),
    ),
  "skills.delete": (input) =>
    decode(Schema.Struct({ id: Schema.String }))(input).pipe(
      Effect.flatMap(({ id }) => Skills.use((s) => s.remove(id))),
      done,
    ),
  "skills.draft": (input) =>
    decode(
      Schema.Struct({
        requestId: Schema.String.check(Schema.isMaxLength(100)),
        source: Schema.Union([
          Schema.Struct({ kind: Schema.Literal("task"), id: Schema.String }),
          Schema.Struct({
            kind: Schema.Literal("article"),
            agentId: Schema.String,
            file: Schema.String.check(Schema.isMaxLength(1000)),
          }),
          Schema.Struct({ kind: Schema.Literal("memory"), id: Schema.String }),
        ]),
      }),
    )(input).pipe(
      Effect.flatMap(({ requestId, source }) => SkillDrafts.use((d) => d.draft(requestId, source))),
    ),
  "skills.draftCancel": (input) =>
    decode(Schema.Struct({ requestId: Schema.String }))(input).pipe(
      Effect.flatMap(({ requestId }) => SkillDrafts.use((d) => d.cancel(requestId))),
      done,
    ),
  "routines.list": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Routines.use((r) => r.list(serverId))),
    ),
  "routines.create": (input) =>
    decode(RoutineInput)(input).pipe(Effect.flatMap((v) => Routines.use((r) => r.create(v)))),
  "routines.update": (input) =>
    decode(Schema.Struct({ id: Schema.String, patch: RoutinePatch }))(input).pipe(
      Effect.flatMap(({ id, patch }) => Routines.use((r) => r.update(id, patch))),
    ),
  "routines.delete": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Routines.use((r) => r.remove(id))),
      done,
    ),
  "routines.runNow": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Routines.use((r) => r.runNow(id))),
      done,
    ),
  "routines.runHere": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Routines.use((r) => r.runHere(id)))),
  "routines.calendar": (input) =>
    decode(Schema.Struct({ serverId: Schema.String, from: Schema.Number, to: Schema.Number }))(
      input,
    ).pipe(
      Effect.flatMap(({ serverId, from, to }) =>
        Routines.use((r) => r.calendar(serverId, from, to)),
      ),
    ),
  "workflows.list": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Workflows.use((w) => w.list(serverId))),
    ),
  "workflows.create": (input) =>
    decode(WorkflowInput)(input).pipe(Effect.flatMap((v) => Workflows.use((w) => w.create(v)))),
  "workflows.update": (input) =>
    decode(Schema.Struct({ id: Schema.String, patch: WorkflowPatch }))(input).pipe(
      Effect.flatMap(({ id, patch }) => Workflows.use((w) => w.update(id, patch))),
    ),
  "workflows.delete": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Workflows.use((w) => w.remove(id))),
      done,
    ),
  "workflows.run": (input) =>
    decode(Schema.Struct({ id: Schema.String, triggerText: Schema.optionalKey(Schema.String) }))(
      input,
    ).pipe(Effect.flatMap(({ id, triggerText }) => Workflows.use((w) => w.run(id, triggerText)))),
  "workflows.runHere": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Workflows.use((w) => w.runHere(id)))),
  "workflows.stop": (input) =>
    decode(Schema.Struct({ runId: Schema.String }))(input).pipe(
      Effect.flatMap(({ runId }) => Workflows.use((w) => w.stop(runId))),
      done,
    ),
  "workflows.approve": (input) =>
    decode(
      Schema.Struct({ runId: Schema.String, stepId: Schema.String, approved: Schema.Boolean }),
    )(input).pipe(
      Effect.flatMap(({ runId, stepId, approved }) =>
        Workflows.use((w) => w.approve(runId, stepId, approved)),
      ),
      done,
    ),
  "workflows.runs": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) => Workflows.use((w) => w.runs(workflowId))),
    ),
  "workflows.runDetail": (input) =>
    decode(Schema.Struct({ runId: Schema.String }))(input).pipe(
      Effect.flatMap(({ runId }) => Workflows.use((w) => w.runDetail(runId))),
    ),
  "workflowFile.export": (input) =>
    decode(Schema.Struct({ serverId: Schema.String, workflowIds: Schema.Array(Schema.String) }))(
      input,
    ).pipe(Effect.flatMap((data) => WorkflowFiles.use((f) => f.export(data)))),
  "workflowFile.exportCc": (input) =>
    decode(Schema.Struct({ serverId: Schema.String, workflowId: Schema.String }))(input).pipe(
      Effect.flatMap((data) => WorkflowFiles.use((f) => f.exportCc(data))),
    ),
  "workflowFile.open": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => WorkflowFiles.use((f) => f.open(serverId))),
    ),
  "workflowFile.apply": (input) =>
    decode(
      Schema.Struct({
        serverId: Schema.String,
        pick: Schema.Array(Schema.Int),
        agentId: Schema.optionalKey(Schema.String),
      }),
    )(input).pipe(Effect.flatMap((data) => WorkflowFiles.use((f) => f.import(data)))),
  "notifications.mutes": () => Notifier.use((n) => Effect.succeed(n.mutes())),
  "notifications.setMute": (input) =>
    decode(
      Schema.Struct({
        kind: Schema.Literals(["server", "channel"]),
        id: Schema.String,
        choice: Schema.Literals(MUTE_CHOICES),
      }),
    )(input).pipe(
      Effect.flatMap(({ kind, id, choice }) => Notifier.use((n) => n.setMute(kind, id, choice))),
      done,
    ),
  "island.get": () => Notifier.use((n) => Effect.succeed(n.island())),
  "quiet.list": () => Activity.use((a) => Effect.sync(() => a.quietTurns())),
  "island.respond": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, callId: Schema.String, answer: Schema.String }))(
      input,
    ).pipe(
      // The island takes "Always allow" only for a request that offers it. Else it is one "Allow".
      Effect.flatMap(({ agentId, callId, answer }) =>
        Notifier.use((n) =>
          Effect.succeed(answer === "always" && !n.canAlways(agentId, callId) ? "allow" : answer),
        ).pipe(Effect.flatMap((safe) => answerCard(agentId, callId, safe))),
      ),
      done,
    ),
  "island.openApp": (input) =>
    decode(
      Schema.Struct({
        target: Schema.Struct({
          kind: Schema.Literals(["agent", "channel"]),
          id: Schema.String,
          messageId: Schema.optionalKey(Schema.String),
        }),
      }),
    )(input).pipe(
      Effect.flatMap(({ target }) =>
        Effect.gen(function* () {
          const platform = yield* Platform
          const bus = yield* EventBus
          platform.showWindow()
          // The window gets the place from the same event as a notification click.
          bus.emit("app.openPlace", target)
        }),
      ),
      done,
    ),
  "island.dismissResult": (input) =>
    decode(Schema.Struct({ id: Schema.Number }))(input).pipe(
      Effect.flatMap(({ id }) => Notifier.use((n) => Effect.sync(() => n.dismissResult(id)))),
      done,
    ),
  "island.fit": (input) =>
    decode(Schema.Struct({ width: Schema.Number, height: Schema.Number }))(input).pipe(
      Effect.flatMap((size) => Platform.use((p) => Effect.sync(() => p.fitIsland(size)))),
      done,
    ),
  "today.get": () => Today.use((t) => t.snapshot()),
  "orgChart.get": () => OrgChart.use((o) => o.snapshot()),
  // The ready model for a linked computer and the phone (spec 029, 012). A device with only the
  // link may ask. It names this server; any other id, or any other field, is refused.
  "orgChart.model": (input) =>
    strict(Schema.Struct({ serverId: Id }))(input).pipe(
      Effect.flatMap(({ serverId }) => ownServer(serverId)),
      Effect.flatMap(() => OrgChart.use((o) => o.model())),
    ),
  // The tools of a channel and its daily token limit (spec 030). A linked device reads the first
  // three with the link only; its input is checked as strictly as any request of a client.
  "channelTools.list": (input) =>
    strict(Schema.Struct({ channelId: Id }))(input).pipe(
      Effect.flatMap(({ channelId }) => ChannelTools.use((c) => c.forChannel(channelId))),
    ),
  "channelTools.set": (input) =>
    decode(
      Schema.Struct({
        channelId: Schema.String,
        kind: Schema.Literals(["skill", "connection"]),
        id: Schema.String,
        on: Schema.Boolean,
      }),
    )(input).pipe(
      Effect.flatMap(({ channelId, kind, id, on }) =>
        ChannelTools.use((c) => c.set(channelId, kind, id, on)),
      ),
    ),
  "channelTools.forAgent": (input) =>
    strict(Schema.Struct({ agentId: Id }))(input).pipe(
      Effect.flatMap(({ agentId }) => ChannelTools.use((c) => c.forAgent(agentId))),
    ),
  "channels.limit": (input) =>
    strict(Schema.Struct({ channelId: Id }))(input).pipe(
      Effect.flatMap(({ channelId }) => ChannelTools.use((c) => c.limit(channelId))),
    ),
  "usage.channels": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => ChannelTools.use((c) => c.usage(serverId))),
    ),
  // The part "Organization" (spec 013, 030). A linked computer reads it with only the link, and no
  // request of a client changes it (spec 012): "organization.setHandOff" and
  // "organization.setAskUpTheLine" are not client methods.
  "organization.get": (input) =>
    strict(Schema.Struct({ serverId: Id }))(input).pipe(
      Effect.flatMap(({ serverId }) => ownServer(serverId)),
      Effect.flatMap(() => Organization.use((o) => o.get)),
    ),
  "organization.setHandOff": (input) =>
    decode(Schema.Struct({ rule: Schema.Literals(HAND_OFF_RULES) }))(input).pipe(
      Effect.flatMap(({ rule }) => Organization.use((o) => o.setHandOff(rule))),
    ),
  "organization.setAskUpTheLine": (input) =>
    decode(Schema.Struct({ on: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ on }) => Organization.use((o) => o.setAskUpTheLine(on))),
    ),
  "usage.summary": (input) =>
    decode(
      Schema.Struct({
        serverId: Schema.String,
        days: Schema.Literals(USAGE_RANGES),
      }),
    )(input).pipe(
      Effect.flatMap(({ serverId, days }) => Usage.use((u) => u.summary(serverId, days))),
    ),
  "messages.search": (input) =>
    decode(
      Schema.Struct({
        serverId: Schema.String,
        query: Schema.String.check(Schema.isMaxLength(SEARCH_QUERY_MAX)),
        offset: Schema.optionalKey(
          Schema.Number.check(
            Schema.isInt(),
            Schema.isBetween({ minimum: 0, maximum: SEARCH_CAP }),
          ),
        ),
      }),
    )(input).pipe(
      Effect.flatMap(({ serverId, query, offset }) =>
        // A linked device finds the main thread only (spec 003, 001).
        CurrentActor.pipe(
          Effect.flatMap((actor) =>
            Search.use((s) => s.page(serverId, query, offset ?? 0, actor !== null)),
          ),
        ),
      ),
    ),
  "chat.history": (input) =>
    decode(ByThread)(input).pipe(
      Effect.flatMap(({ agentId, threadId }) => Chat.use((c) => c.history(agentId, threadId))),
    ),
  "chat.send": (input) =>
    decode(ChatSend)(input).pipe(Effect.flatMap((data) => Chat.use((c) => c.send(data)))),
  "chat.stop": (input) =>
    decode(ByThread)(input).pipe(
      Effect.flatMap(({ agentId, threadId }) =>
        // A reply that runs on the other computer of a sync pair is stopped there (spec 019).
        Chat.use((c) => c.stop(agentId, threadId)).pipe(
          Effect.andThen(threadId ? Effect.void : Tasks.use((t) => t.stopRemoteFor(agentId))),
        ),
      ),
      done,
    ),
  "chat.retry": (input) =>
    decode(
      Schema.Struct({
        agentId: Schema.String,
        messageId: Schema.String,
        confirmed: Schema.optionalKey(Schema.Boolean),
      }),
    )(input).pipe(
      Effect.flatMap(({ agentId, messageId, confirmed }) =>
        retryOptions(confirmed).pipe(
          Effect.flatMap((o) => Chat.use((c) => c.retry(agentId, messageId, o))),
        ),
      ),
    ),
  "chat.edit": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, messageId: Schema.String, text: MessageText }))(
      input,
    ).pipe(
      Effect.flatMap(({ agentId, messageId, text }) =>
        Chat.use((c) => c.edit(agentId, messageId, text)),
      ),
      done,
    ),
  "chat.queue.update": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, itemId: Schema.String, text: MessageText }))(
      input,
    ).pipe(
      Effect.flatMap(({ agentId, itemId, text }) =>
        Chat.use((c) => c.updateQueued(agentId, itemId, text)),
      ),
      done,
    ),
  "chat.queue.remove": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, itemId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, itemId }) => Chat.use((c) => c.removeQueued(agentId, itemId))),
      done,
    ),
  "chat.queue.sendNow": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, itemId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, itemId }) => Chat.use((c) => c.sendNow(agentId, itemId))),
      done,
    ),
  "chat.unread.delete": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, messageId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, messageId }) =>
        Chat.use((c) => c.deleteUnread(agentId, messageId)),
      ),
      done,
    ),
  "chat.markRead": (input) =>
    decode(ByThread)(input).pipe(
      Effect.flatMap(({ agentId, threadId }) => Chat.use((c) => c.markRead(agentId, threadId))),
      done,
    ),
  "chat.meter": (input) =>
    decode(ByThread)(input).pipe(Effect.flatMap((i) => Chat.use((c) => c.meter(placeOf(i))))),
  "chat.compact": (input) =>
    decode(ByThread)(input).pipe(
      Effect.flatMap((i) => Chat.use((c) => c.compact(placeOf(i)))),
      done,
    ),
  "chat.threads": (input) =>
    decode(ByAgent)(input).pipe(
      Effect.flatMap(({ agentId }) => Chat.use((c) => c.threads(agentId))),
    ),
  "chat.thread.create": (input) =>
    decode(ByAgent)(input).pipe(
      Effect.flatMap(({ agentId }) => Chat.use((c) => c.createThread(agentId))),
    ),
  "chat.thread.fork": (input) =>
    decode(Schema.Struct({ ...ByThread.fields, messageId: Schema.String }))(input).pipe(
      Effect.flatMap((i) => Chat.use((c) => c.fork(placeOf(i), i.messageId))),
    ),
  "chat.thread.rename": (input) =>
    decode(
      Schema.Struct({
        agentId: Schema.String,
        threadId: Schema.String,
        title: Schema.String.check(Schema.isMaxLength(1000)),
      }),
    )(input).pipe(
      Effect.flatMap(({ agentId, threadId, title }) =>
        Chat.use((c) => c.renameThread(agentId, threadId, title)),
      ),
      done,
    ),
  "chat.thread.archive": (input) =>
    decode(
      Schema.Struct({ agentId: Schema.String, threadId: Schema.String, archived: Schema.Boolean }),
    )(input).pipe(
      Effect.flatMap(({ agentId, threadId, archived }) =>
        Chat.use((c) => c.archiveThread(agentId, threadId, archived)),
      ),
      done,
    ),
  "chat.thread.delete": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, threadId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, threadId }) => Chat.use((c) => c.deleteThread(agentId, threadId))),
      done,
    ),
  // Hand over is for the window of this computer: these methods are not on the list of a linked
  // device, so the phone and a linked computer get "not allowed" (spec 003, 012).
  "chat.handover.state": (input) =>
    decode(ByThread)(input).pipe(Effect.flatMap((i) => Handover.use((h) => h.state(placeOf(i))))),
  "chat.handover.open": (input) =>
    decode(ByThread)(input).pipe(Effect.flatMap((i) => Handover.use((h) => h.open(placeOf(i))))),
  "chat.handover.start": (input) =>
    decode(
      Schema.Struct({
        ...ByThread.fields,
        toAgentId: Schema.String,
        text: Schema.String.check(Schema.isMaxLength(10_000)),
        briefId: Schema.String,
      }),
    )(input).pipe(
      Effect.flatMap((i) =>
        Handover.use((h) =>
          h.start({
            place: placeOf(i),
            toAgentId: i.toAgentId,
            text: i.text,
            briefId: i.briefId,
          }),
        ),
      ),
    ),
}

/** True when the input names a thread other than the main thread. */
const otherThread = (input: unknown) =>
  typeof input === "object" &&
  input !== null &&
  "threadId" in input &&
  (input as { threadId?: unknown }).threadId !== null &&
  (input as { threadId?: unknown }).threadId !== undefined

/** Runs one request and turns every outcome into plain data. */
export const runRequest = async (
  runtime: ManagedRuntime.ManagedRuntime<Services, never>,
  method: string,
  input: unknown,
  actor: Actor | null = null,
): Promise<RpcResult<unknown>> => {
  // A linked device reaches only what the link lists (spec 012). This holds also when a caller of
  // this function forgets to check, so a method that is not listed never gets to a window handler.
  if (actor && !isClientMethod(method)) {
    return { ok: false, error: { code: "not_allowed", message: "Not allowed" } }
  }
  if (isHostMethod(method)) {
    return runtime.runPromise(Host.use((h) => Effect.promise(() => h.call(method, input, actor))))
  }
  // A linked device has the main thread only in this version (spec 011, 012).
  if (actor && method.startsWith("chat.") && otherThread(input)) {
    return { ok: false, error: { code: "not_allowed", message: "Not allowed" } }
  }
  const handler =
    (actor ? linkHandlers[method] : undefined) ??
    (handlers as Record<string, Handler<RpcMethod> | undefined>)[method]
  if (!handler) return { ok: false, error: { code: "unknown_method", message: method } }
  // The device that asks is known to the handlers: they record "from <device>" with it.
  // A linked device names its files by the tokens of its uploads, never by a path.
  const run =
    actor && method === "chat.send"
      ? withUploads(actor, input, (mapped) => handler(mapped as never))
      : handler(input as never)
  const exit = await runtime.runPromiseExit(Effect.provideService(run, CurrentActor, actor))
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
  const failure = exit.cause.reasons.find(Cause.isFailReason)
  if (failure) {
    const error = failure.error
    return { ok: false, error: { code: error.code, message: error.detail ?? error.code } }
  }
  console.error(`request ${method} failed`, redactSecrets(Cause.pretty(exit.cause)))
  return { ok: false, error: { code: "internal", message: "Unexpected error" } }
}

/**
 * Lets requests of linked devices run the same handlers, with the device as the actor. The app and
 * the unit tests both call this when they make their runtime.
 */
export const bindLinkDispatcher = (runtime: ManagedRuntime.ManagedRuntime<Services, never>) =>
  runtime.runPromise(
    Devices.use((d) =>
      Effect.sync(() =>
        d.bindDispatcher((method, input, actor) => runRequest(runtime, method, input, actor)),
      ),
    ),
  )

/**
 * A call of the window. A call for a linked server goes over the link; when the id is not a linked
 * server (it is this computer), the call runs here.
 */
export const runWindowRequest = async (
  runtime: ManagedRuntime.ManagedRuntime<Services, never>,
  method: string,
  input: unknown,
  server?: string,
): Promise<RpcResult<unknown>> => {
  if (server && typeof server === "string") {
    const remote = await runtime.runPromise(
      Remote.use((r) => Effect.promise(() => r.invoke(server, method, input))),
    )
    if (remote.ok || remote.error.code !== "server_not_found") return remote
  }
  return runRequest(runtime, method, input)
}
