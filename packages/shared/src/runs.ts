import type { TaskProgress } from "./chat.ts"
import type { OutsideSource } from "./outside.ts"
import type { SensitiveLabel } from "./sensitive.ts"
import type { TaskUsage } from "./taskUsage.ts"
import type { PermissionLevel } from "./tools.ts"

// The run of a workflow and its tasks (spec 010, 005), for the run list, the run view and the
// cards in the chat (007, 003). The words of the states are the words of spec 005.

/** Where a run came from (spec 005, "Tasks page"). The schedule is not built (docs/spec-questions.md). */
export const RUN_SOURCES = ["hand", "chat", "schedule"] as const
export type RunSource = (typeof RUN_SOURCES)[number]

/** The states of a task (spec 005). A run follows its tasks. */
export const TASK_STATES = [
  "queued",
  "running",
  "waiting",
  "done",
  "failed",
  "blocked",
  "cancelled",
] as const
export type TaskState = (typeof TASK_STATES)[number]

/** A task in one of these states has ended. */
export const TASK_ENDED: readonly string[] = ["done", "failed", "blocked", "cancelled"]

/** The most queued runs of one workflow (spec 005, "Queue"). */
export const RUN_QUEUE_MAX = 20
/** How many times a model call is tried, and the wait between two tries (spec 010, "Rules"). */
export const MODEL_TRIES = 3
export const MODEL_RETRY_WAIT_MS = 2000
/** The reason of a "Blocked:" line is cut at this many characters (spec 005). */
export const BLOCKED_REASON_MAX = 200

/**
 * The codes of a reason, as the run view and the chat translate them. The English text of the
 * reason is stored beside the code. A code with a number has the form `silent:10`.
 */
export const REASON_RESTART = "restart"
export const REASON_STOPPED = "user"
export const REASON_RUN_STOPPED = "run"

/** One task of a run: the execution of one node (spec 005). */
export interface RunTask {
  readonly id: string
  readonly retryOf: string | null
  readonly state: TaskState
  /** `queued` and `waiting` and `cancelled`: the code of the reason. `failed`: see `reasonText`. */
  readonly reasonCode: string | null
  /** The reason in English words. The window translates the codes that it knows. */
  readonly reasonText: string | null
  readonly input: string
  /** What the node made so far. A failed or cancelled task keeps the part it made. */
  readonly result: string
  readonly progress: TaskProgress
  readonly keptGoing: number
  readonly usage: TaskUsage
  readonly createdAt: number
  readonly startedAt: number | null
  readonly firstReplyAt: number | null
  readonly endedAt: number | null
  readonly finishedAt: number | null
  /** A decision node: the probability of each option, and the option taken. */
  readonly decision: {
    readonly options: readonly { readonly label: string; readonly probability: number }[]
    readonly taken: string | null
  } | null
  /** The first source of outside content, when the task holds it (spec 007). */
  readonly outside: OutsideSource | null
  readonly program: boolean
  /** The label of the first credential place that the task read, or none. */
  readonly sensitive: SensitiveLabel | null
  /** The steps (tool calls) that the task took. */
  readonly steps: number
  /** What the task did with the memory: items it saved, facts it suggested (spec 008, "Flows", 1). */
  readonly memory: readonly TaskMemoryLine[]
}

/** A muted line of the run view: "Saved to memory" with its undo, or "Suggested for memory" with "Review". */
export interface TaskMemoryLine {
  readonly kind: "saved" | "suggested"
  readonly text: string
  /** The row of the memory history that the undo control reads. */
  readonly historyId: string | null
  readonly canUndo: boolean
  readonly proposalId: string | null
}

export interface RunNode {
  readonly number: number
  readonly name: string
  readonly kind: "text" | "decision"
  /** The state of the node in this run: a task state, "skipped" or "not_reached". */
  readonly state: TaskState | "skipped" | "not_reached"
  /** The newest task of the node, or null when the node has no task (spec 005). */
  readonly task: RunTask | null
}

export interface RunFeedback {
  readonly id: string
  readonly text: string
  readonly nodeNumber: number | null
  readonly createdAt: number
  /** The numbers of the text nodes that get it with their input. */
  readonly nodes: readonly number[]
}

export interface RunSummary {
  readonly id: string
  readonly workflowId: string
  /** The state of a run follows its tasks: the words of spec 005. */
  readonly state: TaskState
  readonly source: RunSource
  readonly triggerText: string
  readonly reasonCode: string | null
  readonly reasonText: string | null
  readonly startedAt: number
  readonly finishedAt: number | null
  /** The number of nodes that ended (done, failed, blocked, cancelled or skipped), and all nodes. */
  readonly ended: number
  readonly total: number
}

export interface RunDetail extends RunSummary {
  readonly nodes: readonly RunNode[]
  readonly feedback: readonly RunFeedback[]
  readonly usage: TaskUsage
  /** The number of the node whose failure or block stopped the run, when one did. */
  readonly stoppedAt: number | null
}

/** A card in the chat that waits for the user, or that the user answered (spec 007, 003). */
export interface RunCard {
  readonly id: string
  readonly workflowId: string
  /** The run and the task of the card. Null for a card of the chat (guarded feedback). */
  readonly runId: string | null
  readonly taskId: string | null
  readonly nodeNumber: number | null
  readonly nodeName: string | null
  /** approval: Allow and Deny. question: the node asks. pick: a decision node found no winner. */
  readonly kind: "approval" | "question" | "pick"
  /** What the node wants to do: the command, the path, the host, the question, the feedback text. */
  readonly summary: string
  /** The kind of step of an approval card, for the rules; "feedback" for the chat. */
  readonly step: "file" | "shell" | "web" | "feedback" | "ask" | "memory" | "change" | null
  /** True when the card has Allow once and Deny only (no "Always allow"). */
  readonly once: boolean
  /** The first source of outside content, when the card says that the turn or task holds it. */
  readonly outside: OutsideSource | null
  /** "turn" for a card of the chat, "task" for a card of a node. */
  readonly scope: "turn" | "task"
  /** The label of a credential place, when the card says that the task read one (spec 007). */
  readonly sensitive: SensitiveLabel | null
  /** True when a rule that the app cannot read stopped the step (spec 007). */
  readonly unreadable: boolean
  readonly choices: readonly string[]
  /** A pick card: the options with the probability the model gave, when it gave one. */
  readonly options: readonly {
    readonly id: string
    readonly label: string
    readonly probability: number | null
  }[]
  /** Why a decision node asks: `threshold`, `timeout`, `off` or `invalid`. */
  readonly pickReason: string | null
  readonly threshold: number | null
  readonly createdAt: number
  readonly answeredAt: number | null
  /** The answer that closed the card: allow, always, deny, an option id, the text, or "stopped". */
  readonly answer: string | null
  /** True when a message in the chat answered a question card. */
  readonly answeredInChat: boolean
}

/** The answer to a card. */
export type CardAnswer =
  | { readonly kind: "approval"; readonly answer: "allow" | "always" | "deny" }
  | { readonly kind: "question"; readonly text: string }
  | { readonly kind: "pick"; readonly optionId: string }

/** The marks of a place that the header of the chat shows (spec 007, "The mark of a place"). */
export interface ChatMarks {
  readonly outside: OutsideSource | null
  readonly program: boolean
  readonly sensitive: SensitiveLabel | null
}

export interface RunStart {
  readonly workflowId: string
  /** The text that started the run: `{{trigger}}` (spec 010). */
  readonly trigger?: string
}

/** What the run view needs to say about the levels a run uses (spec 007). */
export interface RunLevel {
  readonly workflow: PermissionLevel
}

/** The words of the one line "joined" results of the nodes before a node (spec 010). */
export const INPUT_SEPARATOR = "\n\n"

/** The instruction line that every text node gets (spec 005, "Blocked"). */
export const BLOCKED_PREFIX = "Blocked:"

/**
 * The reason of a task whose last line starts with "Blocked:", or null (spec 005). The match
 * ignores the case of the letters. The reason is cut at 200 characters.
 */
export const blockedReason = (result: string): string | null => {
  const lines = result.split("\n").map((l) => l.trim())
  let last = ""
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] !== "") {
      last = lines[i] ?? ""
      break
    }
  }
  if (!last.toLowerCase().startsWith(BLOCKED_PREFIX.toLowerCase())) return null
  return last.slice(BLOCKED_PREFIX.length).trim().slice(0, BLOCKED_REASON_MAX)
}
