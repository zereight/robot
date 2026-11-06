import { join } from "node:path"
import { Layer } from "effect"
import type { OpenSocket } from "./link/nearby.ts"
import { ActionLog } from "./services/ActionLog.ts"
import { BrowserProfiles } from "./services/BrowserProfiles.ts"
import { Chat } from "./services/Chat.ts"
import { Connections, type ConnectionsOptions } from "./services/Connections.ts"
import { Database } from "./services/Database.ts"
import { Decision } from "./services/Decision.ts"
import { Devices } from "./services/Devices.ts"
import { EventBus } from "./services/EventBus.ts"
import { Host } from "./services/Host.ts"
import { Platform, type PlatformService } from "./services/Platform.ts"
import { Providers } from "./services/Providers.ts"
import { Rules } from "./services/Rules.ts"
import { RunFacts } from "./services/RunFacts.ts"
import { Runtimes } from "./services/Runtimes.ts"
import { SavedSecrets } from "./services/SavedSecrets.ts"
import type { Secrets } from "./services/Secrets.ts"
import { Servers } from "./services/Servers.ts"
import { SettingsStore } from "./services/Settings.ts"
import { Skills } from "./services/Skills.ts"
import { UiStore } from "./services/UiStore.ts"
import { Workflows } from "./services/Workflows.ts"

export interface AppLayerOptions {
  readonly platform: PlatformService
  readonly databaseFile?: string
  readonly localServerName: string
  /** `server` is the linked server that sent the event; absent for this computer. */
  readonly emit: (event: string, payload: unknown, server?: string) => void
  readonly secrets: Layer.Layer<Secrets>
  /** The port of the device link. Tests use 0 to let the system choose. */
  readonly linkPort?: number
  /** Opens the socket that finds and announces computers near. Tests give a network in memory. */
  readonly nearbySocket?: OpenSocket
  /** The address of the decision model service. Only tests set it (spec 013). */
  readonly decisionUrl?: string
  /** The host program. Unit tests that do not need it leave it out. */
  readonly host?: Layer.Layer<Host>
  /** Hosts, besides the official one, that take the cache marker. Only tests set it (spec 006). */
  readonly cacheHosts?: readonly string[]
  /** The limits and the way to reach a connection (spec 018). Only tests set them. */
  readonly connections?: ConnectionsOptions
}

/** Every main process service, wired together. */
export const appLayer = (options: AppLayerOptions) => {
  const base = Layer.mergeAll(
    Layer.succeed(Platform, options.platform),
    Database.layer(options.databaseFile ?? join(options.platform.dataDir, "robot.db")),
    EventBus.layer(options.emit),
    options.secrets,
    options.host ?? Host.none,
  )
  const stores = Layer.mergeAll(
    SettingsStore.layer,
    UiStore.layer,
    Servers.layer(options.localServerName),
    Skills.layer,
  ).pipe(Layer.provideMerge(base))
  const devices = Devices.layer({
    computerName: options.localServerName,
    ...(options.linkPort !== undefined ? { port: options.linkPort } : {}),
    ...(options.nearbySocket ? { nearbySocket: options.nearbySocket } : {}),
  }).pipe(Layer.provideMerge(stores))
  const runtimes = Runtimes.layer.pipe(Layer.provideMerge(devices))
  const providers = Providers.layer(
    options.cacheHosts ? { cacheHosts: options.cacheHosts } : {},
  ).pipe(Layer.provideMerge(runtimes))
  const rules = Layer.mergeAll(
    ActionLog.layer,
    Rules.layer,
    SavedSecrets.layer,
    Decision.layer(options.decisionUrl ? { url: options.decisionUrl } : {}),
  ).pipe(Layer.provideMerge(providers))
  // The connections use the rules, to remove the rules of a connection that is removed (spec 018).
  const connections = Connections.layer(options.connections ?? {}).pipe(Layer.provideMerge(rules))
  const workflows = Workflows.layer.pipe(Layer.provideMerge(connections))
  const runFacts = RunFacts.layer.pipe(Layer.provideMerge(workflows))
  const chat = Chat.layer.pipe(Layer.provideMerge(runFacts))
  return BrowserProfiles.layer.pipe(Layer.provideMerge(chat))
}

export type AppServices = Layer.Success<ReturnType<typeof appLayer>>
