import type { PermissionLevel } from "@robot/shared"
import type { ApprovalRequest } from "../runtimes/types.ts"
import type { ToolOutcome } from "./agent.ts"
import type { ToolCall, ToolDef, Turn } from "./chat.ts"
import type { Resume } from "./resume.ts"

/** What one turn of an agent needs, whatever kind of account answers it. */
export interface TurnInput {
  readonly model: string
  readonly effort: string | null
  readonly system: string
  readonly turns: readonly Turn[]
  readonly signal: AbortSignal
  readonly workspace: string
  readonly permission: PermissionLevel
  /** The tools of the app, for an API account. */
  readonly tools?: readonly ToolDef[]
  /** False when the turn may only answer in text. */
  readonly useTools: boolean
  /** Set when the turn goes on after a restart, at a card that waits (spec 005). API accounts only. */
  readonly resume?: Resume
}

/** How a turn reaches the user and the tools. */
export interface TurnHooks {
  /** Runs a tool of the app. An API account calls it. */
  readonly execute: (call: ToolCall) => Promise<ToolOutcome>
  /** Asks the user about a step of an agent runtime. */
  readonly approve: (request: ApprovalRequest) => Promise<boolean>
}
