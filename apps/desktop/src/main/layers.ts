import { join } from "node:path"
import { Layer } from "effect"
import { Activity } from "./services/Activity.ts"
import { Agents } from "./services/Agents.ts"
import { Chat } from "./services/Chat.ts"
import { Database } from "./services/Database.ts"
import { EventBus } from "./services/EventBus.ts"
import { Places } from "./services/Places.ts"
import { Platform, type PlatformService } from "./services/Platform.ts"
import { Providers } from "./services/Providers.ts"
import type { Secrets } from "./services/Secrets.ts"
import { Servers } from "./services/Servers.ts"
import { SettingsStore } from "./services/Settings.ts"
import { UiStore } from "./services/UiStore.ts"

export interface AppLayerOptions {
  readonly platform: PlatformService
  readonly databaseFile?: string
  readonly localServerName: string
  readonly emit: (event: string, payload: unknown) => void
  readonly secrets: Layer.Layer<Secrets>
}

/** Every main process service, wired together. */
export const appLayer = (options: AppLayerOptions) => {
  const base = Layer.mergeAll(
    Layer.succeed(Platform, options.platform),
    Database.layer(options.databaseFile ?? join(options.platform.dataDir, "robot.db")),
    EventBus.layer(options.emit),
    options.secrets,
  )
  const stores = Layer.mergeAll(
    SettingsStore.layer,
    UiStore.layer,
    Servers.layer(options.localServerName),
    Activity.layer,
  ).pipe(Layer.provideMerge(base))
  const providers = Providers.layer.pipe(Layer.provideMerge(stores))
  const agents = Layer.mergeAll(Agents.layer, Chat.layer).pipe(Layer.provideMerge(providers))
  return Places.layer.pipe(Layer.provideMerge(agents))
}

export type AppServices = Layer.Success<ReturnType<typeof appLayer>>
