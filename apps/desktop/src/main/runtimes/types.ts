import type { ModelInfo, PermissionLevel, RuntimeLimit } from "@robot/shared"
import type { BridgeAccess } from "./bridge.ts"

/** A step that the vendor program wants to take, and that may need the user's answer. */
export interface ApprovalRequest {
  readonly callId: string
  /** True when the step is risky by the rules of the app. */
  readonly risky: boolean
  /** The "always allow" key. Equal keys count as one rule. */
  readonly key: string
  /** What the card shows. */
  readonly summary: string
}

/** One turn for a vendor program. */
export interface RuntimeRun {
  /** Full path of the program. */
  readonly bin: string
  readonly model: string
  readonly effort: string | null
  /** The instructions of the agent. */
  readonly system: string
  /** The conversation so far, and the new message, as one text. */
  readonly prompt: string
  readonly workspace: string
  readonly permission: PermissionLevel
  /** False when the program may only answer: no files, no commands. */
  readonly useTools: boolean
  /** How the program reaches the tools of the app, the browser of the agent. */
  readonly bridge?: BridgeAccess
  readonly signal: AbortSignal
  /**
   * The folder of a separate sign-in, for a program that can have one. Absent: the program uses
   * the sign-in that it has on this computer.
   */
  readonly signInDir?: string
  /** Asks the user when the permission level needs it. Resolves true to go on. */
  readonly approve: (request: ApprovalRequest) => Promise<boolean>
  /** Called when the vendor reports the usage windows of the plan. */
  readonly onLimits: (limits: readonly RuntimeLimit[]) => void
}

/** Who is signed in to a program, as the program tells it. */
export interface Login {
  readonly signedIn: boolean
  readonly method: "subscription" | "api_key" | null
  readonly user: string | null
  readonly plan: string | null
  /** The usage windows, when the program tells them without a turn. */
  readonly limits?: readonly RuntimeLimit[]
  /** The models, when the program has a list. */
  readonly models?: readonly ModelInfo[]
}
