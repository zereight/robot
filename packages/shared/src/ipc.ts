import type { AgentFileImported, AgentFilePreview } from "./agentFile.ts"
import type { InstructionVersion, SettingsLineState } from "./agentSettings.ts"
import type { Agent, AgentCreate, AgentModel, AgentPatch } from "./agents.ts"
import type {
  Channel,
  ChannelActivity,
  ChannelCreate,
  ChannelMessage,
  ChannelPatch,
} from "./channels.ts"
import type { ChatHistory, ChatMessage, ChatSend, QueuedMessage, QueueHold } from "./chat.ts"
import type { AgentPick, ImportChecklist } from "./importReview.ts"
import type {
  KnowledgeArticle,
  KnowledgeChange,
  KnowledgeFindings,
  KnowledgeView,
} from "./knowledge.ts"
import type {
  ConnectProbe,
  DevicesState,
  JoinRequest,
  ModelChoice,
  NearbyComputer,
  PairingState,
  ServerEntry,
  WireNotice,
} from "./link.ts"
import type { MemoryHistoryRow, MemoryItem, MemoryMode, MemoryProposal } from "./memory.ts"
import type { IslandState, Mute, MuteChoice, PlaceTarget } from "./notifications.ts"
import type { ActionLogEntry, ActionResult } from "./outside.ts"
import type {
  ModelInfo,
  ProviderAccount,
  ProviderConnect,
  ReadOnlySupport,
  RuntimeKind,
  RuntimeStatus,
  RuntimeTarget,
} from "./providers.ts"
import type { Routine, RoutineEntry, RoutineInput, RoutinePatch } from "./routines.ts"
import type { SearchPage } from "./search.ts"
import type { SavedSecret } from "./secrets.ts"
import type { MoveDirection, SectionCreate, UserSection } from "./sections.ts"
import type { Settings, SettingsPatch } from "./settings.ts"
import type { Skill, SkillInput } from "./skills.ts"
import type {
  SyncChangeEntry,
  SyncGuard,
  SyncMode,
  SyncPreview,
  SyncRequest,
  SyncStatus,
} from "./sync.ts"
import type { Task, TaskDetail } from "./task.ts"
import type { TeachState } from "./teach.ts"
import type { TodaySnapshot } from "./today.ts"
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
  /** This computer, then the linked computers it can open, with their connection states. */
  "servers.list": { input: undefined; output: readonly Server[] }
  /** Tries a linked server at once, when it is not online. */
  "servers.retry": { input: { serverId: string }; output: undefined }
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
  /** Ends the link to a computer that this computer can open. Deletes its cache. */
  "devices.server.remove": { input: { id: string }; output: undefined }
  "devices.server.setAddresses": {
    input: { id: string; addresses: readonly string[] }
    output: ServerEntry
  }
  /**
   * First step of "Connect to a computer": proves the code to the computer. Give a link text, or
   * an address and a code.
   */
  "devices.connect.probe": {
    input: { link?: string | undefined; address?: string | undefined; code?: string | undefined }
    output: ConnectProbe
  }
  /** Second step: asks the computer to allow this device. Ends when the user there decided. */
  "devices.connect.finish": {
    input: { session: string; twoWay: boolean }
    output: ServerEntry
  }
  "devices.connect.cancel": { input: { session: string }; output: undefined }
  /** Computers on this network that show a pairing code now. */
  "devices.nearby": { input: undefined; output: readonly NearbyComputer[] }
  /** The sync row of each computer this computer can open (spec 019). */
  "sync.list": { input: undefined; output: readonly SyncStatus[] }
  /** What both computers hold, for the start dialog. The other computer must be online. */
  "sync.preview": { input: { linkId: string }; output: SyncPreview }
  /** Asks the other computer to sync. Ends when the other user decided, or the user cancelled. */
  "sync.start": { input: { linkId: string; mode: SyncMode }; output: SyncStatus }
  /** Cancels a request that waits for Allow. */
  "sync.cancelOffer": { input: { linkId: string }; output: undefined }
  "sync.pause": { input: { linkId: string }; output: undefined }
  "sync.resume": { input: { linkId: string }; output: undefined }
  /** Stops syncing. Both computers keep all their data. */
  "sync.stop": { input: { linkId: string }; output: undefined }
  /** Closes the "<name> stopped syncing" or "did not allow" line. */
  "sync.dismiss": { input: { linkId: string }; output: undefined }
  /** Requests from other computers that wait for Allow or Deny. */
  "sync.requests": { input: undefined; output: readonly SyncRequest[] }
  "sync.decide": { input: { id: string; allow: boolean }; output: undefined }
  /** The newest 100 changes that came from the other computer. */
  "sync.changes": { input: undefined; output: readonly SyncChangeEntry[] }
  /** Deletions that wait for a decision (spec 019, Delete). */
  "sync.guard": { input: undefined; output: SyncGuard | null }
  "sync.guard.decide": { input: { remove: boolean }; output: undefined }
  /** True when the file of a message is on this computer. */
  "sync.file.here": {
    input: { agentId: string; path: string; size: number; messageId: string }
    output: boolean
  }
  /** Opens the file of a message. A file that is not here is copied from the origin first. */
  "sync.file.open": {
    input: { agentId: string; path: string; size: number; messageId: string }
    output: undefined
  }
  "places.list": { input: { serverId: string }; output: readonly PlaceSection[] }
  /** Saves a file of a message of a linked server to this computer. Asks where to save it. */
  "attachments.save": {
    input: { agentId: string; path: string; name: string }
    output: { saved: boolean }
  }
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
  /** The versions of the instructions of an agent, newest first (spec 002). */
  "agents.history.list": { input: { agentId: string }; output: readonly InstructionVersion[] }
  /** Makes the text of a version the instructions again. The restore is a new version. */
  "agents.history.restore": { input: { agentId: string; versionId: string }; output: Agent }
  /** Whether the line of a change from the chat can still undo it (spec 002). */
  "agents.settings.line": {
    input: { agentId: string; messageId: string; callId: string }
    output: SettingsLineState
  }
  /** Puts back the values from before a change from the chat. */
  "agents.settings.undo": {
    input: { agentId: string; messageId: string; callId: string }
    output: undefined
  }
  "agents.setFaceImage": { input: { id: string; dataUrl: string | null }; output: Agent }
  /** Asks where to save, then writes one agent file. `path` is null when cancelled. */
  "agentFile.export": {
    input: { serverId: string; agentIds: readonly string[] }
    output: { path: string | null; count: number }
  }
  /** Asks for an agent file and reads it. `null` when cancelled. Nothing is made yet. */
  "agentFile.open": { input: { serverId: string }; output: AgentFilePreview | null }
  /**
   * Makes the agents of the file that `agentFile.open` read that the user ticked, all with this
   * model. Each new agent with something left to do gets a checklist.
   */
  "agentFile.apply": {
    input: { serverId: string; model: AgentModel | null; pick: readonly AgentPick[] }
    output: AgentFileImported
  }
  /** The checklist that an import left in the chat of this agent, or null (spec 014). */
  "checklists.forAgent": { input: { agentId: string }; output: ImportChecklist | null }
  /** The checklist that an import left at the top of this workflow, or null (spec 014). */
  "checklists.forWorkflow": { input: { workflowId: string }; output: ImportChecklist | null }
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
  "providers.models": { input: { accountId: string }; output: readonly ModelInfo[] }
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
  /** "Save at once" or "Ask me first" for one agent (spec 008). Not for a linked device. */
  "memory.mode": { input: { agentId: string }; output: MemoryMode }
  "memory.setMode": { input: { agentId: string; mode: MemoryMode }; output: undefined }
  /** The proposals of an agent, oldest first. */
  "memory.proposals": { input: { agentId: string }; output: readonly MemoryProposal[] }
  /** Makes an item of a proposal. `text` is the edited text of "Edit and save". */
  "memory.proposal.accept": { input: { id: string; text?: string }; output: MemoryItem }
  "memory.proposal.dismiss": { input: { id: string }; output: undefined }
  /** The changes to the memory of an agent, newest first. */
  "memory.history": { input: { agentId: string }; output: readonly MemoryHistoryRow[] }
  /** One row, for the line in the chat. Undefined when retention removed it. */
  "memory.history.get": { input: { id: string }; output: MemoryHistoryRow | undefined }
  "memory.undo": { input: { id: string }; output: undefined }
  /** The action log of this computer, newest first (spec 007). It is not offered to a linked device. */
  "actionLog.list": {
    input: { agentId?: string; result?: ActionResult }
    output: readonly ActionLogEntry[]
  }
  /**
   * The saved secrets of this computer (spec 020), never a value. Not offered to a linked device,
   * and a value never goes over a link.
   */
  "secrets.list": { input: { agentId?: string }; output: readonly SavedSecret[] }
  /**
   * Answers a protected card of this computer: `value` saves it in the keychain, `null` cancels.
   * The answer of a linked device or of the other computer of a sync pair is refused.
   */
  "secrets.answer": {
    input: { agentId: string; callId: string; value: string | null }
    output: undefined
  }
  /** Puts a new value for a saved secret in the keychain. */
  "secrets.replace": { input: { id: string; value: string }; output: SavedSecret }
  /** Deletes a saved secret and its value. */
  "secrets.delete": { input: { id: string }; output: undefined }
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
  /**
   * The chat screen says where the browser of the agent shows, in CSS px of the app window. `null`
   * hides it, for example when the screen shows another chat or a dialog covers the place.
   */
  "browser.place": {
    input: {
      agentId: string
      bounds: { x: number; y: number; width: number; height: number } | null
    }
    output: undefined
  }
  /** "Teach a task" (spec 017). One recording at a time on this computer. */
  "teach.state": { input: undefined; output: TeachState }
  "teach.start": { input: { agentId: string; result: string }; output: TeachState }
  /** Opens an address in the browser that the user teaches with. */
  "teach.open": { input: { url: string }; output: undefined }
  "teach.pause": { input: { paused: boolean }; output: undefined }
  /** Ends the recording and asks for a draft. `empty` is true when no step was recorded. */
  "teach.stop": { input: undefined; output: { empty: boolean } }
  "teach.cancel": { input: undefined; output: undefined }
  "teach.retry": { input: undefined; output: undefined }
  "teach.save": { input: SkillInput; output: Skill }
  "teach.discard": { input: undefined; output: undefined }
  "routines.list": { input: { serverId: string }; output: readonly Routine[] }
  "routines.create": { input: RoutineInput; output: Routine }
  "routines.update": { input: { id: string; patch: RoutinePatch }; output: Routine }
  "routines.delete": { input: { id: string }; output: undefined }
  /** Moves a routine of the other computer here: it runs here from now on (spec 019). */
  "routines.runHere": { input: { id: string }; output: Routine }
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
  /** Moves a workflow of the other computer here: it runs here from now on (spec 019). */
  "workflows.runHere": { input: { id: string }; output: Workflow }
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
  /**
   * Makes the workflows of the file that `workflowFile.open` read that the user ticked (`pick`:
   * their places in the file, from 0). All of them are off.
   */
  "workflowFile.apply": {
    input: { serverId: string; pick: readonly number[] }
    output: WorkflowFileImported
  }
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
  /** The result card has ended: its time is over and the pointer is not on it. */
  "island.dismissResult": { input: { id: number }; output: undefined }
  /** The size that the island content needs, in px. The island window takes this size. */
  "island.fit": { input: { width: number; height: number }; output: undefined }
  "usage.summary": {
    input: { serverId: string; days: UsageRange }
    output: readonly UsageRow[]
  }
  /** The Today page of this computer (spec 021). It reads local data only and sends nothing out. */
  "today.get": { input: undefined; output: TodaySnapshot }
  /**
   * Message search (spec 001): one page of the messages of a server that hold every word of the
   * text, newest first. A linked server answers it; while the link is offline the answer comes
   * from the saved messages and says so.
   */
  "messages.search": {
    input: { serverId: string; query: string; offset?: number }
    output: SearchPage
  }
  "chat.history": { input: { agentId: string }; output: ChatHistory }
  "chat.send": { input: ChatSend; output: { queued: boolean } }
  "chat.stop": { input: { agentId: string }; output: undefined }
  "chat.retry": { input: { agentId: string; messageId: string }; output: undefined }
  "chat.edit": { input: { agentId: string; messageId: string; text: string }; output: undefined }
  "chat.queue.update": {
    input: { agentId: string; itemId: string; text: string }
    output: undefined
  }
  "chat.queue.remove": { input: { agentId: string; itemId: string }; output: undefined }
  /** Sends a queued message into the turn that runs now (spec 003). */
  "chat.queue.sendNow": { input: { agentId: string; itemId: string }; output: undefined }
  /** Deletes a message of the running turn that the agent did not read yet (spec 003). */
  "chat.unread.delete": { input: { agentId: string; messageId: string }; output: undefined }
  "chat.markRead": { input: { agentId: string }; output: undefined }
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
  /** The sync row of a computer, a request to sync, or the change list changed. */
  "sync.changed": Record<string, never>
  /** A request to sync waits (`request`), or an earlier one ended (`closed`). */
  "sync.request": { request?: SyncRequest; closed?: string }
  /** A notice for a linked device. Windows ignore it; the link pushes it. */
  notice: WireNotice
  "places.changed": { serverId: string }
  /** `serverId` is "*" when agents of every server may have changed. */
  "agents.changed": { serverId: string }
  "providers.changed": Record<string, never>
  /** A vendor program was found, downloaded, signed in to, or reports new limits. */
  "runtimes.changed": RuntimeStatus
  "tasks.changed": { serverId: string }
  "memory.changed": { agentId: string }
  "actionLog.changed": Record<string, never>
  /** A saved secret was added, used, replaced or deleted. */
  "secrets.changed": Record<string, never>
  /** An article, a source or the change list of an agent changed. */
  "knowledge.changed": { agentId: string }
  "browser.changed": { agentId: string }
  /** "Teach a task" started, recorded a step, paused, stopped, made a draft, or ended. */
  "teach.changed": TeachState
  "routines.changed": { serverId: string }
  "workflows.changed": { serverId: string }
  "workflows.run": { runId: string }
  "island.state": IslandState
  /** The Today page changed: the whole page, so the window needs no second request. */
  "today.changed": TodaySnapshot
  "app.openPlace": PlaceTarget
  /** `serverId` is set for a page of a linked server (spec 012): the window opens it first. */
  "app.openPage": { page: "workflows"; serverId?: string }
  "notifications.changed": Record<string, never>
  /** The members, the plan steps or the state of a channel changed. */
  "channels.changed": { channelId: string }
  "channel.message": ChannelMessage
  "channel.removed": { channelId: string; messageId: string }
  /** A new or changed message. While a reply streams, this comes many times. */
  "chat.message": ChatMessage
  "chat.removed": { agentId: string; messageId: string }
  "chat.queue": { agentId: string; queue: readonly QueuedMessage[]; hold: QueueHold | null }
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
  on<E extends RpcEvent>(event: E, listener: (payload: RpcEvents[E]) => void): () => void
}

export const INVOKE_CHANNEL = "robot:invoke"
export const EVENT_CHANNEL = "robot:event"
