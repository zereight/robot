import {
  connectionToolLabel,
  fileAccess,
  type LoggedStep,
  loggedKind,
  type MessagePart,
  stepTarget,
} from "@robot/shared"
import type { AgentEvent } from "../providers/agent.ts"

/**
 * Watches the steps of one turn (spec 005, 007). One tool call is one step; for an agent on a
 * vendor runtime one tool card is one step. The watch
 *
 * - counts the steps that ended, and stops the turn when the count reaches the step limit,
 * - adds each step of the kinds that the action log lists to the log, and
 * - adds the steps that were still running when the turn ended, with the result Stopped.
 */
export interface StepWatch {
  /**
   * Call for each event of the turn, after the event changed the parts of the reply. `parts` are
   * those parts: a step that a vendor program asked about and the level refused has its mark there.
   */
  see(event: AgentEvent, parts?: readonly MessagePart[]): void
  /** Call once when the turn has ended. */
  end(parts: readonly MessagePart[]): void
  /** True when the turn was stopped because it reached the step limit. */
  readonly hit: boolean
}

export interface StepWatchOptions {
  readonly limit: number
  /** The steps that ended in an earlier part of the same task, for a turn that goes on after a restart. */
  readonly before: number
  /** Called once, when the step limit is reached. It ends the turn. */
  readonly stop: () => void
  /** Adds a step of the kinds that the action log lists. `callId` names the call of the step. */
  readonly record: (step: Omit<LoggedStep, "at"> & { readonly callId: string }) => void
}

export const stepWatch = (options: StepWatchOptions): StepWatch => {
  let ended = options.before
  let hit = false
  const recorded = new Set<string>()

  const log = (
    name: string,
    input: string,
    result: LoggedStep["result"],
    callId: string,
    part?: MessagePart,
  ) => {
    if (recorded.has(callId)) return
    recorded.add(callId)
    const kind = loggedKind(name)
    if (!kind) return
    // A tool of a connection is logged with the connection name and the tool name, never with
    // the arguments (spec 007, 018).
    const note = part?.kind === "tool" ? part.connection : undefined
    options.record({
      callId,
      kind,
      access: kind === "file" ? fileAccess(name) : null,
      target:
        note?.kind === "call"
          ? stepTarget(name, input, connectionToolLabel(note.connection, note.tool))
          : stepTarget(name, input),
      result,
    })
  }

  return {
    see(event, parts) {
      if (event.type !== "tool") return
      const { call } = event
      if (event.state === "running") return
      const marked = parts?.some((p) => p.kind === "tool" && p.id === call.id && p.refused)
      log(
        call.name,
        call.input,
        event.refused || event.notRun || marked
          ? "refused"
          : event.state === "done"
            ? "ran"
            : "failed",
        call.id,
        parts?.find((p) => p.kind === "tool" && p.id === call.id),
      )
      ended++
      if (!hit && ended >= options.limit) {
        hit = true
        options.stop()
      }
    },
    end(parts) {
      // A step that was running when the turn ended may have run in part. A step that waited for
      // the user did not start.
      for (const part of parts) {
        if (part.kind === "tool" && part.state === "running") {
          log(part.name, part.input, "stopped", part.id, part)
        }
      }
    },
    get hit() {
      return hit
    },
  }
}
