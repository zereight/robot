import {
  AgentCreate,
  AgentPatch,
  ChatSend,
  INVOKE_CHANNEL,
  MESSAGE_MAX,
  ProviderConnect,
  type RpcInput,
  type RpcMethod,
  type RpcOutput,
  type RpcResult,
  SettingsPatch,
  UiStatePatch,
  USAGE_RANGES,
} from "@robot/shared"
import { Cause, Effect, Exit, type ManagedRuntime, Schema } from "effect"
import { ipcMain } from "electron"
import type { AppServices } from "./layers.ts"
import licenses from "./licenses.json"
import { Agents } from "./services/Agents.ts"
import { Chat } from "./services/Chat.ts"
import { AppError } from "./services/errors.ts"
import { Places } from "./services/Places.ts"
import { Platform } from "./services/Platform.ts"
import { Providers } from "./services/Providers.ts"
import { Servers } from "./services/Servers.ts"
import { SettingsStore } from "./services/Settings.ts"
import { UiStore } from "./services/UiStore.ts"
import { Usage } from "./services/Usage.ts"

export type Services = AppServices

type Handler<M extends RpcMethod> = (
  input: RpcInput<M>,
) => Effect.Effect<RpcOutput<M>, AppError, Services>

type Handlers = { [M in RpcMethod]: Handler<M> }

/** Checks untrusted input from the renderer against a schema. */
const decode =
  <S extends Schema.Top & { readonly DecodingServices: never }>(schema: S) =>
  (input: unknown) =>
    Schema.decodeUnknownEffect(schema)(input).pipe(
      Effect.mapError((e) => new AppError({ code: "invalid_input", detail: e.message })),
    )

const ById = Schema.Struct({ id: Schema.String })
const ByAccount = Schema.Struct({ accountId: Schema.String })
const ByAgent = Schema.Struct({ agentId: Schema.String })
const MessageText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(MESSAGE_MAX))
const done = Effect.as(undefined)

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
  "app.licenses": () => Effect.succeed(licenses),
  "app.copy": (input) =>
    decode(Schema.Struct({ text: Schema.String }))(input).pipe(
      Effect.flatMap(({ text }) => Platform.use((p) => Effect.sync(() => p.copyText(text)))),
      done,
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
      const patch = yield* decode(SettingsPatch)(input)
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
  "servers.list": () => Servers.use((s) => s.list),
  "places.list": (input) =>
    decode(Schema.Struct({ serverId: Schema.String }))(input).pipe(
      Effect.flatMap(({ serverId }) => Places.use((p) => p.list(serverId))),
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
  "usage.summary": (input) =>
    decode(
      Schema.Struct({
        serverId: Schema.String,
        days: Schema.Literals(USAGE_RANGES),
      }),
    )(input).pipe(
      Effect.flatMap(({ serverId, days }) => Usage.use((u) => u.summary(serverId, days))),
    ),
  "chat.history": (input) =>
    decode(ByAgent)(input).pipe(
      Effect.flatMap(({ agentId }) => Chat.use((c) => c.history(agentId))),
    ),
  "chat.send": (input) =>
    decode(ChatSend)(input).pipe(Effect.flatMap((data) => Chat.use((c) => c.send(data)))),
  "chat.stop": (input) =>
    decode(ByAgent)(input).pipe(
      Effect.flatMap(({ agentId }) => Chat.use((c) => c.stop(agentId))),
      done,
    ),
  "chat.retry": (input) =>
    decode(Schema.Struct({ agentId: Schema.String, messageId: Schema.String }))(input).pipe(
      Effect.flatMap(({ agentId, messageId }) => Chat.use((c) => c.retry(agentId, messageId))),
      done,
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
  "chat.markRead": (input) =>
    decode(ByAgent)(input).pipe(
      Effect.flatMap(({ agentId }) => Chat.use((c) => c.markRead(agentId))),
      done,
    ),
}

/** Runs one request and turns every outcome into plain data. */
export const runRequest = async (
  runtime: ManagedRuntime.ManagedRuntime<Services, never>,
  method: string,
  input: unknown,
): Promise<RpcResult<unknown>> => {
  const handler = (handlers as Record<string, Handler<RpcMethod> | undefined>)[method]
  if (!handler) return { ok: false, error: { code: "unknown_method", message: method } }
  const exit = await runtime.runPromiseExit(handler(input as never))
  if (Exit.isSuccess(exit)) return { ok: true, value: exit.value }
  const failure = exit.cause.reasons.find(Cause.isFailReason)
  if (failure) {
    const error = failure.error
    return { ok: false, error: { code: error.code, message: error.detail ?? error.code } }
  }
  console.error(`request ${method} failed`, Cause.pretty(exit.cause))
  return { ok: false, error: { code: "internal", message: "Unexpected error" } }
}

export const registerRpc = (runtime: ManagedRuntime.ManagedRuntime<Services, never>) => {
  ipcMain.handle(INVOKE_CHANNEL, (_event, method: string, input: unknown) =>
    runRequest(runtime, method, input),
  )
}
