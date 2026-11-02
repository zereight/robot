/**
 * Sync between two computers (spec 019): the shapes that the main process and the window share.
 * The wire format of the changes is private to the main process; the window only sees states.
 */

/** The kinds of item that sync. A kind is a family of rows with the same fields. */
export const SYNC_KINDS = [
  "account",
  "agent",
  "channel",
  "memory",
  "message",
  "cmessage",
  "routine",
  "workflow",
  "task",
  "rskip",
  "wrun",
  "wstep",
] as const
export type SyncKind = (typeof SYNC_KINDS)[number]

export const isSyncKind = (value: unknown): value is SyncKind =>
  typeof value === "string" && (SYNC_KINDS as readonly string[]).includes(value)

/** How the user starts a sync (spec 019, Turn sync on, step 2). */
export const SYNC_MODES = ["merge", "take", "send"] as const
export type SyncMode = (typeof SYNC_MODES)[number]

/** What one computer holds, for the start dialog. */
export interface SyncCounts {
  readonly agents: number
  readonly channels: number
  readonly messages: number
}

/** The kinds that a user knows by name. Only these count in "items that would be removed". */
export const COUNTED_KINDS: readonly SyncKind[] = [
  "agent",
  "channel",
  "memory",
  "message",
  "cmessage",
  "routine",
  "workflow",
]

export interface SyncPreview {
  readonly peerName: string
  readonly here: SyncCounts
  readonly there: SyncCounts
  /** Items only this computer has. "Use the data of <name> here" removes them. */
  readonly onlyHere: number
  /** Items only the other computer has. "Send my data to <name>" removes them there. */
  readonly onlyThere: number
  /** True when the link goes one way: the other computer will also be able to open this one. */
  readonly oneWay: boolean
}

/** The state of the sync row of one linked computer (spec 019, States). */
export type SyncRowState =
  | "off"
  | "offered"
  | "copying"
  | "live"
  | "waiting"
  | "paused"
  | "attention"

export type SyncAttention = "update_this" | "update_other" | "clock" | "deletions"

export interface SyncStatus {
  /** The id of the link (the linked device). */
  readonly linkId: string
  readonly state: SyncRowState
  readonly attention: SyncAttention | null
  /** For `waiting`: this computer has "Let other devices connect" off. */
  readonly ownSwitchOff: boolean
  readonly mode: SyncMode | null
  /** Items copied so far, and items to copy. Both directions count together. */
  readonly done: number
  readonly total: number
  readonly lastSyncedAt: number | null
  /** The other computer did not allow the last request. */
  readonly denied: boolean
  /** The other computer stopped the sync; the user has not closed the line yet. */
  readonly stoppedBy: boolean
  /** The other clock is off by this many minutes, when `attention` is `clock`. */
  readonly clockMinutes: number
  /** For `attention` = `deletions`: how many agents and channels wait for a decision. */
  readonly deletions: number
}

/** A request from the other computer, shown as "Sync with <name>?". */
export interface SyncRequest {
  readonly id: string
  readonly name: string
  readonly mode: SyncMode
  readonly here: SyncCounts
  readonly there: SyncCounts
  /** Items this computer drops if the user allows. */
  readonly drops: number
}

export interface SyncChangeEntry {
  readonly id: number
  readonly at: number
  readonly kind: SyncKind
  readonly name: string
  /** What happened: added, changed or deleted. */
  readonly action: "added" | "changed" | "deleted"
  /** For a deleted agent: the path of its workspace folder, which stays on disk. */
  readonly detail: string
}

/** A group of deletions that wait for the user (spec 019, Delete). */
export interface SyncGuard {
  readonly peerName: string
  readonly count: number
}

export const CLOCK_WARN_MS = 5 * 60 * 1000
export const SYNC_BACKUPS_KEEP = 3
export const SYNC_CHANGES_MAX = 100
/** Deletion records live this long, so a long offline time still deletes (spec: at least 90 days). */
export const TOMBSTONE_KEEP_MS = 180 * 24 * 60 * 60 * 1000
/** A sync that would delete this many agents and channels on one computer asks first. */
export const GUARD_DELETE_MIN = 5
/** How long the user has to answer "Sync with <name>?". */
export const SYNC_DECISION_MS = 120_000

/** The version of the sync protocol. Two computers with another version wait for an update. */
export const SYNC_WIRE = 1
/** The most ids in one answer of a list of ids. */
export const SYNC_IDS_PAGE = 2000
