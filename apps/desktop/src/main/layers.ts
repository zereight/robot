import { join } from "node:path"
import { Layer } from "effect"
import type { OpenSocket } from "./link/nearby.ts"
import { ActionLog } from "./services/ActionLog.ts"
import { Activity } from "./services/Activity.ts"
import { AgentFiles } from "./services/AgentFiles.ts"
import { AgentSettings } from "./services/AgentSettings.ts"
import { Agents } from "./services/Agents.ts"
import { BrowserProfiles } from "./services/BrowserProfiles.ts"
import { Channels } from "./services/Channels.ts"
import { Chat } from "./services/Chat.ts"
import { Checklists } from "./services/Checklists.ts"
import { Data } from "./services/Data.ts"
import { Database } from "./services/Database.ts"
import { Decision } from "./services/Decision.ts"
import { Devices } from "./services/Devices.ts"
import { EventBus } from "./services/EventBus.ts"
import { Knowledge } from "./services/Knowledge.ts"
import { Memory } from "./services/Memory.ts"
import { Notifier } from "./services/Notifier.ts"
import { Places } from "./services/Places.ts"
import { Platform, type PlatformService } from "./services/Platform.ts"
import { Providers } from "./services/Providers.ts"
import { Remote } from "./services/Remote.ts"
import { Routines } from "./services/Routines.ts"
import { Runtimes } from "./services/Runtimes.ts"
import { SavedSecrets } from "./services/SavedSecrets.ts"
import { Search } from "./services/Search.ts"
import type { Secrets } from "./services/Secrets.ts"
import { Sections } from "./services/Sections.ts"
import { Servers } from "./services/Servers.ts"
import { SettingsStore } from "./services/Settings.ts"
import { Skills } from "./services/Skills.ts"
import { Starters } from "./services/Starters.ts"
import { Sync } from "./services/Sync.ts"
import { Tasks } from "./services/Tasks.ts"
import { Teach } from "./services/Teach.ts"
import { Today } from "./services/Today.ts"
import { Tools } from "./services/Tools.ts"
import { UiStore } from "./services/UiStore.ts"
import { Usage } from "./services/Usage.ts"
import { WorkflowFiles } from "./services/WorkflowFiles.ts"
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
    Sections.layer,
    Activity.layer,
    Skills.layer,
    Checklists.layer,
  ).pipe(Layer.provideMerge(base))
  const devices = Devices.layer({
    computerName: options.localServerName,
    ...(options.linkPort !== undefined ? { port: options.linkPort } : {}),
    ...(options.nearbySocket ? { nearbySocket: options.nearbySocket } : {}),
  }).pipe(Layer.provideMerge(stores))
  const runtimes = Runtimes.layer.pipe(Layer.provideMerge(devices))
  const providers = Providers.layer.pipe(Layer.provideMerge(runtimes))
  const notifier = Notifier.layer.pipe(Layer.provideMerge(providers))
  const memory = Layer.mergeAll(
    Memory.layer,
    ActionLog.layer,
    Search.layer,
    SavedSecrets.layer,
    Decision.layer(options.decisionUrl ? { url: options.decisionUrl } : {}),
    Agents.layer,
  ).pipe(Layer.provideMerge(notifier))
  // The settings tool changes agents, so agents come before the tools (spec 002).
  const agentSettings = AgentSettings.layer.pipe(Layer.provideMerge(memory))
  const knowledge = Knowledge.layer.pipe(Layer.provideMerge(agentSettings))
  const tools = Tools.layer.pipe(Layer.provideMerge(knowledge))
  const tasks = Tasks.layer.pipe(Layer.provideMerge(tools))
  const agents = Layer.mergeAll(Chat.layer, Usage.layer).pipe(Layer.provideMerge(tasks))
  const channels = Channels.layer.pipe(Layer.provideMerge(agents))
  const routines = Routines.layer.pipe(Layer.provideMerge(channels))
  const starters = Starters.layer.pipe(Layer.provideMerge(routines))
  const workflows = Workflows.layer.pipe(Layer.provideMerge(starters))
  const teach = Teach.layer.pipe(Layer.provideMerge(workflows))
  const browserProfiles = BrowserProfiles.layer.pipe(Layer.provideMerge(teach))
  const places = Places.layer.pipe(Layer.provideMerge(browserProfiles))
  const today = Today.layer.pipe(Layer.provideMerge(places))
  const agentFiles = AgentFiles.layer.pipe(Layer.provideMerge(today))
  const workflowFiles = WorkflowFiles.layer.pipe(Layer.provideMerge(agentFiles))
  const remote = Remote.layer.pipe(Layer.provideMerge(workflowFiles))
  const data = Data.layer.pipe(Layer.provideMerge(remote))
  return Sync.layer.pipe(Layer.provideMerge(data))
}

export type AppServices = Layer.Success<ReturnType<typeof appLayer>>
