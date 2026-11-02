import { join } from "node:path"
import { Layer } from "effect"
import { Activity } from "./services/Activity.ts"
import { AgentFiles } from "./services/AgentFiles.ts"
import { Agents } from "./services/Agents.ts"
import { Channels } from "./services/Channels.ts"
import { Chat } from "./services/Chat.ts"
import { Data } from "./services/Data.ts"
import { Database } from "./services/Database.ts"
import { EventBus } from "./services/EventBus.ts"
import { Knowledge } from "./services/Knowledge.ts"
import { Memory } from "./services/Memory.ts"
import { Notifier } from "./services/Notifier.ts"
import { Places } from "./services/Places.ts"
import { Platform, type PlatformService } from "./services/Platform.ts"
import { Providers } from "./services/Providers.ts"
import { Routines } from "./services/Routines.ts"
import { Runtimes } from "./services/Runtimes.ts"
import type { Secrets } from "./services/Secrets.ts"
import { Sections } from "./services/Sections.ts"
import { Servers } from "./services/Servers.ts"
import { SettingsStore } from "./services/Settings.ts"
import { Tasks } from "./services/Tasks.ts"
import { Tools } from "./services/Tools.ts"
import { UiStore } from "./services/UiStore.ts"
import { Usage } from "./services/Usage.ts"
import { WorkflowFiles } from "./services/WorkflowFiles.ts"
import { Workflows } from "./services/Workflows.ts"

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
    Sections.layer,
    Activity.layer,
  ).pipe(Layer.provideMerge(base))
  const runtimes = Runtimes.layer.pipe(Layer.provideMerge(stores))
  const providers = Providers.layer.pipe(Layer.provideMerge(runtimes))
  const notifier = Notifier.layer.pipe(Layer.provideMerge(providers))
  const memory = Memory.layer.pipe(Layer.provideMerge(notifier))
  const knowledge = Knowledge.layer.pipe(Layer.provideMerge(memory))
  const tools = Tools.layer.pipe(Layer.provideMerge(knowledge))
  const tasks = Tasks.layer.pipe(Layer.provideMerge(tools))
  const agents = Layer.mergeAll(Agents.layer, Chat.layer, Usage.layer).pipe(
    Layer.provideMerge(tasks),
  )
  const channels = Channels.layer.pipe(Layer.provideMerge(agents))
  const routines = Routines.layer.pipe(Layer.provideMerge(channels))
  const workflows = Workflows.layer.pipe(Layer.provideMerge(routines))
  const places = Places.layer.pipe(Layer.provideMerge(workflows))
  const agentFiles = AgentFiles.layer.pipe(Layer.provideMerge(places))
  const workflowFiles = WorkflowFiles.layer.pipe(Layer.provideMerge(agentFiles))
  return Data.layer.pipe(Layer.provideMerge(workflowFiles))
}

export type AppServices = Layer.Success<ReturnType<typeof appLayer>>
