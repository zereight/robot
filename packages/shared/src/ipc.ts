import type { AgentFileImported, AgentFilePreview } from "./agentFile.ts"
import type { Agent, AgentCreate, AgentModel, AgentPatch } from "./agents.ts"
import type {
  Channel,
  ChannelActivity,
  ChannelCreate,
  ChannelMessage,
  ChannelPatch,
} from "./channels.ts"
import type { ChatMessage, ChatSend, QueuedMessage } from "./chat.ts"
import type {
  KnowledgeArticle,
  KnowledgeChange,
  KnowledgeFindings,
  KnowledgeView,
} from "./knowledge.ts"
import type { MemoryItem } from "./memory.ts"
import type { IslandState, Mute, MuteChoice, PlaceTarget } from "./notifications.ts"
import type {
  ModelInfo,
  ProviderAccount,
  ProviderConnect,
  RuntimeKind,
  RuntimeStatus,
} from "./providers.ts"
import type { Routine, RoutineEntry, RoutineInput, RoutinePatch } from "./routines.ts"
import type { MoveDirection, SectionCreate, UserSection } from "./sections.ts"
import type { Settings, SettingsPatch } from "./settings.ts"
import type { Task, TaskDetail } from "./task.ts"
import type { ApprovalAnswer } from "./tools.ts"
import type { PlaceKind, PlaceSection, Server, UiState, UiStatePatch } from "./ui.ts"
import type { UsageRange, UsageRow } from "./usage.ts"
import type { WorkflowFileImported, WorkflowFilePreview } from "./workflowFile.ts"
import type {
  Workflow,
  WorkflowInput,
  WorkflowPatch,
  WorkflowRun,
  WorkflowRunDetail,
} from "./workflows.ts"

/** Information about the running app. */
export interface AppInfo {
  readonly name: string
  readonly version: string
  readonly platform: string
  readonly systemLocale: string
  readonly dataDir: string
  readonly defaultWorkspaceRoot: string
}

export interface LicenseEntry {
  readonly name: string
  readonly version: string
  readonly license: string
}

/**
 * Request methods that the renderer can call in the main process.
 * Each entry maps a method name to its input and output.
 */
export interface RpcMethods {
  "app.info": { input: undefined; output: AppInfo }
  "app.licenses": { input: undefined; output: readonly LicenseEntry[] }
  "app.copy": { input: { text: string }; output: undefined }
  /** Opens an http, https or mailto link in the system browser. */
  "app.openExternal": { input: { url: string }; output: undefined }
  "settings.get": { input: undefined; output: Settings }
  "settings.update": { input: SettingsPatch; output: Settings }
  "settings.pickWorkspaceRoot": { input: undefined; output: Settings }
  "data.openFolder": { input: undefined; output: undefined }
  "servers.list": { input: undefined; output: readonly Server[] }
  "places.list": { input: { serverId: string }; output: readonly PlaceSection[] }
  /** Moves a place into a user section of its kind, or out of any (`sectionId` null). */
  "places.move": {
    input: { kind: PlaceKind; id: string; sectionId: string | null }
    output: undefined
  }
  "sections.create": { input: SectionCreate; output: UserSection }
  "sections.rename": { input: { id: string; name: string }; output: UserSection }
  /** One step in the order of the sections of its kind. At an end it changes nothing. */
  "sections.move": { input: { id: string; direction: MoveDirection }; output: undefined }
  /** Deletes the section. Its places move to "No section"; none is deleted. */
  "sections.delete": { input: { id: string }; output: undefined }
  "ui.get": { input: undefined; output: UiState }
  "ui.update": { input: UiStatePatch; output: UiState }
  "agents.list": { input: { serverId: string; archived: boolean }; output: readonly Agent[] }
  "agents.get": { input: { id: string }; output: Agent }
  "agents.create": { input: AgentCreate; output: Agent }
  "agents.update": { input: { id: string; patch: AgentPatch }; output: Agent }
  "agents.duplicate": { input: { id: string; suffix: string }; output: Agent }
  "agents.archive": { input: { id: string }; output: Agent }
  "agents.restore": { input: { id: string }; output: Agent }
  "agents.delete": { input: { id: string }; output: undefined }
  "agents.setFaceImage": { input: { id: string; dataUrl: string | null }; output: Agent }
  /** Asks where to save, then writes one agent file. `path` is null when cancelled. */
  "agentFile.export": {
    input: { serverId: string; agentIds: readonly string[] }
    output: { path: string | null; count: number }
  }
  /** Asks for an agent file and reads it. `null` when cancelled. Nothing is made yet. */
  "agentFile.open": { input: { serverId: string }; output: AgentFilePreview | null }
  /** Makes the agents of the file that `agentFile.open` read, all with this model. */
  "agentFile.apply": {
    input: { serverId: string; model: AgentModel | null }
    output: AgentFileImported
  }
  "providers.list": { input: undefined; output: readonly ProviderAccount[] }
  "providers.connect": { input: ProviderConnect; output: ProviderAccount }
  "providers.check": { input: { accountId: string }; output: undefined }
  "providers.disconnect": { input: { accountId: string }; output: undefined }
  "providers.remove": { input: { accountId: string }; output: undefined }
  "providers.models": { input: { accountId: string }; output: readonly ModelInfo[] }
  /** Looks at the vendor program on this computer again, and returns what it finds. */
  "runtimes.status": { input: { kind: RuntimeKind }; output: RuntimeStatus }
  /** Downloads the vendor program into the app. Ends when the download is done or failed. */
  "runtimes.install": { input: { kind: RuntimeKind }; output: RuntimeStatus }
  /** Opens the vendor sign-in in the browser. Ends when the user is signed in, or gave up. */
  "runtimes.signIn": { input: { kind: RuntimeKind }; output: RuntimeStatus }
  /** Ends a running download or sign-in. */
  "runtimes.cancel": { input: { kind: RuntimeKind }; output: undefined }
  /** Opens the system file dialog. Returns the chosen full paths; none when cancelled. */
  "files.pick": { input: undefined; output: readonly string[] }
  /** Asks where to save, then writes the archive. `path` is null when cancelled. */
  "data.export": { input: undefined; output: { path: string | null; files: number } }
  /** Asks for an archive, then restores it into an empty app. `null` when cancelled. */
  "data.restore": { input: undefined; output: { agents: number; messages: number } | null }
  /** The newest 500 tasks of a server. */
  "tasks.list": { input: { serverId: string }; output: readonly Task[] }
  "tasks.get": { input: { id: string }; output: TaskDetail }
  "tasks.stop": { input: { id: string }; output: undefined }
  "tasks.retry": { input: { id: string }; output: undefined }
  "channels.list": { input: { serverId: string }; output: readonly Channel[] }
  "channels.create": { input: ChannelCreate; output: Channel }
  "channels.update": { input: { id: string; patch: ChannelPatch }; output: Channel }
  "channels.delete": { input: { id: string }; output: undefined }
  "channels.history": { input: { channelId: string }; output: readonly ChannelMessage[] }
  /** Posts a job. `awaiting` is true when the user has to pick the member who takes it. */
  "channels.send": { input: { channelId: string; text: string }; output: { awaiting: boolean } }
  "channels.assign": {
    input: { channelId: string; messageId: string; agentId: string }
    output: undefined
  }
  /** Stops every running part and job of the channel. */
  "channels.stop": { input: { channelId: string }; output: undefined }
  "channels.activity": { input: { channelId: string }; output: ChannelActivity }
  "channels.markRead": { input: { channelId: string }; output: undefined }
  "memory.list": { input: { agentId: string; query?: string }; output: readonly MemoryItem[] }
  "memory.add": { input: { agentId: string; text: string }; output: MemoryItem }
  "memory.update": { input: { id: string; text: string }; output: MemoryItem }
  "memory.delete": { input: { id: string }; output: undefined }
  "knowledge.list": { input: { agentId: string; query?: string }; output: KnowledgeView }
  "knowledge.get": { input: { agentId: string; file: string }; output: KnowledgeArticle }
  /** Saves an article as the user. `file` is null for a new article. */
  "knowledge.save": {
    input: { agentId: string; file: string | null; title: string; summary: string; body: string }
    output: KnowledgeArticle
  }
  "knowledge.delete": { input: { agentId: string; file: string }; output: undefined }
  "knowledge.deleteSource": { input: { agentId: string; name: string }; output: undefined }
  "knowledge.openSource": { input: { agentId: string; name: string }; output: undefined }
  "knowledge.openFolder": { input: { agentId: string }; output: undefined }
  /** The last 50 changes, newest first. */
  "knowledge.changes": { input: { agentId: string }; output: readonly KnowledgeChange[] }
  /** One change, or null when it left the list of 50. */
  "knowledge.change": {
    input: { agentId: string; changeId: string }
    output: KnowledgeChange | null
  }
  "knowledge.undo": { input: { agentId: string; changeId: string }; output: undefined }
  "knowledge.findings": { input: { agentId: string }; output: KnowledgeFindings }
  /** Answers an approval card (`allow`, `always`, `deny`) or a question card (the text). */
  "tools.respond": {
    input: { agentId: string; callId: string; answer: ApprovalAnswer | string }
    output: undefined
  }
  "browser.state": { input: { agentId: string }; output: { open: boolean; control: boolean } }
  /** The user takes the controls of the agent's browser, or gives them back. */
  "browser.control": { input: { agentId: string; control: boolean }; output: undefined }
  "browser.close": { input: { agentId: string }; output: undefined }
  "routines.list": { input: { serverId: string }; output: readonly Routine[] }
  "routines.create": { input: RoutineInput; output: Routine }
  "routines.update": { input: { id: string; patch: RoutinePatch }; output: Routine }
  "routines.delete": { input: { id: string }; output: undefined }
  "routines.runNow": { input: { id: string }; output: undefined }
  "routines.calendar": {
    input: { serverId: string; from: number; to: number }
    output: readonly RoutineEntry[]
  }
  "workflows.list": { input: { serverId: string }; output: readonly Workflow[] }
  "workflows.create": { input: WorkflowInput; output: Workflow }
  "workflows.update": { input: { id: string; patch: WorkflowPatch }; output: Workflow }
  "workflows.delete": { input: { id: string }; output: undefined }
  "workflows.run": { input: { id: string; triggerText?: string }; output: WorkflowRun }
  "workflows.stop": { input: { runId: string }; output: undefined }
  "workflows.approve": {
    input: { runId: string; stepId: string; approved: boolean }
    output: undefined
  }
  "workflows.runs": { input: { workflowId: string }; output: readonly WorkflowRun[] }
  "workflows.runDetail": { input: { runId: string }; output: WorkflowRunDetail }
  /** Asks where to save, then writes one workflow file. `path` is null when cancelled. */
  "workflowFile.export": {
    input: { serverId: string; workflowIds: readonly string[] }
    output: { path: string | null; count: number }
  }
  /** Asks for a workflow file and reads it. `null` when cancelled. Nothing is made yet. */
  "workflowFile.open": { input: { serverId: string }; output: WorkflowFilePreview | null }
  /** Makes the workflows of the file that `workflowFile.open` read. All of them are off. */
  "workflowFile.apply": { input: { serverId: string }; output: WorkflowFileImported }
  "notifications.mutes": { input: undefined; output: readonly Mute[] }
  "notifications.setMute": {
    input: { kind: "server" | "channel"; id: string; choice: MuteChoice }
    output: undefined
  }
  "island.get": { input: undefined; output: IslandState }
  /** Answers the approval or question that the island shows. */
  "island.respond": {
    input: { agentId: string; callId: string; answer: string }
    output: undefined
  }
  /** Opens the app at the place of the waiting step. */
  "island.openApp": { input: { target: PlaceTarget }; output: undefined }
  "usage.summary": {
    input: { serverId: string; days: UsageRange }
    output: readonly UsageRow[]
  }
  "chat.history": {
    input: { agentId: string }
    output: { messages: readonly ChatMessage[]; queue: readonly QueuedMessage[] }
  }
  "chat.send": { input: ChatSend; output: { queued: boolean } }
  "chat.stop": { input: { agentId: string }; output: undefined }
  "chat.retry": { input: { agentId: string; messageId: string }; output: undefined }
  "chat.edit": { input: { agentId: string; messageId: string; text: string }; output: undefined }
  "chat.queue.update": {
    input: { agentId: string; itemId: string; text: string }
    output: undefined
  }
  "chat.queue.remove": { input: { agentId: string; itemId: string }; output: undefined }
  "chat.markRead": { input: { agentId: string }; output: undefined }
}

/** Events that the main process pushes to the renderer. */
export interface RpcEvents {
  "settings.changed": Settings
  "places.changed": { serverId: string }
  /** `serverId` is "*" when agents of every server may have changed. */
  "agents.changed": { serverId: string }
  "providers.changed": Record<string, never>
  /** A vendor program was found, downloaded, signed in to, or reports new limits. */
  "runtimes.changed": RuntimeStatus
  "tasks.changed": { serverId: string }
  "memory.changed": { agentId: string }
  /** An article, a source or the change list of an agent changed. */
  "knowledge.changed": { agentId: string }
  "browser.changed": { agentId: string }
  "routines.changed": { serverId: string }
  "workflows.changed": { serverId: string }
  "workflows.run": { runId: string }
  "island.state": IslandState
  "app.openPlace": PlaceTarget
  "app.openPage": { page: "workflows" }
  "notifications.changed": Record<string, never>
  /** The members, the plan steps or the state of a channel changed. */
  "channels.changed": { channelId: string }
  "channel.message": ChannelMessage
  "channel.removed": { channelId: string; messageId: string }
  /** A new or changed message. While a reply streams, this comes many times. */
  "chat.message": ChatMessage
  "chat.removed": { agentId: string; messageId: string }
  "chat.queue": { agentId: string; queue: readonly QueuedMessage[] }
}

export type RpcMethod = keyof RpcMethods
export type RpcInput<M extends RpcMethod> = RpcMethods[M]["input"]
export type RpcOutput<M extends RpcMethod> = RpcMethods[M]["output"]
export type RpcEvent = keyof RpcEvents

/** Result envelope that crosses the process boundary. Errors are plain data. */
export type RpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RpcError }

export interface RpcError {
  readonly code: string
  readonly message: string
}

/** The bridge that the preload script exposes on `window.robot`. */
export interface RobotBridge {
  invoke<M extends RpcMethod>(method: M, input: RpcInput<M>): Promise<RpcResult<RpcOutput<M>>>
  /** The full path of a file that the user dropped on the window. Empty when unknown. */
  pathForFile(file: File): string
  on<E extends RpcEvent>(event: E, listener: (payload: RpcEvents[E]) => void): () => void
}

export const INVOKE_CHANNEL = "robot:invoke"
export const EVENT_CHANNEL = "robot:event"
