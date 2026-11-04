import type { PermissionLevel } from "@robot/shared"
import type { BridgeHandler } from "../runtimes/bridge.ts"
import type { ApprovalRequest } from "../runtimes/types.ts"
import type { ToolOutcome } from "./agent.ts"
import type { CacheLifetime } from "./cache.ts"
import type { ToolCall, ToolDef, Turn } from "./chat.ts"
import type { Resume } from "./resume.ts"

/** A message that the user sent into the turn while it runs (spec 003). */
export interface JoinedMessage {
  /** The id of the message in the chat. A program that takes input gets it as the id of its input. */
  readonly id: string
  /** The text for the model: the quote, the text and the attached files of the message. */
  readonly text: string
}

/**
 * The messages that wait for the next step of the turn. A message that `take` gave is no longer in
 * the inbox: from then on it cannot be deleted. The turn tells when the agent read it with an
 * event `joined`.
 */
export interface TurnInbox {
  take(): readonly JoinedMessage[]
  /** Calls `ready` each time a new message comes. Returns the function that ends the calls. */
  watch(ready: () => void): () => void
}

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
  /**
   * More tools, read before each request of the turn: the tools of the connections of the agent,
   * and the tools it found by search (spec 018). API accounts only.
   */
  readonly moreTools?: () => readonly ToolDef[]
  /**
   * How long an Anthropic account keeps the start of the request ready: "long" for a turn that a
   * person starts in the chat. Absent means "short". It has no effect where the endpoint takes no
   * cache marker. API accounts only.
   */
  readonly cache?: CacheLifetime
  /** False when the turn may only answer in text. */
  readonly useTools: boolean
  /** Set when the turn goes on after a restart, at a card that waits (spec 005). API accounts only. */
  readonly resume?: Resume
  /**
   * The messages that the user sends while the turn runs. Absent when messages cannot join, for
   * example in a channel, or for a program that takes no input during a turn.
   */
  readonly inbox?: TurnInbox
}

/** How a turn reaches the user and the tools. */
export interface TurnHooks {
  /** Runs a tool of the app. An API account calls it. */
  readonly execute: (call: ToolCall) => Promise<ToolOutcome>
  /** Asks the user about a step of an agent runtime. */
  readonly approve: (request: ApprovalRequest) => Promise<boolean>
  /** The tools of the app that an agent runtime may call, the browser. It has no tools of its own for them. */
  readonly bridge?: BridgeHandler
}
