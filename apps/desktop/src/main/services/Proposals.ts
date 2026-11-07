import { randomUUID } from "node:crypto"
import {
  CHANGE_LOG_DAYS,
  CHANGE_LOG_ROWS,
  type CheckOutcome,
  charLength,
  compileErrorText,
  compileGraph,
  DOCUMENT_MAX,
  factKey,
  type GraphProposalInput,
  graphChange,
  graphFingerprint,
  isWorkflowChange,
  looksLikeSecret,
  MEMORY_TOOL_MAX,
  MEMORY_USER_MAX,
  type OutsideSource,
  PROPOSAL_DIFF_MAX,
  PROPOSAL_EXPIRE_DAYS,
  PROPOSAL_REASON_MAX,
  PROPOSAL_WAIT_MAX,
  PROPOSALS_PER_DAY,
  type Proposal,
  type ProposalKind,
  type ProposalReason,
  type ProposalSource,
  type ProposalState,
  type ProposalsView,
  parseOutsideSource,
  textDiff,
  type WorkflowGraph,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Memory } from "./Memory.ts"
import { Providers } from "./Providers.ts"
import { WorkflowCheck } from "./WorkflowCheck.ts"
import { readGraph, Workflows } from "./Workflows.ts"

/**
 * Self-improvement (spec 002, 010): the proposals of a workflow and its change log.
 *
 * A proposal is a change that the responsible document suggests: a new text for the document, a
 * new prompt for a node, a new graph, or a new fact for the memory. A proposal is only a row. It
 * changes nothing until the user presses "Accept" (`accept`), and no tool of a model reaches
 * `accept`, `reject` or `undo`: they are methods of the window of this computer.
 *
 * Not built, and listed in the report of W8: "Edit and accept" for a graph change (spec 002 opens
 * the graph in the editor of the workflow); the memory check, which makes the proposals "From a
 * memory check" (spec 008).
 */

/** Why a proposal was not made. The text goes to the responsible document, which tells the user. */
export type Refusal =
  | "off"
  | "memory_off"
  | "reason"
  | "empty"
  | "too_long"
  | "secret"
  | "no_change"
  | "one_waits"
  | "per_turn"
  | "per_day"
  | "full"
  | "diff"
  | "known"
  | "node"
  | "graph"
  | "model"

export type ProposeOutcome =
  | {
      readonly ok: true
      readonly id: string
      readonly kind: ProposalKind
      readonly nodeNumber: number | null
    }
  | { readonly ok: false; readonly reason: Refusal; readonly text: string }

export type Change =
  | { readonly kind: "document"; readonly text: string }
  | { readonly kind: "prompt"; readonly node: number; readonly prompt: string }
  | { readonly kind: "graph"; readonly graph: GraphProposalInput }
  | { readonly kind: "memory"; readonly text: string }

export interface ProposeInput {
  readonly workflowId: string
  readonly source: ProposalSource
  /** The task of a node that suggested a memory item (the run view shows the line). */
  readonly taskId?: string | null
  readonly outside: OutsideSource | null
  readonly reason: string
  readonly change: Change
}

export interface ProposalsService {
  /** The proposals that wait and the change log (spec 002, "Flows", 2). */
  readonly list: (
    workflowId: string,
  ) => Effect.Effect<Omit<ProposalsView, "programBlock">, AppError>
  /** Makes a proposal when it passes the limits (spec 002, "Limits"). It changes nothing else. */
  readonly propose: (input: ProposeInput) => Effect.Effect<ProposeOutcome>
  /**
   * "Accept" and "Edit and accept" (spec 002, "Flows", 3 and 4). `text` is the edited text of a
   * document change, a prompt change or a memory item. The user's own click is the only caller.
   */
  readonly accept: (id: string, text?: string) => Effect.Effect<void, AppError>
  readonly reject: (id: string) => Effect.Effect<void, AppError>
  readonly undo: (id: string) => Effect.Effect<void, AppError>
  /** The number of proposals that wait for a workflow. */
  readonly waiting: (workflowId: string) => number
  /** True while 20 proposals wait for the workflow. */
  readonly full: (workflowId: string) => boolean
  /**
   * The facts of a workflow that wait as a memory proposal, as keys: the memory tool does not
   * suggest a fact that waits already.
   */
  readonly waitingFact: (workflowId: string, text: string) => boolean
}

interface Row {
  id: string
  workflow_id: string
  kind: ProposalKind
  node_id: string | null
  node_number: number | null
  node_name: string | null
  reason: string
  source_kind: ProposalSource["kind"]
  source_id: string | null
  task_id: string | null
  outside: string | null
  state: ProposalState
  state_reason: ProposalReason | null
  old_text: string | null
  new_text: string | null
  graph: string | null
  check_outcome: string | null
  base_key: string | null
  after_key: string | null
  applied: string | null
  created_at: number
  answered_at: number | null
  undone_at: number | null
}

const DAY_MS = 86_400_000
/** A diff that an accepted, edited text made may be big: the card then shows no marks. */
const EDITED_DIFF_MAX = 4000

const parse = <T>(text: string | null): T | null => {
  if (text === null) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

export class Proposals extends Context.Service<Proposals, ProposalsService>()(
  "robot/main/Proposals",
) {
  static readonly layer = Layer.effect(
    Proposals,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const workflows = yield* Workflows
      const check = yield* WorkflowCheck
      const memory = yield* Memory
      const providers = yield* Providers

      const workflowRow = (id: string) =>
        db.get<{
          id: string
          server_id: string
          document: string
          self_improvement: number
          memory_enabled: number
        }>(
          "SELECT id, server_id, document, self_improvement, memory_enabled FROM workflow WHERE id = ?",
          id,
        )
      const row = (id: string) => db.get<Row>("SELECT * FROM proposal WHERE id = ?", id)
      const changed = (workflowId: string) => {
        bus.emit("proposals.changed", { workflowId })
        const w = workflowRow(workflowId)
        if (w) bus.emit("workflows.changed", { serverId: w.server_id })
      }
      /** A run of the workflow works or waits: the editor is read-only (spec 010, "Rules"). */
      const running = (workflowId: string) =>
        db.get("SELECT 1 FROM run WHERE workflow_id = ? AND finished_at IS NULL", workflowId) !==
        undefined

      const waiting = (workflowId: string) =>
        db.get<{ n: number }>(
          "SELECT COUNT(*) AS n FROM proposal WHERE workflow_id = ? AND state = 'waiting'",
          workflowId,
        )?.n ?? 0

      /**
       * Expiry and the limits of the change log (spec 002, "Limits" and "Surfaces"): a proposal that
       * waits for 30 days is Rejected with the reason "Expired", and the change log keeps 90 days and
       * 1000 rows for each workflow. The change that a removed row made stays.
       */
      const sweep = (workflowId?: string) => {
        const now = Date.now()
        const only = workflowId ? " AND workflow_id = ?" : ""
        const extra = workflowId ? [workflowId] : []
        const expired = db.all<{ workflow_id: string }>(
          `SELECT DISTINCT workflow_id FROM proposal WHERE state = 'waiting' AND created_at < ?${only}`,
          now - PROPOSAL_EXPIRE_DAYS * DAY_MS,
          ...extra,
        )
        if (expired.length > 0) {
          db.run(
            `UPDATE proposal SET state = 'rejected', state_reason = 'expired', answered_at = ?
             WHERE state = 'waiting' AND created_at < ?${only}`,
            now,
            now - PROPOSAL_EXPIRE_DAYS * DAY_MS,
            ...extra,
          )
        }
        db.run(
          `DELETE FROM proposal WHERE state != 'waiting' AND COALESCE(undone_at, answered_at, created_at) < ?${only}`,
          now - CHANGE_LOG_DAYS * DAY_MS,
          ...extra,
        )
        for (const w of workflowId
          ? [{ workflow_id: workflowId }]
          : db.all<{ workflow_id: string }>("SELECT DISTINCT workflow_id FROM proposal"))
          db.run(
            `DELETE FROM proposal WHERE workflow_id = ? AND state != 'waiting' AND id NOT IN (
               SELECT id FROM proposal WHERE workflow_id = ? AND state != 'waiting'
               ORDER BY COALESCE(undone_at, answered_at, created_at) DESC, rowid DESC LIMIT ?)`,
            w.workflow_id,
            w.workflow_id,
            CHANGE_LOG_ROWS,
          )
        for (const w of expired) changed(w.workflow_id)
      }
      sweep()

      // --- the view -------------------------------------------------------------------------

      const graphNow = (workflowId: string): WorkflowGraph | null => {
        const w = workflowRow(workflowId)
        return w ? readGraph(db, workflowId) : null
      }

      const toProposal = (r: Row, busy: boolean): Proposal => {
        const outside = parseOutsideSource(r.outside)
        const newGraph = r.kind === "graph" ? parse<WorkflowGraph>(r.graph) : null
        const oldGraph = r.kind === "graph" ? parse<WorkflowGraph>(r.old_text) : null
        const outcome = parse<CheckOutcome>(r.check_outcome)
        const text = r.kind === "document" || r.kind === "prompt"
        const diff =
          text && r.old_text !== null && r.new_text !== null
            ? (textDiff(r.old_text, r.new_text, EDITED_DIFF_MAX)?.segments ?? null)
            : null
        let acceptBlock: Proposal["acceptBlock"] = null
        if (r.state === "waiting") {
          if (r.kind !== "memory" && busy) acceptBlock = "run_working"
          else if (r.kind === "graph") {
            if (outcome?.state === "problem") acceptBlock = "check_problem"
            else if (outcome?.state !== "passed") acceptBlock = "check_stopped"
          }
        }
        let undoBlock: Proposal["undoBlock"] = null
        let canUndo = false
        if (r.state === "applied") {
          const now = currentKey(r)
          if (now === "memory") {
            const applied = parse<{ historyId?: string }>(r.applied)
            canUndo = applied?.historyId ? memoryUndoable(applied.historyId) : false
            if (!canUndo) undoBlock = "newer"
          } else if (now !== r.after_key) undoBlock = "newer"
          else if (busy) undoBlock = "run_working"
          else canUndo = true
        }
        return {
          id: r.id,
          workflowId: r.workflow_id,
          kind: r.kind,
          node:
            r.node_id !== null
              ? { id: r.node_id, number: r.node_number ?? 0, name: r.node_name ?? "" }
              : null,
          reason: r.reason,
          source: { kind: r.source_kind, id: r.source_id },
          outside,
          state: r.state,
          stateReason: r.state_reason,
          createdAt: r.created_at,
          answeredAt: r.answered_at,
          undoneAt: r.undone_at,
          oldText: r.kind === "graph" ? null : r.old_text,
          newText: r.kind === "graph" ? null : r.new_text,
          diff,
          graph: newGraph && oldGraph ? graphChange(oldGraph, newGraph) : null,
          graphNodes: (newGraph?.nodes ?? []).map((n) => ({
            id: n.id,
            number: n.number,
            name: n.name,
          })),
          check: outcome,
          acceptBlock,
          undoBlock,
          canUndo,
        }
      }

      /** What the target is now, in the form that `after_key` holds. A memory item is judged by its history. */
      const currentKey = (r: Row): string | null => {
        if (r.kind === "memory") return "memory"
        if (r.kind === "document") return workflowRow(r.workflow_id)?.document ?? null
        const g = graphNow(r.workflow_id)
        return g ? graphFingerprint(g) : null
      }
      const memoryUndoable = (historyId: string): boolean => {
        const h = db.get<{
          memory_id: string
          kind: string
          new_text: string | null
          hidden: number
          undone_by: string | null
        }>(
          "SELECT memory_id, kind, new_text, hidden, undone_by FROM memory_history WHERE id = ?",
          historyId,
        )
        if (!h || h.hidden === 1 || h.undone_by) return false
        const item = db.get<{ text: string }>("SELECT text FROM memory WHERE id = ?", h.memory_id)
        return h.kind === "deleted"
          ? item === undefined
          : item !== undefined && item.text === h.new_text
      }

      const list = (workflowId: string) =>
        Effect.gen(function* () {
          const w = workflowRow(workflowId)
          if (!w) return yield* new AppError({ code: "workflow_not_found" })
          sweep(workflowId)
          const busy = running(workflowId)
          const rows = db.all<Row>(
            "SELECT * FROM proposal WHERE workflow_id = ? ORDER BY rowid",
            workflowId,
          )
          const waitingRows = rows
            .filter((r) => r.state === "waiting")
            .sort((a, b) => a.created_at - b.created_at)
          const logRows = rows
            .filter((r) => r.state !== "waiting")
            // The sort is stable: rows with the same time keep the newest first.
            .reverse()
            .sort(
              (a, b) =>
                (b.undone_at ?? b.answered_at ?? b.created_at) -
                (a.undone_at ?? a.answered_at ?? a.created_at),
            )
          return {
            workflowId,
            enabled: w.self_improvement === 1,
            waiting: waitingRows.map((r) => toProposal(r, busy)),
            log: logRows.map((r) => toProposal(r, busy)),
            full: waitingRows.length >= PROPOSAL_WAIT_MAX,
          }
        })

      // --- propose --------------------------------------------------------------------------

      const refuse = (reason: Refusal, text: string): ProposeOutcome => ({
        ok: false,
        reason,
        text,
      })

      /** True when a model of the graph is one that the account of the node offers (spec 002, 006). */
      const modelsOffered = (before: WorkflowGraph, after: WorkflowGraph) =>
        Effect.gen(function* () {
          const old = new Map(before.nodes.map((n) => [n.id, n]))
          for (const n of after.nodes) {
            if (n.kind !== "text") continue
            const was = old.get(n.id)
            const same =
              was !== undefined &&
              was.accountId === n.accountId &&
              was.model === n.model &&
              was.effort === n.effort
            if (same) continue
            if (n.accountId === null && n.model === null && n.effort === null) continue
            if (n.accountId === null || n.model === null)
              return `Node ${n.number}: set the account and the model together.`
            const account = (yield* providers.accounts).find((a) => a.id === n.accountId)
            if (!account?.connected) return `Node ${n.number}: the account is not connected.`
            const models = yield* providers
              .models(n.accountId)
              .pipe(Effect.orElseSucceed(() => null))
            if (models === null)
              return `Node ${n.number}: the models of the account could not be read now.`
            const info = models.find((m) => m.id === n.model)
            if (!info) return `Node ${n.number}: the account does not offer the model "${n.model}".`
            if (n.effort !== null && !info.efforts.includes(n.effort))
              return `Node ${n.number}: the model "${n.model}" does not take the reasoning level "${n.effort}".`
          }
          return null
        })

      const propose = (input: ProposeInput): Effect.Effect<ProposeOutcome> =>
        Effect.gen(function* () {
          const w = workflowRow(input.workflowId)
          if (!w) return refuse("node", "This workflow does not exist any more.")
          sweep(input.workflowId)
          const change = input.change
          const kind = change.kind
          if (kind !== "memory" && w.self_improvement !== 1)
            return refuse(
              "off",
              'The switch "Self-improvement" is off for this workflow, so you cannot propose a change to the document, a prompt or the graph. Tell the user that they can turn it on on the page "Self-improvement" of the workflow.',
            )
          if (kind === "memory" && w.memory_enabled !== 1)
            return refuse("memory_off", "Memory is off for this workflow. Nothing was suggested.")
          const reason = input.reason.trim().replace(/\s+/g, " ")
          if (kind !== "memory" && reason === "")
            return refuse(
              "reason",
              "Give a reason of one line that says what in the work led to this change.",
            )
          if (charLength(reason) > PROPOSAL_REASON_MAX)
            return refuse(
              "reason",
              `The reason is longer than ${PROPOSAL_REASON_MAX} characters. Write one short line.`,
            )
          if (looksLikeSecret(reason))
            return refuse("secret", "The text looks like a secret. Leave the secret out.")

          const waitingOf = (extra: string, ...params: string[]) =>
            db.get(
              `SELECT 1 FROM proposal WHERE workflow_id = ? AND state = 'waiting' AND ${extra}`,
              input.workflowId,
              ...params,
            ) !== undefined
          const secretText = "The text looks like a secret. Leave the secret out of the change."

          // What the kind needs, checked in the order of the spec: the form, the one for each
          // target, the limits of a turn and of a day, and how many wait.
          let oldText: string | null = null
          let newText: string | null = null
          let graph: WorkflowGraph | null = null
          let baseGraph: WorkflowGraph | null = null
          let baseKey: string | null = null
          let outcome: CheckOutcome | null = null
          let node: { id: string; number: number; name: string } | null = null

          if (change.kind === "document") {
            if (charLength(change.text) > DOCUMENT_MAX)
              return refuse("too_long", `The document is at most ${DOCUMENT_MAX} characters.`)
            if (looksLikeSecret(change.text)) return refuse("secret", secretText)
            if (change.text === w.document)
              return refuse("no_change", "This text is the document that the workflow has now.")
            const d = textDiff(w.document, change.text, PROPOSAL_DIFF_MAX)
            if (!d)
              return refuse(
                "diff",
                `The removed text and the added text together are at most ${PROPOSAL_DIFF_MAX} characters. Propose a smaller change.`,
              )
            if (waitingOf("kind = 'document'"))
              return refuse(
                "one_waits",
                "A change of the document waits for the user already. Wait for the answer.",
              )
            oldText = w.document
            newText = change.text
          } else if (change.kind === "prompt") {
            const target = readGraph(db, input.workflowId).nodes.find(
              (n) => n.number === change.node,
            )
            if (!target) return refuse("node", `Node ${change.node} does not exist.`)
            if (target.kind !== "text")
              return refuse("node", `Node ${change.node} is a decision node and has no prompt.`)
            if (looksLikeSecret(change.prompt)) return refuse("secret", secretText)
            if (change.prompt === target.prompt)
              return refuse("no_change", "This prompt is the prompt that the node has now.")
            const d = textDiff(target.prompt, change.prompt, PROPOSAL_DIFF_MAX)
            if (!d)
              return refuse(
                "diff",
                `The removed text and the added text together are at most ${PROPOSAL_DIFF_MAX} characters. Propose a smaller change.`,
              )
            if (waitingOf("kind = 'prompt' AND node_id = ?", target.id))
              return refuse(
                "one_waits",
                `A change of the prompt of node ${target.number} waits for the user already.`,
              )
            oldText = target.prompt
            newText = change.prompt
            node = { id: target.id, number: target.number, name: target.name }
          } else if (change.kind === "graph") {
            baseGraph = yield* workflows.graph(input.workflowId).pipe(Effect.orDie)
            const built = compileGraph(baseGraph, change.graph, randomUUID)
            if (!built.ok) return refuse("graph", compileErrorText(built.error, built.detail))
            const texts = built.graph.nodes.flatMap((n) => [
              n.name,
              n.prompt,
              n.question,
              ...n.options.map((o) => o.label),
            ])
            if (texts.some((t) => looksLikeSecret(t))) return refuse("secret", secretText)
            const bad = yield* modelsOffered(baseGraph, built.graph)
            if (bad) return refuse("model", bad)
            if (waitingOf("kind = 'graph'"))
              return refuse(
                "one_waits",
                "A change of the graph waits for the user already. Wait for the answer.",
              )
            graph = built.graph
            baseKey = graphFingerprint(baseGraph)
          } else {
            const text = change.text.trim()
            if (text === "") return refuse("empty", "The fact is empty.")
            if (charLength(text) > MEMORY_TOOL_MAX)
              return refuse(
                "too_long",
                `A memory text is at most ${MEMORY_TOOL_MAX} characters. Say it shorter.`,
              )
            if (looksLikeSecret(text)) return refuse("secret", secretText)
            if (memory.known(input.workflowId, text) || waitingFactOf(input.workflowId, text))
              return refuse("known", "This fact is known already. Nothing was added.")
            newText = text
          }

          if (isWorkflowChange(kind)) {
            // At most 1 for each turn or run, and 3 in 24 hours, of the kinds that change the workflow.
            // A proposal that was refused is not a row, so it does not count.
            if (input.source.id !== null) {
              const same = db.get<{ n: number }>(
                `SELECT COUNT(*) AS n FROM proposal WHERE workflow_id = ? AND kind != 'memory'
                   AND source_kind = ? AND source_id = ?`,
                input.workflowId,
                input.source.kind,
                input.source.id,
              )?.n
              if ((same ?? 0) >= 1)
                return refuse(
                  "per_turn",
                  "You made a proposal in this turn already. One proposal for each turn is the limit.",
                )
            }
            const day = db.get<{ n: number }>(
              "SELECT COUNT(*) AS n FROM proposal WHERE workflow_id = ? AND kind != 'memory' AND created_at > ?",
              input.workflowId,
              Date.now() - DAY_MS,
            )?.n
            if ((day ?? 0) >= PROPOSALS_PER_DAY)
              return refuse(
                "per_day",
                `The limit is ${PROPOSALS_PER_DAY} proposals in 24 hours for each workflow. Try again later.`,
              )
          }
          if (waiting(input.workflowId) >= PROPOSAL_WAIT_MAX)
            return refuse(
              "full",
              `${PROPOSAL_WAIT_MAX} proposals wait. The user must answer some before you can propose more.`,
            )

          if (graph) outcome = yield* check.checkGraph(graph)
          const id = randomUUID()
          db.run(
            `INSERT INTO proposal (id, workflow_id, kind, node_id, node_number, node_name, reason, source_kind,
               source_id, task_id, outside, state, old_text, new_text, graph, check_outcome, base_key, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?, ?, ?, ?, ?, ?)`,
            id,
            input.workflowId,
            kind,
            node?.id ?? null,
            node?.number ?? null,
            node?.name ?? null,
            reason,
            input.source.kind,
            input.source.id,
            input.taskId ?? null,
            input.outside ? JSON.stringify(input.outside) : null,
            // A graph change keeps the graph before it as JSON in "old_text", for the card.
            kind === "graph" ? JSON.stringify(baseGraph) : oldText,
            newText,
            graph ? JSON.stringify(graph) : null,
            outcome ? JSON.stringify(outcome) : null,
            baseKey,
            Date.now(),
          )
          changed(input.workflowId)
          return { ok: true, id, kind, nodeNumber: node?.number ?? null } as const
        })

      const waitingFactOf = (workflowId: string, text: string) => {
        const key = factKey(text)
        return db
          .all<{ new_text: string | null }>(
            "SELECT new_text FROM proposal WHERE workflow_id = ? AND kind = 'memory' AND state = 'waiting'",
            workflowId,
          )
          .some((r) => r.new_text !== null && factKey(r.new_text) === key)
      }

      // --- answer ---------------------------------------------------------------------------

      const answer = (
        id: string,
        state: "applied" | "rejected" | "failed",
        fields: {
          reason?: ProposalReason
          newText?: string
          afterKey?: string | null
          applied?: unknown
        } = {},
      ) => {
        const r = row(id) as Row
        db.run(
          `UPDATE proposal SET state = ?, state_reason = ?, answered_at = ?, new_text = ?, after_key = ?, applied = ?
           WHERE id = ?`,
          state,
          fields.reason ?? null,
          Date.now(),
          fields.newText ?? r.new_text,
          fields.afterKey ?? null,
          fields.applied === undefined ? null : JSON.stringify(fields.applied),
          id,
        )
        changed(r.workflow_id)
      }

      const need = (id: string, wanted: ProposalState) => {
        const r = row(id)
        if (!r) return Effect.fail(new AppError({ code: "proposal_not_found" }))
        if (r.state !== wanted) return Effect.fail(new AppError({ code: "proposal_not_waiting" }))
        return Effect.succeed(r)
      }

      const accept = (id: string, edited?: string) =>
        Effect.gen(function* () {
          const r = yield* need(id, "waiting")
          const w = workflowRow(r.workflow_id)
          if (!w) return yield* new AppError({ code: "workflow_not_found" })
          // An old proposal does not apply: it expired while the window was open.
          if (r.created_at < Date.now() - PROPOSAL_EXPIRE_DAYS * DAY_MS) {
            sweep(r.workflow_id)
            return yield* new AppError({ code: "proposal_not_waiting" })
          }
          if (r.kind !== "memory" && running(r.workflow_id))
            return yield* new AppError({ code: "proposal_run_working" })
          if (edited !== undefined && r.kind === "graph")
            return yield* new AppError({ code: "invalid_input" })

          if (r.kind === "document") {
            if (w.document !== r.old_text)
              return answer(id, "failed", { reason: "document_changed" })
            const text = edited ?? (r.new_text as string)
            yield* workflows.saveDocument(r.workflow_id, text, "proposal")
            // The key of a document change is the text itself: Undo works while it is the same.
            return answer(id, "applied", { newText: text, afterKey: text })
          }
          if (r.kind === "prompt") {
            const g = yield* workflows.graph(r.workflow_id)
            const target = g.nodes.find((n) => n.id === r.node_id)
            if (!target) return answer(id, "failed", { reason: "node_deleted" })
            if (target.prompt !== r.old_text)
              return answer(id, "failed", { reason: "node_changed" })
            const text = edited ?? (r.new_text as string)
            if (looksLikeSecret(text)) return yield* new AppError({ code: "proposal_secret" })
            const { versionId } = yield* workflows.applyPrompt(target.id, text, "proposal")
            const after = yield* workflows.graph(r.workflow_id)
            return answer(id, "applied", {
              newText: text,
              afterKey: graphFingerprint(after),
              applied: { versionId },
            })
          }
          if (r.kind === "graph") {
            const g = yield* workflows.graph(r.workflow_id)
            if (graphFingerprint(g) !== r.base_key)
              return answer(id, "failed", { reason: "graph_changed" })
            const next = parse<WorkflowGraph>(r.graph)
            if (!next) return answer(id, "failed", { reason: "failed" })
            // The check runs again at the moment of the accept: a graph that does not pass is never saved.
            const outcome = yield* check.checkGraph(next)
            db.run(
              "UPDATE proposal SET check_outcome = ? WHERE id = ?",
              JSON.stringify(outcome),
              id,
            )
            if (outcome.state !== "passed") {
              changed(r.workflow_id)
              return yield* new AppError({ code: "proposal_check_problem" })
            }
            const { versionId } = yield* workflows.applyGraph(r.workflow_id, next, "proposal")
            return answer(id, "applied", {
              afterKey: graphFingerprint(yield* workflows.graph(r.workflow_id)),
              applied: { versionId },
            })
          }
          // A memory item.
          const text = (edited ?? (r.new_text as string)).trim()
          if (text === "") return yield* new AppError({ code: "memory_text_empty" })
          if (charLength(text) > MEMORY_USER_MAX)
            return yield* new AppError({ code: "memory_text_long" })
          if (w.memory_enabled !== 1) return answer(id, "failed", { reason: "memory_off" })
          if (memory.known(r.workflow_id, text)) return answer(id, "failed", { reason: "known" })
          const saved = yield* memory.insert(r.workflow_id, text, {
            actor: "proposal",
            source: "proposal",
          })
          return answer(id, "applied", {
            newText: text,
            applied: { historyId: saved.historyId, memoryId: saved.item.id },
          })
        })

      const reject = (id: string) =>
        Effect.gen(function* () {
          yield* need(id, "waiting")
          answer(id, "rejected", { reason: "rejected" })
        })

      const undo = (id: string) =>
        Effect.gen(function* () {
          const r = yield* need(id, "applied")
          const applied = parse<{ versionId?: string; historyId?: string }>(r.applied)
          if (r.kind === "memory") {
            if (!applied?.historyId) return yield* new AppError({ code: "proposal_undo_blocked" })
            yield* memory
              .undo(applied.historyId)
              .pipe(
                Effect.mapError((e) =>
                  e.code === "memory_undo_blocked"
                    ? new AppError({ code: "proposal_undo_blocked" })
                    : e,
                ),
              )
            // `memory.undo` marked this row Undone, because the item came from this proposal.
            return
          }
          if (running(r.workflow_id)) return yield* new AppError({ code: "proposal_run_working" })
          if (currentKey(r) !== r.after_key)
            return yield* new AppError({ code: "proposal_undo_blocked" })
          if (r.kind === "document") {
            yield* workflows.saveDocument(r.workflow_id, r.old_text ?? "", "undo")
          } else {
            if (!applied?.versionId) return yield* new AppError({ code: "proposal_undo_blocked" })
            yield* workflows.restoreVersion(r.workflow_id, applied.versionId)
          }
          db.run("UPDATE proposal SET state = 'undone', undone_at = ? WHERE id = ?", Date.now(), id)
          changed(r.workflow_id)
        })

      return Proposals.of({
        list,
        propose,
        accept,
        reject,
        undo,
        waiting,
        full: (workflowId) => waiting(workflowId) >= PROPOSAL_WAIT_MAX,
        waitingFact: waitingFactOf,
      })
    }),
  )
}
