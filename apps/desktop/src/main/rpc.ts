import {
  ACTION_KINDS,
  APPROVAL_COMMENT_MAX,
  BrowserProfileCreate,
  CHAT_MESSAGE_MAX,
  CONNECTION_SCOPE_MAX,
  CONNECTION_TOOLS_MAX,
  ConnectionSource,
  DEVICE_NAME_MAX,
  DecisionKeys,
  isChangeMethod,
  isClientMethod,
  type ModelChoice,
  NodeInput,
  NodePatch,
  PERMISSION_LEVELS,
  ProviderConnect,
  type RpcInput,
  type RpcMethod,
  type RpcOutput,
  type RpcResult,
  RUN_SOURCES,
  RUNTIME_KINDS,
  redactSecrets,
  SettingsPatch,
  SIGN_IN_ID,
  TASK_STATES,
  UiStatePatch,
  type Workflow,
  WorkflowChatSend,
  WorkflowCreate,
} from "@robot/shared"
import { Cause, Effect, Exit, type ManagedRuntime, Schema } from "effect"
import type { AppServices } from "./layers.ts"
import { chatMayUse } from "./runtimes/driver.ts"
import { ActionLog } from "./services/ActionLog.ts"
import type { Actor } from "./services/actor.ts"
import { CurrentActor } from "./services/actor.ts"
import { BrowserProfiles } from "./services/BrowserProfiles.ts"
import { Browsers } from "./services/Browsers.ts"
import { Cards } from "./services/Cards.ts"
import { Chat } from "./services/Chat.ts"
import { Connections } from "./services/Connections.ts"
import { Decision } from "./services/Decision.ts"
import { Devices } from "./services/Devices.ts"
import { AppError } from "./services/errors.ts"
import { backupOfferedBy } from "./services/graphModels.ts"
import { Host, type HostMethod, isHostMethod } from "./services/Host.ts"
import { Memory } from "./services/Memory.ts"
import { ModelHolds } from "./services/ModelHolds.ts"
import { Platform } from "./services/Platform.ts"
import { Proposals } from "./services/Proposals.ts"
import { Providers } from "./services/Providers.ts"
import { Rules } from "./services/Rules.ts"
import { Runs } from "./services/Runs.ts"
import { Runtimes } from "./services/Runtimes.ts"
import { SavedSecrets } from "./services/SavedSecrets.ts"
import { Servers } from "./services/Servers.ts"
import { SettingsStore } from "./services/Settings.ts"
import { Skills } from "./services/Skills.ts"
import { Tasks } from "./services/Tasks.ts"
import { UiStore } from "./services/UiStore.ts"
import { WorkflowCheck } from "./services/WorkflowCheck.ts"
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
  workflowId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["file", "shell", "web", "connection", "secret"]),
  text: Schema.String,
  detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  decision: Schema.Literals(["allow", "deny"]),
})
/** The workflows that may use a connection: all of them, or a list (spec 018). */
const ConnectionScopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("all") }),
  Schema.Struct({
    kind: Schema.Literal("workflows"),
    workflowIds: Schema.Array(Schema.String.check(Schema.isMaxLength(200))).check(
      Schema.isMaxLength(CONNECTION_SCOPE_MAX),
    ),
  }),
])
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
})
const ByAccount = Schema.Struct({ accountId: Schema.String })
const SignInId = Schema.String.check(Schema.isPattern(SIGN_IN_ID))
const ByRuntime = Schema.Struct({
  kind: Schema.Literals(RUNTIME_KINDS),
  signIn: Schema.optionalKey(Schema.NullOr(SignInId)),
})
const done = Effect.as(undefined)

/**
 * Only the window of this computer answers a proposal or a switch of self-improvement. A linked
 * device never does (spec 002, "Surfaces"; spec 012). The link has no such method, and this check
 * holds even when a caller forgets the list.
 */
/**
 * A linked device (012) and the phone (011) do not show proposals: the page and the cards stay on
 * the computer that holds them (spec 002, "Surfaces"). The count that the server sends to such a
 * device is 0, so the device shows no line "N proposals wait".
 */
const countForActor = <A extends { proposals: number }>(value: A) =>
  Effect.gen(function* () {
    const actor = yield* CurrentActor
    return actor ? { ...value, proposals: 0 } : value
  })

const ownerOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const actor = yield* CurrentActor
    if (actor) return yield* new AppError({ code: "not_allowed" })
    return yield* effect
  })

/** The connected accounts and their models, without any key. */
const modelChoices = Effect.gen(function* () {
  const providers = yield* Providers
  const accounts = yield* providers.list
  const out: ModelChoice[] = []
  for (const account of accounts) {
    if (!account.connected) continue
    const models = yield* providers.models(account.id).pipe(Effect.orElseSucceed(() => []))
    out.push({
      accountId: account.id,
      accountName: account.name,
      kind: account.kind,
      readOnly: yield* providers.readOnlySupported(account.id),
      chatSafe: chatMayUse(providers.runtimeKind(account.id)),
      models,
    })
  }
  return out
})

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
      // This computer shows under the name that linked devices see.
      return local.map((s) => (s.kind === "local" ? { ...s, name: devices.deviceName() } : s))
    }),
  "devices.get": () => Devices.use((d) => Effect.sync(() => d.state())),
  "devices.update": (input) =>
    decode(
      Schema.Struct({
        name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(DEVICE_NAME_MAX))),
        accept: Schema.optionalKey(Schema.Boolean),
      }),
    )(input).pipe(Effect.flatMap((patch) => Devices.use((d) => d.update(patch)))),
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
  "devices.nearby": () => Devices.use((d) => d.nearby()),
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
    decode(Schema.Struct({ workflowId: Schema.String, profileId: Schema.NullOr(Schema.String) }))(
      input,
    ).pipe(
      Effect.flatMap(({ workflowId, profileId }) =>
        BrowserProfiles.use((b) => b.assign(workflowId, profileId)),
      ),
      done,
    ),
  "browser.state": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) =>
        Browsers.use((b) => Effect.sync(() => b.state(workflowId))),
      ),
    ),
  "browser.place": (input) =>
    decode(
      Schema.Struct({
        workflowId: Schema.String,
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
      Effect.flatMap(({ workflowId, bounds }) =>
        Browsers.use((b) => Effect.sync(() => b.place(workflowId, bounds))),
      ),
      done,
    ),
  "ui.get": () => UiStore.use((s) => s.get),
  "ui.update": (input) =>
    decode(UiStatePatch)(input).pipe(
      Effect.flatMap((patch) => UiStore.use((s) => s.update(patch))),
    ),
  "models.available": () => modelChoices,
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
  "actionLog.list": (input) =>
    decode(
      Schema.Struct({
        workflowId: Schema.optionalKey(Schema.String),
        result: Schema.optionalKey(Schema.Literals(["ran", "failed", "refused", "stopped"])),
        kind: Schema.optionalKey(Schema.Literals(ACTION_KINDS)),
        search: Schema.optionalKey(Schema.String),
      }),
    )(input).pipe(Effect.flatMap((filter) => ActionLog.use((log) => log.list(filter)))),
  "rules.list": (input) =>
    decode(
      Schema.Struct({
        workflowId: Schema.optionalKey(Schema.NullOr(Schema.String)),
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
        scope: Schema.optionalKey(ConnectionScopeSchema),
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
    decode(Schema.Struct({ workflowId: Schema.optionalKey(Schema.String) }))(input).pipe(
      Effect.flatMap(({ workflowId }) =>
        SavedSecrets.use((s) => Effect.sync(() => s.list(workflowId))),
      ),
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
  "skills.list": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Skills.use((s) => s.list(serverId))),
    ),
  "skills.create": (input) =>
    decode(
      Schema.Struct({
        serverId: Schema.String,
        name: Schema.String.check(Schema.isMaxLength(1000)),
        description: Schema.String.check(Schema.isMaxLength(10_000)),
        instructions: Schema.String.check(Schema.isMaxLength(100_000)),
      }),
    )(input).pipe(
      Effect.flatMap(({ serverId, ...skill }) => Skills.use((s) => s.create(serverId, skill))),
    ),
  "skills.update": (input) =>
    decode(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String.check(Schema.isMaxLength(1000)),
        description: Schema.String.check(Schema.isMaxLength(10_000)),
        instructions: Schema.String.check(Schema.isMaxLength(100_000)),
      }),
    )(input).pipe(Effect.flatMap(({ id, ...skill }) => Skills.use((s) => s.update(id, skill)))),
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
  "workflows.list": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Workflows.use((w) => w.list(serverId))),
      Effect.flatMap((list) => Effect.forEach(list, (flow) => countForActor(flow))),
    ),
  "workflows.get": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Workflows.use((w) => w.get(id)))),
  "workflows.check": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => WorkflowCheck.use((c) => c.check(id, { force: true }))),
    ),
  "workflows.create": (input) =>
    decode(WorkflowCreate)(input).pipe(Effect.flatMap((v) => Workflows.use((w) => w.create(v)))),
  "workflows.rename": (input) =>
    decode(Schema.Struct({ id: Schema.String, name: Schema.String }))(input).pipe(
      Effect.flatMap(({ id, name }) => Workflows.use((w) => w.rename(id, name))),
    ),
  "workflows.document.save": (input) =>
    decode(
      Schema.Struct({
        id: Schema.String,
        text: Schema.String.check(Schema.isMaxLength(CHAT_MESSAGE_MAX)),
      }),
    )(input).pipe(
      Effect.flatMap(({ id, text }) =>
        Effect.gen(function* () {
          // The device that asks is named in the version (spec 002: "from <device>").
          const actor = yield* CurrentActor
          return yield* Workflows.use((w) => w.saveDocument(id, text, "editor", actor?.name))
        }),
      ),
    ),
  "workflows.document.history": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Workflows.use((w) => w.documentHistory(id))),
    ),
  "workflows.document.restore": (input) =>
    decode(Schema.Struct({ id: Schema.String, versionId: Schema.String }))(input).pipe(
      Effect.flatMap(({ id, versionId }) => Workflows.use((w) => w.restoreDocument(id, versionId))),
    ),
  "workflows.setPermission": (input) =>
    decode(Schema.Struct({ id: Schema.String, level: Schema.Literals(PERMISSION_LEVELS) }))(
      input,
    ).pipe(Effect.flatMap(({ id, level }) => Workflows.use((w) => w.setPermission(id, level)))),
  "workflows.setFolder": (input) =>
    decode(Schema.Struct({ id: Schema.String, folder: Schema.String }))(input).pipe(
      Effect.flatMap(({ id, folder }) => Workflows.use((w) => w.setFolder(id, folder))),
    ),
  "workflows.pickFolder": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) =>
        Effect.gen(function* () {
          const p = yield* Platform
          const current = yield* Workflows.use((w) => w.get(id))
          if (current.running) return yield* new AppError({ code: "workflow_running" })
          const picked = yield* Effect.promise(() => p.pickFolder(current.folder))
          return picked
            ? yield* Workflows.use((w) => w.setFolder(id, picked))
            : (current as Workflow)
        }),
      ),
    ),
  "workflows.node.add": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String, node: NodeInput }))(input).pipe(
      Effect.flatMap(({ workflowId, node }) => Workflows.use((w) => w.addNode(workflowId, node))),
    ),
  "workflows.node.update": (input) =>
    decode(Schema.Struct({ id: Schema.String, patch: NodePatch }))(input).pipe(
      Effect.flatMap(({ id, patch }) =>
        Effect.gen(function* () {
          // The backup model is a second account for the node: only the user at this computer sets
          // it, in the editor. A linked device never does (spec 006, 012; docs/spec-questions.md, B6).
          if (patch.backup !== undefined) {
            if (yield* CurrentActor) return yield* new AppError({ code: "not_allowed" })
            if (patch.backup !== null) {
              const providers = yield* Providers
              const fault = yield* backupOfferedBy(providers)(patch.backup)
              if (fault !== null)
                return yield* new AppError({ code: "backup_not_offered", detail: fault })
            }
          }
          return yield* Workflows.use((w) => w.updateNode(id, patch))
        }),
      ),
    ),
  "workflows.holds": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) =>
        Effect.gen(function* () {
          // The hold shows on this computer only. A linked device and the phone get none (006).
          if (yield* CurrentActor) return []
          const holds = yield* ModelHolds
          const providers = yield* Providers
          const out = []
          for (const hold of holds.ofWorkflow(workflowId)) {
            // A backup that is not ready any more ends the hold at once (spec 006).
            if (yield* providers.verify(hold.backup.accountId)) out.push(hold)
            else holds.clear(hold.nodeId)
          }
          return out
        }),
      ),
    ),
  "workflows.hold.release": (input) =>
    decode(Schema.Struct({ nodeId: Schema.String }))(input).pipe(
      Effect.flatMap(({ nodeId }) =>
        ownerOnly(ModelHolds.use((h) => Effect.sync(() => void h.release(nodeId)))),
      ),
      done,
    ),
  "workflows.node.move": (input) =>
    decode(Schema.Struct({ id: Schema.String, x: Schema.Number, y: Schema.Number }))(input).pipe(
      Effect.flatMap(({ id, x, y }) => Workflows.use((w) => w.moveNode(id, x, y))),
      done,
    ),
  "workflows.node.remove": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Workflows.use((w) => w.removeNode(id))),
      done,
    ),
  "workflows.option.add": (input) =>
    decode(Schema.Struct({ nodeId: Schema.String, label: Schema.String }))(input).pipe(
      Effect.flatMap(({ nodeId, label }) => Workflows.use((w) => w.addOption(nodeId, label))),
    ),
  "workflows.option.rename": (input) =>
    decode(Schema.Struct({ id: Schema.String, label: Schema.String }))(input).pipe(
      Effect.flatMap(({ id, label }) => Workflows.use((w) => w.renameOption(id, label))),
    ),
  "workflows.option.remove": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Workflows.use((w) => w.removeOption(id)))),
  "workflows.connect": (input) =>
    decode(
      Schema.Struct({
        workflowId: Schema.String,
        from: Schema.String,
        to: Schema.String,
        source: Schema.optionalKey(ConnectionSource),
      }),
    )(input).pipe(
      Effect.flatMap(({ workflowId, from, to, source }) =>
        Workflows.use((w) => w.connect(workflowId, from, to, source)),
      ),
    ),
  "workflows.disconnect": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Workflows.use((w) => w.disconnect(id))),
      done,
    ),
  "workflows.versions": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Workflows.use((w) => w.versions(id)))),
  "workflows.versions.restore": (input) =>
    decode(Schema.Struct({ id: Schema.String, versionId: Schema.String }))(input).pipe(
      Effect.flatMap(({ id, versionId }) =>
        Effect.gen(function* () {
          // A linked device restores a graph without changing a backup model (spec 006, 012).
          const actor = yield* CurrentActor
          return yield* Workflows.use((w) =>
            w.restoreVersion(id, versionId, { keepBackups: actor !== null }),
          )
        }),
      ),
    ),
  "chat.history": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) => Chat.use((c) => c.history(workflowId))),
    ),
  "chat.send": (input) =>
    decode(WorkflowChatSend)(input).pipe(Effect.flatMap((v) => Chat.use((c) => c.send(v)))),
  "chat.setModel": (input) =>
    decode(
      Schema.Struct({ workflowId: Schema.String, accountId: Schema.String, model: Schema.String }),
    )(input).pipe(
      Effect.flatMap(({ workflowId, accountId, model }) =>
        Chat.use((c) => c.setModel(workflowId, accountId, model)),
      ),
      done,
    ),
  "chat.stop": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) => Chat.use((c) => c.stop(workflowId))),
      done,
    ),
  "chat.delete": (input) =>
    decode(ById)(input).pipe(Effect.flatMap(({ id }) => Chat.use((c) => c.deleteWaiting(id)))),
  "chat.sendNow": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Chat.use((c) => c.sendNow(id))),
      done,
    ),
  "chat.edit": (input) =>
    decode(Schema.Struct({ id: Schema.String, text: Schema.String }))(input).pipe(
      Effect.flatMap(({ id, text }) => Chat.use((c) => c.edit(id, text))),
      done,
    ),
  "chat.markUnread": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Chat.use((c) => c.markUnread(id))),
      done,
    ),
  "chat.read": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) => Chat.use((c) => c.read(workflowId))),
      done,
    ),
  "chat.retry": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) => Chat.use((c) => c.retry(workflowId))),
      done,
    ),
  "chat.resume": (input) =>
    decode(
      Schema.Struct({ workflowId: Schema.String, mode: Schema.Literals(["continue", "again"]) }),
    )(input).pipe(
      Effect.flatMap(({ workflowId, mode }) => Chat.use((c) => c.resume(workflowId, mode))),
      done,
    ),
  "chat.clearMarks": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) => Chat.use((c) => c.clearMarks(workflowId))),
      done,
    ),
  "chat.compact": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) => Chat.use((c) => c.compact(workflowId))),
      done,
    ),
  "runs.start": (input) =>
    decode(
      Schema.Struct({
        workflowId: Schema.String,
        trigger: Schema.optionalKey(Schema.String),
      }),
    )(input).pipe(
      Effect.flatMap((v) =>
        Effect.gen(function* () {
          // The device that starts the run is named in its record: "Started by <device>" (012).
          const actor = yield* CurrentActor
          return yield* Runs.use((r) => r.start(v, "hand", actor?.name ?? null))
        }),
      ),
    ),
  "runs.stop": (input) =>
    decode(Schema.Struct({ runId: Schema.String }))(input).pipe(
      Effect.flatMap(({ runId }) => Runs.use((r) => r.stop(runId))),
      done,
    ),
  "runs.list": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) => Runs.use((r) => r.list(workflowId))),
    ),
  "runs.get": (input) =>
    decode(Schema.Struct({ runId: Schema.String }))(input).pipe(
      Effect.flatMap(({ runId }) => Runs.use((r) => r.get(runId))),
    ),
  "tasks.list": (input) =>
    decode(
      Schema.UndefinedOr(
        Schema.Struct({
          state: Schema.optionalKey(Schema.Literals(TASK_STATES)),
          workflowId: Schema.optionalKey(Schema.String),
          source: Schema.optionalKey(Schema.Literals(RUN_SOURCES)),
        }),
      ),
    )(input).pipe(Effect.flatMap((filter) => Tasks.use((t) => t.list(filter ?? {})))),
  "tasks.get": (input) =>
    decode(Schema.Struct({ taskId: Schema.String }))(input).pipe(
      Effect.flatMap(({ taskId }) => Tasks.use((t) => t.get(taskId))),
    ),
  "tasks.stop": (input) =>
    decode(Schema.Struct({ taskId: Schema.String }))(input).pipe(
      Effect.flatMap(({ taskId }) => Tasks.use((t) => t.stop(taskId))),
      done,
    ),
  "tasks.runNext": (input) =>
    decode(Schema.Struct({ taskId: Schema.String }))(input).pipe(
      Effect.flatMap(({ taskId }) => Tasks.use((t) => t.runNext(taskId))),
      done,
    ),
  "tasks.retry": (input) =>
    decode(Schema.Struct({ taskId: Schema.String, confirmed: Schema.optionalKey(Schema.Boolean) }))(
      input,
    ).pipe(
      Effect.flatMap(({ taskId, confirmed }) =>
        Effect.gen(function* () {
          // A retry from a linked device is a run that this device started (spec 012).
          const actor = yield* CurrentActor
          return yield* Tasks.use((t) => t.retry(taskId, confirmed, actor?.name ?? null))
        }),
      ),
    ),
  "tasks.quiet": () => Tasks.use((t) => Effect.sync(() => t.quiet())),
  "cards.answer": (input) =>
    decode(
      Schema.Struct({
        cardId: Schema.String,
        answer: Schema.Union([
          Schema.Struct({
            kind: Schema.Literal("approval"),
            answer: Schema.Literals(["allow", "always", "deny"]),
          }),
          Schema.Struct({ kind: Schema.Literal("question"), text: Schema.String }),
          Schema.Struct({ kind: Schema.Literal("pick"), optionId: Schema.String }),
          Schema.Struct({
            kind: Schema.Literal("verdict"),
            verdict: Schema.Literals(["approve", "reject"]),
            comment: Schema.Trim.pipe(Schema.check(Schema.isMaxCodePoints(APPROVAL_COMMENT_MAX))),
          }),
          Schema.Struct({ kind: Schema.Literal("control") }),
        ]),
      }),
    )(input).pipe(
      Effect.flatMap(({ cardId, answer }) =>
        Effect.gen(function* () {
          // A linked device answers as one "Allow" and keeps no rule, and the log names it
          // (spec 012).
          const actor = yield* CurrentActor
          return yield* Cards.use((c) => c.answer(cardId, answer, actor))
        }),
      ),
      done,
    ),
  "memory.state": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String, search: Schema.optionalKey(Schema.String) }))(
      input,
    ).pipe(
      Effect.flatMap(({ workflowId, search }) => Memory.use((m) => m.state(workflowId, search))),
      Effect.flatMap(countForActor),
    ),
  "memory.history": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) => Memory.use((m) => m.history(workflowId))),
    ),
  "memory.add": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String, text: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId, text }) => Memory.use((m) => m.add(workflowId, text))),
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
  "memory.undo": (input) =>
    decode(Schema.Struct({ historyId: Schema.String }))(input).pipe(
      Effect.flatMap(({ historyId }) => Memory.use((m) => m.undo(historyId))),
      done,
    ),
  "memory.setEnabled": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String, enabled: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ workflowId, enabled }) =>
        Memory.use((m) => m.setEnabled(workflowId, enabled)),
      ),
    ),
  "memory.setMode": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String, mode: Schema.Literals(["ask", "now"]) }))(
      input,
    ).pipe(
      Effect.flatMap(({ workflowId, mode }) => Memory.use((m) => m.setMode(workflowId, mode))),
    ),
  "proposals.list": (input) =>
    decode(Schema.Struct({ workflowId: Schema.String }))(input).pipe(
      Effect.flatMap(({ workflowId }) =>
        Effect.gen(function* () {
          const view = yield* ownerOnly(Proposals.use((p) => p.list(workflowId)))
          const programBlock = yield* Chat.use((c) => c.programBlock(workflowId))
          return { ...view, programBlock }
        }),
      ),
    ),
  "proposals.accept": (input) =>
    decode(Schema.Struct({ id: Schema.String, text: Schema.optionalKey(Schema.String) }))(
      input,
    ).pipe(
      Effect.flatMap(({ id, text }) => ownerOnly(Proposals.use((p) => p.accept(id, text)))),
      done,
    ),
  "proposals.reject": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => ownerOnly(Proposals.use((p) => p.reject(id)))),
      done,
    ),
  "proposals.undo": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => ownerOnly(Proposals.use((p) => p.undo(id)))),
      done,
    ),
  "workflows.setSelfImprovement": (input) =>
    decode(Schema.Struct({ id: Schema.String, enabled: Schema.Boolean }))(input).pipe(
      Effect.flatMap(({ id, enabled }) =>
        ownerOnly(Workflows.use((w) => w.setSelfImprovement(id, enabled))),
      ),
    ),
  "workflows.delete": (input) =>
    decode(ById)(input).pipe(
      Effect.flatMap(({ id }) => Workflows.use((w) => w.remove(id))),
      done,
    ),
}

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
  // A request that changes workflows needs the switch "Can create and change workflows" (spec 010,
  // 012). The switch is read at each request, so a device that lost it a moment ago gets the error
  // also on a connection that was open before. The window of this computer needs no switch.
  if (actor && isChangeMethod(method)) {
    const allowed = await runtime.runPromise(
      Devices.use((d) => Effect.sync(() => (d.canChange(actor.id) ? null : d.deviceName()))),
    )
    if (allowed !== null) return { ok: false, error: { code: "change_off", message: allowed } }
  }
  if (isHostMethod(method)) {
    return runtime.runPromise(Host.use((h) => Effect.promise(() => h.call(method, input, actor))))
  }
  const handler = (handlers as Record<string, Handler<RpcMethod> | undefined>)[method]
  if (!handler) return { ok: false, error: { code: "unknown_method", message: method } }
  // The device that asks is known to the handlers: they record "from <device>" with it.
  const exit = await runtime.runPromiseExit(
    Effect.provideService(handler(input as never), CurrentActor, actor),
  )
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

/** A call of the window. Linked servers are not reached in this version: the call runs here. */
export const runWindowRequest = async (
  runtime: ManagedRuntime.ManagedRuntime<Services, never>,
  method: string,
  input: unknown,
  _server?: string,
): Promise<RpcResult<unknown>> => runRequest(runtime, method, input)
