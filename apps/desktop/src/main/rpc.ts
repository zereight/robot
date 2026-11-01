import {
  INVOKE_CHANNEL,
  type RpcInput,
  type RpcMethod,
  type RpcOutput,
  type RpcResult,
  SettingsPatch,
  UiStatePatch,
} from "@robot/shared"
import { Cause, Effect, Exit, type ManagedRuntime, Schema } from "effect"
import { ipcMain } from "electron"
import type { AppServices } from "./layers.ts"
import licenses from "./licenses.json"
import { AppError } from "./services/errors.ts"
import { Places } from "./services/Places.ts"
import { Platform } from "./services/Platform.ts"
import { Servers } from "./services/Servers.ts"
import { SettingsStore } from "./services/Settings.ts"
import { UiStore } from "./services/UiStore.ts"

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
