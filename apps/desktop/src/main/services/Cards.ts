import { randomUUID } from "node:crypto"
import type { CardAnswer, RunCard, SensitiveLabel } from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import type { Actor } from "./actor.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"

/**
 * The cards in the chat that wait for the user (spec 003, flow 6; spec 007): an approval card, a
 * question card and the pick of a decision node. A card of a node belongs to a task. A card of the
 * chat (the guarded feedback) has no task.
 *
 * A card waits for one answer. Stop, and the end of the turn or of the task, close it and it goes
 * away. After an app restart no card is left that nobody answered: it is deleted, and so are the
 * tasks that waited for it (spec 005, 007).
 */

/** What a caller gives to make a card. */
export interface CardAsk {
  readonly workflowId: string
  readonly runId: string | null
  readonly taskId: string | null
  readonly nodeNumber: number | null
  readonly nodeName: string | null
  readonly kind: RunCard["kind"]
  readonly summary: string
  readonly step: RunCard["step"]
  readonly once: boolean
  readonly outside: RunCard["outside"]
  readonly scope: RunCard["scope"]
  readonly sensitive: SensitiveLabel | null
  readonly unreadable?: boolean
  /** The count of values of the arguments that the card hides (spec 018). */
  readonly hidden?: number
  readonly choices?: readonly string[]
  readonly options?: RunCard["options"]
  readonly pickReason?: string | null
  readonly threshold?: number | null
  /** Ends the wait and removes the card: the run was stopped, or the turn ended. */
  readonly signal: AbortSignal
}

/** What the answer to a card is. A card of a text answer gives the text. */
export interface CardReply {
  readonly answer: string
  readonly inChat: boolean
  /** The name of the linked device that answered, or null for this computer (spec 012). */
  readonly device?: string | null
}

export interface CardsService {
  /**
   * Shows a card and waits for its answer. It rejects with an `Error("stopped")` when the signal
   * aborts, and the card is deleted.
   */
  ask(ask: CardAsk, onOpen?: (card: RunCard) => void): Promise<CardReply>
  /** The user answers a card. Fails when no one waits for it any more. */
  answer(cardId: string, answer: CardAnswer, actor?: Actor | null): Effect.Effect<void, AppError>
  /**
   * A message in the chat answers the oldest question card of the workflow that waits (spec 003).
   * Returns true when it did.
   */
  answerInChat(workflowId: string, text: string): boolean
  /** The cards of a workflow: those that wait, and those answered lately. Oldest first. */
  list(workflowId: string): RunCard[]
  /** True when a card of this task waits. */
  hasOpen(taskId: string): boolean
  /** The open cards of a workflow, for the answer of the chat about a run. */
  open(workflowId: string): RunCard[]
}

interface Row {
  id: string
  workflow_id: string
  run_id: string | null
  task_id: string | null
  kind: string
  payload: string
  answer: string | null
  answered_in_chat: number
  created_at: number
  answered_at: number | null
}

type Payload = Omit<
  RunCard,
  | "id"
  | "workflowId"
  | "runId"
  | "taskId"
  | "createdAt"
  | "answeredAt"
  | "answer"
  | "answeredInChat"
  | "kind"
>

/** An answered card stays in the history of the chat for this long. */
const ANSWERED_KEEP_MS = 24 * 60 * 60 * 1000

export class Cards extends Context.Service<Cards, CardsService>()("robot/main/Cards") {
  static readonly layer = Layer.effect(
    Cards,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus

      // After a restart nobody waits for a card: it goes away (spec 005, 007).
      db.run("DELETE FROM task_card WHERE answered_at IS NULL")

      const waiters = new Map<
        string,
        { resolve: (reply: CardReply) => void; kind: RunCard["kind"]; payload: Payload }
      >()

      const toCard = (r: Row): RunCard => {
        const p = JSON.parse(r.payload) as Payload
        return {
          id: r.id,
          workflowId: r.workflow_id,
          runId: r.run_id,
          taskId: r.task_id,
          nodeNumber: p.nodeNumber,
          nodeName: p.nodeName,
          kind: r.kind as RunCard["kind"],
          summary: p.summary,
          step: p.step,
          once: p.once,
          outside: p.outside,
          scope: p.scope,
          sensitive: p.sensitive,
          unreadable: p.unreadable,
          hidden: p.hidden ?? 0,
          choices: p.choices,
          options: p.options,
          pickReason: p.pickReason,
          threshold: p.threshold,
          createdAt: r.created_at,
          answeredAt: r.answered_at,
          answer: r.answer,
          answeredInChat: r.answered_in_chat === 1,
        }
      }

      const changed = (workflowId: string, runId: string | null) => {
        bus.emit("runs.changed", { workflowId, runId })
        bus.emit("chat.state", { workflowId })
      }

      const ask = (a: CardAsk, onOpen?: (card: RunCard) => void) =>
        new Promise<CardReply>((resolve, reject) => {
          if (a.signal.aborted) return reject(new Error("stopped"))
          const id = randomUUID()
          const payload: Payload = {
            nodeNumber: a.nodeNumber,
            nodeName: a.nodeName,
            summary: a.summary,
            step: a.step,
            once: a.once,
            outside: a.outside,
            scope: a.scope,
            sensitive: a.sensitive,
            unreadable: a.unreadable ?? false,
            hidden: a.hidden ?? 0,
            choices: a.choices ?? [],
            options: a.options ?? [],
            pickReason: a.pickReason ?? null,
            threshold: a.threshold ?? null,
          }
          db.run(
            `INSERT INTO task_card (id, workflow_id, run_id, task_id, kind, payload, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            id,
            a.workflowId,
            a.runId,
            a.taskId,
            a.kind,
            JSON.stringify(payload),
            Date.now(),
          )
          const stop = () => {
            waiters.delete(id)
            db.run("DELETE FROM task_card WHERE id = ?", id)
            changed(a.workflowId, a.runId)
            reject(new Error("stopped"))
          }
          a.signal.addEventListener("abort", stop, { once: true })
          waiters.set(id, {
            kind: a.kind,
            payload,
            resolve: (reply) => {
              a.signal.removeEventListener("abort", stop)
              resolve(reply)
            },
          })
          const row = db.get<Row>("SELECT * FROM task_card WHERE id = ?", id)
          if (row) onOpen?.(toCard(row))
          changed(a.workflowId, a.runId)
        })

      const close = (id: string, answer: string, inChat: boolean, device: string | null = null) => {
        const row = db.get<Row>("SELECT * FROM task_card WHERE id = ?", id)
        const waiter = waiters.get(id)
        if (!row || !waiter || row.answered_at !== null) return false
        waiters.delete(id)
        db.run(
          "UPDATE task_card SET answer = ?, answered_in_chat = ?, answered_at = ? WHERE id = ?",
          answer,
          inChat ? 1 : 0,
          Date.now(),
          id,
        )
        waiter.resolve({ answer, inChat, device })
        changed(row.workflow_id, row.run_id)
        return true
      }

      return Cards.of({
        ask,
        answer: (cardId, answer, actor) =>
          Effect.gen(function* () {
            const waiter = waiters.get(cardId)
            if (!waiter || waiter.kind !== answer.kind)
              return yield* new AppError({ code: "card_gone" })
            if (answer.kind === "approval") {
              // A card with Allow once and Deny only takes "always" as one "allow". So does an
              // answer from a linked device: a client cannot make a workflow less careful, so it
              // keeps no rule (spec 012).
              const given =
                (waiter.payload.once || actor) && answer.answer === "always"
                  ? "allow"
                  : answer.answer
              close(cardId, given, false, actor?.name ?? null)
            } else if (answer.kind === "question") {
              const text = answer.text.trim()
              if (text === "") return yield* new AppError({ code: "invalid_input" })
              close(cardId, text, false, actor?.name ?? null)
            } else {
              if (!waiter.payload.options.some((o) => o.id === answer.optionId))
                return yield* new AppError({ code: "invalid_input" })
              close(cardId, answer.optionId, false, actor?.name ?? null)
            }
          }),
        answerInChat: (workflowId, text) => {
          const row = db.get<Row>(
            `SELECT * FROM task_card WHERE workflow_id = ? AND kind = 'question' AND answered_at IS NULL
             ORDER BY created_at, rowid LIMIT 1`,
            workflowId,
          )
          return row ? close(row.id, text, true) : false
        },
        list: (workflowId) =>
          db
            .all<Row>(
              `SELECT * FROM task_card WHERE workflow_id = ? AND (answered_at IS NULL OR answered_at >= ?)
               ORDER BY created_at, rowid`,
              workflowId,
              Date.now() - ANSWERED_KEEP_MS,
            )
            .map(toCard),
        open: (workflowId) =>
          db
            .all<Row>(
              "SELECT * FROM task_card WHERE workflow_id = ? AND answered_at IS NULL ORDER BY created_at, rowid",
              workflowId,
            )
            .map(toCard),
        hasOpen: (taskId) =>
          db.get("SELECT 1 FROM task_card WHERE task_id = ? AND answered_at IS NULL", taskId) !==
          undefined,
      })
    }),
  )
}
