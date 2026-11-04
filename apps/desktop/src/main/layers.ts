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
import { ChannelTools } from "./services/ChannelTools.ts"
import { Chat } from "./services/Chat.ts"
import { Checklists } from "./services/Checklists.ts"
import { Connections, type ConnectionsOptions } from "./services/Connections.ts"
import { Data } from "./services/Data.ts"
import { Database } from "./services/Database.ts"
import { Decision } from "./services/Decision.ts"
import { Devices } from "./services/Devices.ts"
import { EventBus } from "./services/EventBus.ts"
import { Handbook } from "./services/Handbook.ts"
import { Handover } from "./services/Handover.ts"
import { Host } from "./services/Host.ts"
import { KeepAwake } from "./services/KeepAwake.ts"
import { Knowledge } from "./services/Knowledge.ts"
import { Memory } from "./services/Memory.ts"
import { MemoryCheck } from "./services/MemoryCheck.ts"
import { ModelHolds } from "./services/ModelHolds.ts"
import { Notifier } from "./services/Notifier.ts"
import { OrgChart } from "./services/OrgChart.ts"
import { PlaceMarks } from "./services/PlaceMarks.ts"
import { Places } from "./services/Places.ts"
import { Platform, type PlatformService } from "./services/Platform.ts"
import { Providers } from "./services/Providers.ts"
import { Remote } from "./services/Remote.ts"
import { Routines } from "./services/Routines.ts"
import { Rules } from "./services/Rules.ts"
import { Runtimes } from "./services/Runtimes.ts"
import { SavedSecrets } from "./services/SavedSecrets.ts"
import { Search } from "./services/Search.ts"
import type { Secrets } from "./services/Secrets.ts"
import { Sections } from "./services/Sections.ts"
import { Servers } from "./services/Servers.ts"
import { SettingsStore } from "./services/Settings.ts"
import { SkillDrafts } from "./services/SkillDrafts.ts"
import { Skills } from "./services/Skills.ts"
import { Starters } from "./services/Starters.ts"
import { Sync } from "./services/Sync.ts"
import type { Clock } from "./services/silence.ts"
import { Tasks } from "./services/Tasks.ts"
import { Teach } from "./services/Teach.ts"
import { TeamsLink } from "./services/TeamsLink.ts"
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
  /** The host program. Unit tests that do not need it leave it out. */
  readonly host?: Layer.Layer<Host>
  /** Hosts, besides the official one, that take the cache marker. Only tests set it (spec 006). */
  readonly cacheHosts?: readonly string[]
  /** The clock of the Teams link (spec 028). Only tests set it, to move time by hand. */
  readonly clock?: Clock
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
    Sections.layer,
    Activity.layer,
    Skills.layer,
    Checklists.layer,
    PlaceMarks.layer,
    ModelHolds.layer,
  ).pipe(Layer.provideMerge(base))
  // After the stores: it reads the setting, the agents that work and the routines.
  const keepAwake = KeepAwake.layer.pipe(Layer.provideMerge(stores))
  const devices = Devices.layer({
    computerName: options.localServerName,
    ...(options.linkPort !== undefined ? { port: options.linkPort } : {}),
    ...(options.nearbySocket ? { nearbySocket: options.nearbySocket } : {}),
  }).pipe(Layer.provideMerge(keepAwake))
  const runtimes = Runtimes.layer.pipe(Layer.provideMerge(devices))
  const providers = Providers.layer(
    options.cacheHosts ? { cacheHosts: options.cacheHosts } : {},
  ).pipe(Layer.provideMerge(runtimes))
  const notifier = Notifier.layer.pipe(Layer.provideMerge(providers))
  const memory = Layer.mergeAll(
    Memory.layer,
    ActionLog.layer,
    Rules.layer,
    Search.layer,
    SavedSecrets.layer,
    Decision.layer(options.decisionUrl ? { url: options.decisionUrl } : {}),
    Agents.layer,
  ).pipe(Layer.provideMerge(notifier))
  // The handbook refuses a text that holds a saved secret, so it comes after them (spec 002, 014).
  const handbook = Handbook.layer.pipe(Layer.provideMerge(memory))
  // The connections use the rules, to remove the rules of a connection that is removed (spec 018).
  const connections = Connections.layer(options.connections ?? {}).pipe(
    Layer.provideMerge(handbook),
  )
  // The settings tool changes agents, so agents come before the tools (spec 002).
  const agentSettings = AgentSettings.layer.pipe(Layer.provideMerge(connections))
  const knowledge = Knowledge.layer.pipe(Layer.provideMerge(agentSettings))
  const tools = Tools.layer.pipe(Layer.provideMerge(knowledge))
  const tasks = Tasks.layer.pipe(Layer.provideMerge(tools))
  const agents = Layer.mergeAll(Chat.layer, Usage.layer, ChannelTools.layer).pipe(
    Layer.provideMerge(tasks),
  )
  // The memory check counts the turns that end as done, and runs its own short turn (spec 008).
  const memoryCheck = MemoryCheck.layer.pipe(Layer.provideMerge(agents))
  // The handover of a chat needs the chat service (spec 003, "Hand over").
  const handover = Handover.layer.pipe(Layer.provideMerge(memoryCheck))
  const channels = Channels.layer.pipe(Layer.provideMerge(handover))
  const routines = Routines.layer.pipe(Layer.provideMerge(channels))
  const starters = Starters.layer.pipe(Layer.provideMerge(routines))
  const workflows = Workflows.layer.pipe(Layer.provideMerge(starters))
  const teach = Layer.mergeAll(Teach.layer, SkillDrafts.layer).pipe(Layer.provideMerge(workflows))
  const browserProfiles = BrowserProfiles.layer.pipe(Layer.provideMerge(teach))
  const teamsLink = TeamsLink.layer(options.clock ? { clock: options.clock } : {}).pipe(
    Layer.provideMerge(browserProfiles),
  )
  const places = Places.layer.pipe(Layer.provideMerge(teamsLink))
  const today = Today.layer.pipe(Layer.provideMerge(places))
  const orgChart = OrgChart.layer.pipe(Layer.provideMerge(today))
  const agentFiles = AgentFiles.layer.pipe(Layer.provideMerge(orgChart))
  const workflowFiles = WorkflowFiles.layer.pipe(Layer.provideMerge(agentFiles))
  const remote = Remote.layer.pipe(Layer.provideMerge(workflowFiles))
  const data = Data.layer.pipe(Layer.provideMerge(remote))
  return Sync.layer.pipe(Layer.provideMerge(data))
}

export type AppServices = Layer.Success<ReturnType<typeof appLayer>>
