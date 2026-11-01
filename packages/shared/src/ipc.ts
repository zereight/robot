import type { Agent, AgentCreate, AgentPatch } from "./agents.ts"
import type { ChatMessage, ChatSend, QueuedMessage } from "./chat.ts"
import type { ModelInfo, ProviderAccount, ProviderConnect } from "./providers.ts"
import type { Settings, SettingsPatch } from "./settings.ts"
import type { Task, TaskDetail } from "./task.ts"
import type { PlaceSection, Server, UiState, UiStatePatch } from "./ui.ts"
import type { UsageRange, UsageRow } from "./usage.ts"

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
  "providers.list": { input: undefined; output: readonly ProviderAccount[] }
  "providers.connect": { input: ProviderConnect; output: ProviderAccount }
  "providers.check": { input: { accountId: string }; output: undefined }
  "providers.disconnect": { input: { accountId: string }; output: undefined }
  "providers.remove": { input: { accountId: string }; output: undefined }
  "providers.models": { input: { accountId: string }; output: readonly ModelInfo[] }
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
  "tasks.changed": { serverId: string }
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
