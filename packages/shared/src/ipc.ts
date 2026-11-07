import type { BrowserProfile, BrowserProfileCreate } from "./browserProfiles.ts"
import type { DecisionKeys, DecisionStatus, DecisionTestResult } from "./decision.ts"
import type {
  DevicesState,
  JoinRequest,
  ModelChoice,
  NearbyComputer,
  PairingState,
} from "./link.ts"
import type { ActionKind, ActionLogEntry, ActionResult } from "./outside.ts"
import type {
  ModelInfo,
  ProviderAccount,
  ProviderConnect,
  ReadOnlySupport,
  RuntimeKind,
  RuntimeStatus,
  RuntimeTarget,
} from "./providers.ts"
import type { PermissionRule, RuleDecision, RuleInput } from "./rules.ts"
import type { SavedSecret } from "./secrets.ts"
import type { Settings, SettingsPatch } from "./settings.ts"
import type { Skill, SkillInput } from "./skills.ts"
import type {
  ConnectionSaveInput,
  ConnectionTestResult,
  ToolConnection,
  ToolConnectionInput,
} from "./toolConnections.ts"
import type { HeldToolView } from "./toolReview.ts"
import type { PermissionLevel } from "./tools.ts"
import type { Server, UiState, UiStatePatch } from "./ui.ts"
import type { WorkflowChatHistory, WorkflowChatMessage, WorkflowChatSend } from "./workflowChat.ts"
import type {
  DocumentVersion,
  GraphVersion,
  NodeInput,
  NodePatch,
  Workflow,
  WorkflowConnection,
  WorkflowCreate,
  WorkflowDetail,
  WorkflowGraph,
  WorkflowNode,
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
  /**
   * Makes the diagnostic report of the whole app (the app screen, the Teams page, the browser
   * pages, the processes and the logs), copies it to the clipboard and keeps a copy in the logs
   * folder. `path` is the file. Settings, Data, "Copy a diagnostic report".
   */
  "app.diagnosticReport": { input: undefined; output: { path: string } }
  /** Opens an http, https or mailto link in the system browser. */
  "app.openExternal": { input: { url: string }; output: undefined }
  "settings.get": { input: undefined; output: Settings }
  "settings.update": { input: SettingsPatch; output: Settings }
  "settings.pickWorkspaceRoot": { input: undefined; output: Settings }
  "data.openFolder": { input: undefined; output: undefined }
  /** This computer, then the linked computers it can open, with their connection states. */
  "servers.list": { input: undefined; output: readonly Server[] }
  "devices.get": { input: undefined; output: DevicesState }
  /** Changes the name of this device, or "Let other devices connect". */
  "devices.update": {
    input: { name?: string; accept?: boolean }
    output: DevicesState
  }
  /** Shows a new pairing code. Turns on "Let other devices connect". */
  "devices.pair.start": { input: undefined; output: PairingState }
  "devices.pair.get": { input: undefined; output: PairingState }
  "devices.pair.stop": { input: undefined; output: PairingState }
  /** Devices that wait for Allow or Deny. */
  "devices.join.list": { input: undefined; output: readonly JoinRequest[] }
  /**
   * Answers a device that asks to join. `canChange` is the switch of the Allow dialog, "Let
   * <device name> create and change agents" (spec 012); without it the device gets no access.
   */
  "devices.join.decide": {
    input: { id: string; allow: boolean; canChange?: boolean }
    output: undefined
  }
  /** Ends the access of a device that can open this computer. */
  "devices.client.remove": { input: { id: string }; output: undefined }
  /** The switch "Can create and change agents" of one device. Fails while the computers sync. */
  "devices.client.setChange": { input: { id: string; canChange: boolean }; output: undefined }
  /** Computers on this network that show a pairing code now. */
  "devices.nearby": { input: undefined; output: readonly NearbyComputer[] }
  /** The browser profiles of this computer, each with the agents that use it. */
  "browserProfiles.list": { input: undefined; output: readonly BrowserProfile[] }
  "browserProfiles.create": { input: BrowserProfileCreate; output: BrowserProfile }
  "browserProfiles.rename": { input: { id: string; name: string }; output: BrowserProfile }
  /**
   * Deletes a profile and the browser data it holds. Its agents go back to their own data. Pages
   * that use it close. A linked device cannot call it.
   */
  "browserProfiles.delete": { input: { id: string }; output: undefined }
  /**
   * Gives an agent a browser profile, or its own data again (`profileId` null). An open page of
   * the agent closes. It is refused while the user holds the browser of the agent.
   */
  "browserProfiles.assign": {
    input: { workflowId: string; profileId: string | null }
    output: undefined
  }
  "ui.get": { input: undefined; output: UiState }
  "ui.update": { input: UiStatePatch; output: UiState }
  "providers.list": { input: undefined; output: readonly ProviderAccount[] }
  "providers.connect": { input: ProviderConnect; output: ProviderAccount }
  "providers.check": { input: { accountId: string }; output: undefined }
  "providers.disconnect": { input: { accountId: string }; output: undefined }
  "providers.remove": { input: { accountId: string }; output: undefined }
  /**
   * The connected model accounts with their models, for a device that picks a model on this
   * server. It holds no key. Needs the switch "Can create and change agents" on a linked server.
   */
  "models.available": { input: undefined; output: readonly ModelChoice[] }
  /**
   * The models of an account, newest first, with the marks that this computer adds (spec 006):
   * older, new, hidden, custom, and the limits of a custom model.
   */
  "providers.models": { input: { accountId: string }; output: readonly ModelInfo[] }
  /**
   * Changes one model in the part "Models" of an account: shows or hides it, and sets the context
   * size and the output limit of a custom model. A field that is absent stays; null clears it.
   */
  "providers.setModel": {
    input: {
      accountId: string
      model: string
      hidden?: boolean
      contextSize?: number | null
      outputLimit?: number | null
    }
    output: undefined
  }
  /** "Hide all" (hidden true) and "Reset" (hidden false) of the part "Models". */
  "providers.setAllModels": { input: { accountId: string; hidden: boolean }; output: undefined }
  /** Adds a model ID that the user typed to an API account. */
  "providers.addModel": { input: { accountId: string; model: string }; output: undefined }
  /** Takes a model ID that the user typed off the list of an account. */
  "providers.removeModel": { input: { accountId: string; model: string }; output: undefined }
  /** Looks at the vendor program on this computer again, and returns what it finds. */
  "runtimes.status": { input: RuntimeTarget; output: RuntimeStatus }
  /** Downloads the vendor program into the app. Ends when the download is done or failed. */
  "runtimes.install": { input: RuntimeTarget; output: RuntimeStatus }
  /** Opens the vendor sign-in in the browser. Ends when the user is signed in, or gave up. */
  "runtimes.signIn": { input: RuntimeTarget; output: RuntimeStatus }
  /**
   * Looks for the program again, downloads it again when the app downloaded it, and checks it.
   * It never touches the sign-in (spec 006).
   */
  "runtimes.repair": { input: RuntimeTarget; output: RuntimeStatus }
  /** Whether the program has a read-only mode of its own (spec 007). It is not part of the check. */
  "runtimes.readOnly": { input: RuntimeTarget; output: ReadOnlySupport }
  /** Ends a running download or sign-in. */
  "runtimes.cancel": { input: RuntimeTarget; output: undefined }
  /**
   * Gives up a separate sign-in that no account uses: signs it out and deletes its folder. A
   * sign-in that an account uses is left as it is.
   */
  "providers.discardSignIn": { input: { kind: RuntimeKind; signIn: string }; output: undefined }
  /** Opens the system file dialog. Returns the chosen full paths; none when cancelled. */
  "files.pick": { input: undefined; output: readonly string[] }
  /**
   * Saves the bytes of a file that has no path on disk (a picture or a video from the clipboard, a
   * picture dragged out of a web page) and returns the full path of the saved file. The message
   * box attaches the file by that path. A file over the limit of an attachment is refused. This
   * computer answers it, also when the window shows a linked server.
   */
  "files.stage": { input: { name: string; data: Uint8Array }; output: string }
  /** The action log of this computer, newest first (spec 007). It is not offered to a linked device. */
  "actionLog.list": {
    input: { workflowId?: string; result?: ActionResult; kind?: ActionKind; search?: string }
    output: readonly ActionLogEntry[]
  }
  /**
   * The permission rules of this computer, newest first (spec 007). The rules page is for the
   * computer only: none of the rules methods is offered to a linked device (spec 012).
   */
  "rules.list": {
    input: { workflowId?: string | null; decision?: RuleDecision }
    output: readonly PermissionRule[]
  }
  /** Adds a rule from the rules list. A rule that equals one that exists is refused. */
  "rules.add": { input: RuleInput; output: PermissionRule }
  /** Changes a rule. The result is the rule as kept. */
  "rules.update": { input: { id: string; rule: RuleInput }; output: PermissionRule }
  /** Deletes a rule. A rule that was deleted already is not an error. */
  "rules.delete": { input: { id: string }; output: undefined }
  /**
   * The connections of this computer (spec 018), by name. No secret value is in the answer. The
   * connections page is for the computer only: none of the connections methods is offered to a
   * linked device (spec 012, 018).
   */
  "connections.list": { input: undefined; output: readonly ToolConnection[] }
  /** Adds a connection, or changes the one named by `id`. The result is the connection as kept. */
  "connections.save": { input: ConnectionSaveInput; output: ToolConnection }
  /**
   * Connects once and gives the tools, or the reason of the failure. With `id` and no
   * `connection`, it tests the saved connection and keeps the tools it read. With `connection`,
   * it tests the form as it is; a value that is left empty for a saved secret uses the saved value.
   */
  "connections.test": {
    input: { id?: string; connection?: ToolConnectionInput }
    output: ConnectionTestResult
  }
  /** Turns a connection on or off. Off stops it at once. */
  "connections.setEnabled": { input: { id: string; enabled: boolean }; output: ToolConnection }
  /** Turns one tool of a connection on or off. A tool that is off is given to no agent. */
  "connections.setTool": {
    input: { id: string; tool: string; enabled: boolean }
    output: ToolConnection
  }
  /**
   * Turns "Trust read-only marks" on or off for a connection (spec 018, "Rules"). Off is the
   * default. This computer only: a linked device cannot set it.
   */
  "connections.setTrust": { input: { id: string; trust: boolean }; output: ToolConnection }
  /**
   * The tools of a connection that wait for the user's review (spec 018, "Tool review"), each with
   * the reviewed text and the text that the connection offers now. This computer only.
   */
  "connections.held": { input: { id: string }; output: readonly HeldToolView[] }
  /**
   * Accepts held tools: each becomes a reviewed tool with the text that the user saw. A tool whose
   * `key` is not the one of the text that the connection offers now stays held. This computer only.
   */
  "connections.accept": {
    input: { id: string; tools: readonly { name: string; key: string }[] }
    output: ToolConnection
  }
  /** Removes a connection, its saved secrets and its rules. The action log keeps its entries. */
  "connections.delete": { input: { id: string }; output: undefined }
  /**
   * The saved secrets of this computer (spec 020), never a value. Not offered to a linked device,
   * and a value never goes over a link.
   */
  "secrets.list": { input: { workflowId?: string }; output: readonly SavedSecret[] }
  /** Puts a new value for a saved secret in the keychain. */
  "secrets.replace": { input: { id: string; value: string }; output: SavedSecret }
  /** Deletes a saved secret and its value. */
  "secrets.delete": { input: { id: string }; output: undefined }
  /**
   * The decision model (spec 013): whether a key is saved, never the key. Not offered to a linked
   * device: the keys stay on this computer.
   */
  "workflows.list": { input: { serverId: string }; output: readonly Workflow[] }
  "workflows.get": { input: { id: string }; output: WorkflowDetail }
  "workflows.create": { input: WorkflowCreate; output: Workflow }
  "workflows.rename": { input: { id: string; name: string }; output: Workflow }
  /** Deletes the workflow with its graph, document, chat, runs and memory (spec 010). */
  "workflows.delete": { input: { id: string }; output: undefined }
  /** Saves the responsible document. The old text becomes a version (spec 002). */
  "workflows.document.save": { input: { id: string; text: string }; output: WorkflowDetail }
  "workflows.document.history": { input: { id: string }; output: readonly DocumentVersion[] }
  /** Restores a version of the document. A restore makes a new version (spec 002). */
  "workflows.document.restore": {
    input: { id: string; versionId: string }
    output: WorkflowDetail
  }
  /** Only the user changes the level and the folder of a workflow (spec 010). */
  "workflows.setPermission": { input: { id: string; level: PermissionLevel }; output: Workflow }
  "workflows.setFolder": { input: { id: string; folder: string }; output: Workflow }
  /** Opens the system folder dialog for the folder of the workflow. Cancel changes nothing. */
  "workflows.pickFolder": { input: { id: string }; output: Workflow }
  /** The graph editor (spec 010). Each change that is not a move keeps the graph as a version. */
  "workflows.node.add": { input: { workflowId: string; node: NodeInput }; output: WorkflowNode }
  "workflows.node.update": { input: { id: string; patch: NodePatch }; output: WorkflowNode }
  "workflows.node.move": { input: { id: string; x: number; y: number }; output: undefined }
  "workflows.node.remove": { input: { id: string }; output: undefined }
  "workflows.option.add": { input: { nodeId: string; label: string }; output: WorkflowNode }
  "workflows.option.rename": { input: { id: string; label: string }; output: WorkflowNode }
  "workflows.option.remove": { input: { id: string }; output: WorkflowNode }
  "workflows.connect": {
    input: { workflowId: string; from: string; to: string; optionId?: string | null }
    output: WorkflowConnection
  }
  "workflows.disconnect": { input: { id: string }; output: undefined }
  "workflows.versions": { input: { id: string }; output: readonly GraphVersion[] }
  /** Restores a version of the graph. The graph as it is now is kept as a version too. */
  "workflows.versions.restore": {
    input: { id: string; versionId: string }
    output: WorkflowGraph
  }
  /** The one chat of a workflow (spec 003). */
  "chat.history": { input: { workflowId: string }; output: WorkflowChatHistory }
  "chat.send": { input: WorkflowChatSend; output: WorkflowChatMessage }
  /** The user picks the account and the model that answer in the chat. It takes effect at the next turn. */
  "chat.setModel": {
    input: { workflowId: string; accountId: string; model: string }
    output: undefined
  }
  /** Stops the turn of the chat. It does not stop a run (spec 003, flow 2). */
  "chat.stop": { input: { workflowId: string }; output: undefined }
  /** Deletes a message that no turn has read, or a queued message. Gives back its text. */
  "chat.delete": { input: { id: string }; output: { text: string } }
  "chat.sendNow": { input: { id: string }; output: undefined }
  "chat.retry": { input: { workflowId: string }; output: undefined }
  /** The buttons of the notice after a restart: "Continue" and "Send again". */
  "chat.resume": { input: { workflowId: string; mode: "continue" | "again" }; output: undefined }
  "decision.status": { input: undefined; output: DecisionStatus }
  /** Saves or removes the keys that the patch names; a key that is not named stays. */
  "decision.keys": { input: DecisionKeys; output: DecisionStatus }
  /** Sends one real request with three made-up members to the saved choice. */
  "decision.test": { input: undefined; output: DecisionTestResult }
  /** Skills (spec 017). */
  "skills.list": { input: { serverId: string }; output: readonly Skill[] }
  /** A skill belongs to the server, not to one workflow (spec 017). */
  "skills.create": { input: SkillInput & { serverId: string }; output: Skill }
  /** Edit (spec 017, flow 2): every field of the form. The skill stays on or off as it was. */
  "skills.update": { input: SkillInput & { id: string }; output: Skill }
  /** Duplicate (spec 017, flow 3): `suffix` is the word "copy" in the language of the window. */
  "skills.duplicate": { input: { id: string; suffix: string }; output: Skill }
  "skills.setEnabled": { input: { id: string; enabled: boolean }; output: Skill }
  "skills.delete": { input: { id: string }; output: undefined }
}

/** A thread of an agent. `threadId` none or null is the main thread. */
export interface ThreadRef {
  workflowId: string
  threadId?: string | null
}

/** Events that the main process pushes to the renderer. */
export interface RpcEvents {
  "settings.changed": Settings
  /** The device name, the switch, the linked devices or a connection state changed. */
  "devices.changed": Record<string, never>
  "devices.pairing": PairingState
  /** A device asks to join (`request`), or an earlier request was decided (`closed`). */
  "devices.join": { request?: JoinRequest; closed?: string }
  /** The list of servers, or the state of one, changed. */
  "servers.changed": Record<string, never>
  "providers.changed": Record<string, never>
  /** A vendor program was found, downloaded, signed in to, or reports new limits. */
  "runtimes.changed": RuntimeStatus
  "actionLog.changed": Record<string, never>
  /** A permission rule was added, changed or deleted, or an agent with rules was deleted. */
  "rules.changed": Record<string, never>
  /** A connection was added, changed, turned on or off, tested, started, or removed (spec 018). */
  "connections.changed": Record<string, never>
  /** A saved secret was added, used, replaced or deleted. */
  "secrets.changed": Record<string, never>
  /** A browser profile was made, renamed or deleted, or an agent got another one. */
  "browserProfiles.changed": Record<string, never>
  /** A skill was made, turned on or off, or deleted. */
  "skills.changed": { serverId: string }
  "workflows.changed": { serverId: string }
  /** A message of a chat was added or changed (spec 003). */
  "chat.message": { workflowId: string; message: WorkflowChatMessage }
  /** The queue, the notice or the working state of a chat changed: read the history again. */
  "chat.state": { workflowId: string }
  /** `serverId` is set for a page of a linked server (spec 012): the window opens it first. */
  "app.openPage": { page: "workflows"; serverId?: string }
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
  /** `server` is the linked server that the call is for. Absent: this computer. */
  invoke<M extends RpcMethod>(
    method: M,
    input: RpcInput<M>,
    server?: string,
  ): Promise<RpcResult<RpcOutput<M>>>
  /** The full path of a file that the user dropped on the window. Empty when unknown. */
  pathForFile(file: File): string
  /**
   * `server` is the linked server that sent the event (spec 012). It is absent for an event of
   * this computer.
   */
  on<E extends RpcEvent>(
    event: E,
    listener: (payload: RpcEvents[E], server?: string) => void,
  ): () => void
}

export const INVOKE_CHANNEL = "robot:invoke"
export const EVENT_CHANNEL = "robot:event"
/**
 * The app screen tells the diagnostic report that a press, a click or a touch reached its
 * document: the kind of event, a place, the tag and the test id of the target. Never text.
 */
export const SCREEN_INPUT_CHANNEL = "robot:screen-input"
/** The kinds of event that the app screen reports on `SCREEN_INPUT_CHANNEL`. */
export const SCREEN_INPUT_TYPES: readonly string[] = ["pointerdown", "click", "touchstart"]
