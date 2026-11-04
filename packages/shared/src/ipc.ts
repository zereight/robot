import type { AgentFileImported, AgentFilePreview } from "./agentFile.ts"
import type { InstructionVersion, SettingsLineState } from "./agentSettings.ts"
import type { Agent, AgentCreate, AgentModel, AgentPatch } from "./agents.ts"
import type { BrowserProfile, BrowserProfileCreate } from "./browserProfiles.ts"
import type {
  Channel,
  ChannelActivity,
  ChannelCreate,
  ChannelMessage,
  ChannelPatch,
} from "./channels.ts"
import type { ChatHistory, ChatMessage, ChatSend, QueuedMessage, QueueHold } from "./chat.ts"
import type { DecisionKeys, DecisionStatus, DecisionTestResult } from "./decision.ts"
import type { Handbook, HandbookVersion } from "./handbook.ts"
import type { HandoverOpen, HandoverState } from "./handover.ts"
import type { AgentPick, ImportChecklist } from "./importReview.ts"
import type { KeepAwakeState } from "./keepAwake.ts"
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
import type { ChartModel, OrgSnapshot } from "./orgChart.ts"
import type { ActionKind, ActionLogEntry, ActionResult } from "./outside.ts"
import type { MarkPlace, PlaceMarks } from "./placeMarks.ts"
import type {
  ModelInfo,
  ProviderAccount,
  ProviderConnect,
  ReadOnlySupport,
  RuntimeKind,
  RuntimeStatus,
  RuntimeTarget,
} from "./providers.ts"
import type { QuietState } from "./quiet.ts"
import type { Routine, RoutineEntry, RoutineInput, RoutinePatch } from "./routines.ts"
import type { PermissionRule, RuleDecision, RuleInput } from "./rules.ts"
import type { SearchPage } from "./search.ts"
import type { SavedSecret } from "./secrets.ts"
import type { MoveDirection, SectionCreate, UserSection } from "./sections.ts"
import type { Settings, SettingsPatch } from "./settings.ts"
import type { SkillDraftResult, SkillSourceRef } from "./skillDraft.ts"
import type { Skill, SkillInput } from "./skills.ts"
import type { AgentStarterCreate } from "./starters.ts"
import type { RetryResult } from "./steps.ts"
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
import type { TeamsLinkView, TeamsPatch } from "./teamsLink.ts"
import type { ChatMeter, ChatThread, ChatThreads } from "./threads.ts"
import type { TodaySnapshot } from "./today.ts"
import type {
  ConnectionSaveInput,
  ConnectionTestResult,
  ToolConnection,
  ToolConnectionInput,
} from "./toolConnections.ts"
import type { HeldToolView } from "./toolReview.ts"
import type { ApprovalAnswer } from "./tools.ts"
import type { PlaceKind, PlaceSection, Server, UiState, UiStatePatch } from "./ui.ts"
import type { UsageRange, UsageRow } from "./usage.ts"
import type { RecentWorkRow } from "./work.ts"
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
  /**
   * The bytes of a picture that a message holds (spec 003, flow 4), for the small picture above the
   * message. Null when the file is not a picture of a kind that shows, is not on this computer or
   * is not reachable now. A linked server sends the bytes over the link.
   */
  "attachments.picture": {
    input: { agentId: string; path: string; size: number; messageId: string }
    output: Uint8Array | null
  }
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
    input: { agentId: string; profileId: string | null }
    output: undefined
  }
  /**
   * The Teams link (spec 028): the form, the switch and the state. Only the window of this computer
   * calls these methods; a linked device cannot.
   */
  "teams.get": { input: undefined; output: TeamsLinkView }
  /** "Set up": makes the link with an empty form and the switch off. */
  "teams.setup": { input: undefined; output: TeamsLinkView }
  /** Changes fields of the form. The target, the title, the kind and the marker need the switch off. */
  "teams.update": { input: TeamsPatch; output: TeamsLinkView }
  /** The switch. A refusal leaves the switch off and lists the reasons in `problems`. */
  "teams.setEnabled": { input: { enabled: boolean }; output: TeamsLinkView }
  /** "Show the Teams page" and "Sign in to Teams". */
  "teams.showPage": { input: undefined; output: TeamsLinkView }
  "teams.hidePage": { input: undefined; output: TeamsLinkView }
  /** Where the Teams page shows, in CSS px of the app window, or `null` to hide it. */
  "teams.place": {
    input: { bounds: { x: number; y: number; width: number; height: number } | null }
    output: undefined
  }
  /** "Use this chat": the title of the chat that is open in the Teams page fills the form. */
  "teams.useChat": { input: undefined; output: TeamsLinkView }
  /** "Find in the chat": the names of the senders that the open chat shows. It changes nothing. */
  "teams.readSenders": { input: undefined; output: readonly string[] }
  /** "Resume": a paused link starts again with a baseline read (spec 028). */
  "teams.resume": { input: undefined; output: TeamsLinkView }
  /** "Sign out of Teams": deletes the saved sign-in and turns the link off. */
  "teams.signOut": { input: undefined; output: TeamsLinkView }
  /** "Remove link": deletes the link and the sign-in profile. */
  "teams.remove": { input: undefined; output: TeamsLinkView }
  "ui.get": { input: undefined; output: UiState }
  "ui.update": { input: UiStatePatch; output: UiState }
  "agents.list": { input: { serverId: string; archived: boolean }; output: readonly Agent[] }
  "agents.get": { input: { id: string }; output: Agent }
  "agents.create": { input: AgentCreate; output: Agent }
  /**
   * Makes an agent from the form with a starter picked. It also makes the paused routine and the
   * skill of the starter, as far as the limits allow. A note in the chat says what it did not
   * make (spec 002, "Starters"). A linked device cannot call it.
   */
  "agents.createFromStarter": { input: AgentStarterCreate; output: Agent }
  "agents.update": { input: { id: string; patch: AgentPatch }; output: Agent }
  "agents.duplicate": { input: { id: string; suffix: string }; output: Agent }
  "agents.archive": { input: { id: string }; output: Agent }
  /**
   * "Use the main model now" (spec 006, "Backup model"): ends the hold of the main model. The next
   * turn tries the main model. A linked device needs the switch "Can create and change agents".
   */
  "agents.useMain": { input: { id: string }; output: Agent }
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
  /** Asks where to save, then writes the archive. `path` is null when cancelled. */
  "data.export": { input: undefined; output: { path: string | null; files: number } }
  /** Asks for an archive, then restores it into an empty app. `null` when cancelled. */
  "data.restore": { input: undefined; output: { agents: number; messages: number } | null }
  /** The newest 500 tasks of a server. */
  "tasks.list": { input: { serverId: string }; output: readonly Task[] }
  "tasks.get": { input: { id: string }; output: TaskDetail }
  /**
   * The turns that are quiet now (spec 005, "Quiet line"), each with the seconds on its quiet
   * clock. In memory only. A linked device may call it when it connects.
   */
  "quiet.list": { input: undefined; output: QuietState }
  /**
   * The last 20 tasks of one agent, newest first, each with what it waits for (spec 002, "Recent
   * work"). A read: a linked device may call it.
   */
  "tasks.recent": { input: { agentId: string }; output: readonly RecentWorkRow[] }
  "tasks.stop": { input: { id: string }; output: undefined }
  /**
   * Moves a queued task of this computer to the front of the queue (spec 005, "Run next"). Not a
   * request that a linked device may call.
   */
  "tasks.runNext": { input: { id: string }; output: undefined }
  /**
   * Tries a task again. When the first try ran steps that may have changed things, the answer
   * holds the retry note and nothing starts. The same request with `confirmed` starts the task.
   */
  "tasks.retry": { input: { id: string; confirmed?: boolean }; output: RetryResult }
  /**
   * Ends the review of a part: it is done (spec 005). Only on the computer that owns the task, and
   * not a request that a linked device may call (spec 012).
   */
  "tasks.accept": { input: { id: string }; output: undefined }
  /**
   * Ends the review of a part as done and starts a new part for the same member with `text` as
   * its prompt (spec 005). The text has 1 to 2000 characters.
   */
  "tasks.requestChanges": { input: { id: string; text: string }; output: undefined }
  /** Cancels every task of the request of this task that is not final (spec 004, 005). */
  "tasks.endRequest": { input: { id: string }; output: undefined }
  "channels.list": { input: { serverId: string }; output: readonly Channel[] }
  "channels.create": { input: ChannelCreate; output: Channel }
  "channels.update": { input: { id: string; patch: ChannelPatch }; output: Channel }
  "channels.delete": { input: { id: string }; output: undefined }
  "channels.history": { input: { channelId: string }; output: readonly ChannelMessage[] }
  /** Posts a job. `awaiting` is true when the user has to pick the member who takes it. */
  "channels.send": {
    input: { channelId: string; text: string; replyTo?: string | null }
    output: { awaiting: boolean }
  }
  "channels.assign": {
    input: { channelId: string; messageId: string; agentId: string }
    output: undefined
  }
  /** Stops every running part and job of the channel. */
  "channels.stop": { input: { channelId: string }; output: undefined }
  "channels.activity": { input: { channelId: string }; output: ChannelActivity }
  "channels.markRead": { input: { channelId: string }; output: undefined }
  /**
   * The handbook of a server (spec 002, "Handbook"). A linked device reads it with no switch; it
   * changes it only with "Can create and change agents" (spec 012).
   */
  "handbook.get": { input: { serverId: string }; output: Handbook }
  /** The last 20 versions of the handbook, newest first. */
  "handbook.history": { input: { serverId: string }; output: readonly HandbookVersion[] }
  /** Saves a text as the handbook. A text that looks like a secret, or is too long, is refused. */
  "handbook.save": { input: { serverId: string; text: string }; output: Handbook }
  /** Makes the text of a version the handbook again. The restore is a new version. */
  "handbook.restore": { input: { serverId: string; versionId: string }; output: Handbook }
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
  /**
   * "Clear" on the header line of a place: removes the marks of the place for the next turns
   * (spec 007, "The mark of a place"). It gives back the marks that it removed. A linked device
   * and the phone cannot call it.
   */
  "placeMarks.clear": { input: { place: MarkPlace }; output: PlaceMarks }
  /** The action log of this computer, newest first (spec 007). It is not offered to a linked device. */
  "actionLog.list": {
    input: { agentId?: string; result?: ActionResult; kind?: ActionKind; search?: string }
    output: readonly ActionLogEntry[]
  }
  /**
   * The permission rules of this computer, newest first (spec 007). The rules page is for the
   * computer only: none of the rules methods is offered to a linked device (spec 012).
   */
  "rules.list": {
    input: { agentId?: string | null; decision?: RuleDecision }
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
  /**
   * The decision model (spec 013): whether a key is saved, never the key. Not offered to a linked
   * device: the keys stay on this computer.
   */
  "decision.status": { input: undefined; output: DecisionStatus }
  /** Saves or removes the keys that the patch names; a key that is not named stays. */
  "decision.keys": { input: DecisionKeys; output: DecisionStatus }
  /** Sends one real request with three made-up members to the saved choice. */
  "decision.test": { input: undefined; output: DecisionTestResult }
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
  /**
   * `suggest` is the reason that the agent gave when it asked the user to look at the browser, or
   * null. The browser stays hidden until the user chooses to see it.
   */
  "browser.state": {
    input: { agentId: string }
    output: { open: boolean; control: boolean; suggest: string | null }
  }
  /**
   * Whether the app holds this computer awake now, and why (spec 013, "Keep the computer awake").
   * A linked device never asks: the setting belongs to the computer.
   */
  "keepAwake.state": { input: undefined; output: KeepAwakeState }
  /** The user takes the controls of the agent's browser, or gives them back. */
  "browser.control": { input: { agentId: string; control: boolean }; output: undefined }
  "browser.close": { input: { agentId: string }; output: undefined }
  /** The user shows the browser, or says "Not now": the request of the agent to look goes away. */
  "browser.dismissSuggest": { input: { agentId: string }; output: undefined }
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
  /** Skills (spec 017). */
  "skills.list": { input: { serverId: string }; output: readonly Skill[] }
  /** The skills that an agent may use now: on, and for this agent or for all agents. */
  "skills.forAgent": { input: { agentId: string }; output: readonly Skill[] }
  /** The skills that are only for this agent. A delete of the agent deletes them too (002, 017). */
  "skills.onlyFor": { input: { agentId: string }; output: { count: number } }
  /** `agentIds` is the list of agents that may use the skill, or `null` for all agents. */
  "skills.create": {
    input: SkillInput & { serverId: string; agentIds: readonly string[] | null }
    output: Skill
  }
  /** Edit (spec 017, flow 2): every field of the form. The skill stays on or off as it was. */
  "skills.update": {
    input: SkillInput & { id: string; agentIds: readonly string[] | null }
    output: Skill
  }
  /** Duplicate (spec 017, flow 3): `suffix` is the word "copy" in the language of the window. */
  "skills.duplicate": { input: { id: string; suffix: string }; output: Skill }
  "skills.setEnabled": { input: { id: string; enabled: boolean }; output: Skill }
  "skills.delete": { input: { id: string }; output: undefined }
  /**
   * "Make a skill" from a task, an article or a memory item: one request to the model account of
   * the agent of the source (spec 017). It makes no task and no message. `requestId` names the
   * request, so that `skills.draftCancel` can drop it.
   */
  "skills.draft": {
    input: { requestId: string; source: SkillSourceRef }
    output: SkillDraftResult
  }
  "skills.draftCancel": { input: { requestId: string }; output: undefined }
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
  /** The org chart of this computer (spec 029). It reads local data only and sends nothing out. */
  "orgChart.get": { input: undefined; output: OrgSnapshot }
  /**
   * The org chart of a server as a ready model (spec 029, 012): the nodes, the order, the counts,
   * the states and the cut labels of the running tasks, and nothing else about tasks. A linked
   * computer and the phone ask this; it needs only the link. `serverId` is the server, as in
   * `workflows.list`.
   */
  "orgChart.model": { input: { serverId: string }; output: ChartModel }
  /**
   * Message search (spec 001): one page of the messages of a server that hold every word of the
   * text, newest first. A linked server answers it; while the link is offline the answer comes
   * from the saved messages and says so.
   */
  "messages.search": {
    input: { serverId: string; query: string; offset?: number }
    output: SearchPage
  }
  /**
   * Each chat method takes the thread (spec 003, "Threads"). None or null is the main thread. A
   * linked computer and the phone get the main thread only (011, 012).
   */
  "chat.history": { input: ThreadRef; output: ChatHistory }
  "chat.send": { input: ChatSend; output: { queued: boolean } }
  "chat.stop": { input: ThreadRef; output: undefined }
  /** As `tasks.retry`, for the failed reply of a chat. */
  "chat.retry": {
    input: ThreadRef & { messageId: string; confirmed?: boolean }
    output: RetryResult
  }
  "chat.edit": { input: ThreadRef & { messageId: string; text: string }; output: undefined }
  "chat.queue.update": {
    input: ThreadRef & { itemId: string; text: string }
    output: undefined
  }
  "chat.queue.remove": { input: ThreadRef & { itemId: string }; output: undefined }
  /** Sends a queued message into the turn that runs now (spec 003). */
  "chat.queue.sendNow": { input: ThreadRef & { itemId: string }; output: undefined }
  /** Deletes a message of the running turn that the agent did not read yet (spec 003). */
  "chat.unread.delete": { input: ThreadRef & { messageId: string }; output: undefined }
  "chat.markRead": { input: ThreadRef; output: undefined }
  /** The context meter of a thread and why Compact is off (spec 003). */
  "chat.meter": { input: ThreadRef; output: ChatMeter }
  /** Runs a manual compact of the thread (spec 003, "Compact"). It ends when the compact ends. */
  "chat.compact": { input: ThreadRef; output: undefined }
  /** The threads of an agent, for the list in the chat header (spec 003, "Threads"). */
  "chat.threads": { input: { agentId: string }; output: ChatThreads }
  "chat.thread.create": { input: { agentId: string }; output: ChatThread }
  /** A new thread with a copy of the conversation up to the message (spec 003, "Fork"). */
  "chat.thread.fork": { input: ThreadRef & { messageId: string }; output: ChatThread }
  "chat.thread.rename": {
    input: { agentId: string; threadId: string; title: string }
    output: undefined
  }
  "chat.thread.archive": {
    input: { agentId: string; threadId: string; archived: boolean }
    output: undefined
  }
  "chat.thread.delete": { input: { agentId: string; threadId: string }; output: undefined }
  /** Whether "Hand over" is on for a chat or thread, and why not (spec 003). This computer only. */
  "chat.handover.state": { input: ThreadRef; output: HandoverState }
  /** Writes the brief and lists the agents for the dialog of "Hand over" (spec 003). */
  "chat.handover.open": { input: ThreadRef; output: HandoverOpen }
  /**
   * Hands the chat over: a new thread in the chat of `toAgentId` with the card and the text (spec
   * 003). It stores the brief that `open` wrote under `briefId`. It gives the new thread.
   */
  "chat.handover.start": {
    input: ThreadRef & { toAgentId: string; text: string; briefId: string }
    output: { agentId: string; threadId: string }
  }
}

/** A thread of an agent. `threadId` none or null is the main thread. */
export interface ThreadRef {
  agentId: string
  threadId?: string | null
}

/** Events that the main process pushes to the renderer. */
export interface RpcEvents {
  "settings.changed": Settings
  /** The app holds the computer awake, or lets it go, or the reason changed. */
  "keepAwake.changed": KeepAwakeState
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
  /** The handbook of a server was saved or restored, here or by sync or a linked device (spec 002). */
  "handbook.changed": { serverId: string }
  "actionLog.changed": Record<string, never>
  /** A permission rule was added, changed or deleted, or an agent with rules was deleted. */
  "rules.changed": Record<string, never>
  /** A connection was added, changed, turned on or off, tested, started, or removed (spec 018). */
  "connections.changed": Record<string, never>
  /** A saved secret was added, used, replaced or deleted. */
  "secrets.changed": Record<string, never>
  /** An article, a source or the change list of an agent changed. */
  "knowledge.changed": { agentId: string }
  "browser.changed": { agentId: string }
  /** A browser profile was made, renamed or deleted, or an agent got another one. */
  "browserProfiles.changed": Record<string, never>
  /** The Teams link changed: its form, its switch, its state or its last read. */
  "teams.changed": Record<string, never>
  /** "Teach a task" started, recorded a step, paused, stopped, made a draft, or ended. */
  "teach.changed": TeachState
  /** A skill was made, turned on or off, or deleted. */
  "skills.changed": { serverId: string }
  "routines.changed": { serverId: string }
  "workflows.changed": { serverId: string }
  "workflows.run": { runId: string }
  "island.state": IslandState
  /**
   * A turn became quiet, or went on, or ended (spec 005, "Quiet line"): all turns that are quiet
   * now, with their seconds at this moment. A window counts on from there. It does not come each
   * second.
   */
  "quiet.changed": QuietState
  /** The Today page changed: the whole page, so the window needs no second request. */
  "today.changed": TodaySnapshot
  /** The org chart changed: the whole snapshot, so the window needs no second request (spec 029). */
  "orgChart.changed": OrgSnapshot
  /**
   * The org chart of a linked server changed: its whole ready model (spec 029, 012). A server
   * pushes it to its linked devices. This computer sends it to no window of its own, so a window
   * gets it only with the id of the linked server that sent it.
   */
  "orgChart.model": ChartModel
  "app.openPlace": PlaceTarget
  /** `serverId` is set for a page of a linked server (spec 012): the window opens it first. */
  "app.openPage": { page: "workflows" | "teams"; serverId?: string }
  "notifications.changed": Record<string, never>
  /** The members, the plan steps or the state of a channel changed. */
  "channels.changed": { channelId: string }
  "channel.message": ChannelMessage
  "channel.removed": { channelId: string; messageId: string }
  /** A new or changed message. While a reply streams, this comes many times. */
  "chat.message": ChatMessage
  "chat.removed": { agentId: string; messageId: string }
  "chat.queue": {
    agentId: string
    threadId?: string | null
    queue: readonly QueuedMessage[]
    hold: QueueHold | null
  }
  /** The meter or the compact state of a thread changed: the window reads `chat.meter` again. */
  "chat.meter": { agentId: string; threadId: string | null }
  /** A thread was made, renamed, archived, restored or deleted, or its unread count changed. */
  "chat.threads": { agentId: string }
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
