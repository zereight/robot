import { randomUUID } from "node:crypto"
import {
  canAddThread,
  type HandoverOpen,
  type HandoverState,
  handoverTextValid,
  handoverTitle,
  type Locale,
  resolveLocale,
  translate,
  writeBrief,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Chat, type Place } from "./Chat.ts"
import { Database } from "./Database.ts"
import { DECISION_KEY } from "./Decision.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"
import { Providers, secretKey } from "./Providers.ts"
import { SavedSecrets } from "./SavedSecrets.ts"
import { Secrets } from "./Secrets.ts"
import { SettingsStore } from "./Settings.ts"

export interface HandoverService {
  /** Whether "Hand over" is on for a chat or thread, and why not (spec 003, "Flows" 1). */
  state(place: Place): Effect.Effect<HandoverState, AppError>
  /**
   * Opens the dialog: writes the brief from the stored chat and lists the agents the chat can go
   * to. The brief is kept under an id until the user presses "Hand over" or closes the dialog.
   */
  open(place: Place): Effect.Effect<HandoverOpen, AppError>
  /** Hands the chat over. It stores the same brief that `open` wrote (spec 003, "The brief"). */
  start(input: {
    readonly place: Place
    readonly toAgentId: string
    readonly text: string
    readonly briefId: string
  }): Effect.Effect<{ agentId: string; threadId: string }, AppError>
}

/** A brief that the dialog shows, until the user hands over. */
interface KeptBrief {
  readonly place: Place
  readonly brief: string
  /** The title of the new thread, in the language of the app when the dialog opened. */
  readonly title: string
}

/** The dialogs that have an open brief at one time. The oldest is dropped past this number. */
const KEPT_MAX = 20

/** The local time of the computer, to the minute (spec 003, "The brief"). */
export const briefTime = (ms: number): string => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/**
 * The handover of a chat (spec 003, "Hand over"): the brief and the list of the dialog. The new
 * thread, the card and the muted line are made by the chat service, which owns the threads.
 */
export class Handover extends Context.Service<Handover, HandoverService>()("robot/main/Handover") {
  static readonly layer = Layer.effect(
    Handover,
    Effect.gen(function* () {
      const db = yield* Database
      const chat = yield* Chat
      const platform = yield* Platform
      const providers = yield* Providers
      const secrets = yield* Secrets
      const savedSecrets = yield* SavedSecrets
      const settings = yield* SettingsStore
      const kept = new Map<string, KeptBrief>()

      /** The keys and values that a text must not hold (spec 014), as the export hides them. */
      const knownSecrets = () =>
        Effect.gen(function* () {
          return [
            ...(yield* providers.list)
              .map((a) => secrets.get(secretKey(a.id)))
              .filter((k): k is string => k !== null),
            ...[secrets.get(DECISION_KEY)].filter((k): k is string => k !== null),
            ...savedSecrets.knownValues(),
          ]
        })

      const localeNow = () =>
        Effect.gen(function* () {
          const language = (yield* settings.get).language
          const locale: Locale = resolveLocale(language, platform.systemLocale())
          return locale
        })

      const agentOf = (agentId: string) =>
        db.get<{ name: string; workspace: string; server_id: string }>(
          "SELECT name, workspace, server_id FROM agent WHERE id = ?",
          agentId,
        )

      return Handover.of({
        state: (place) =>
          chat.handoverReason(place).pipe(Effect.map((off): HandoverState => ({ off }))),

        open: (place) =>
          Effect.gen(function* () {
            const off = yield* chat.handoverReason(place)
            if (off) {
              return yield* new AppError({
                code:
                  off === "noMessage"
                    ? "handover_no_message"
                    : off === "running"
                      ? "handover_running"
                      : "handover_no_agent",
              })
            }
            const first = agentOf(place.agentId)
            if (!first) return yield* new AppError({ code: "agent_not_found" })
            const locale = yield* localeNow()
            const history = yield* chat.history(place.agentId, place.threadId)
            const threadTitle =
              place.threadId === null
                ? translate(locale, "threads.main")
                : (db.get<{ title: string | null }>(
                    "SELECT title FROM thread WHERE id = ?",
                    place.threadId,
                  )?.title ?? translate(locale, "threads.new"))
            const brief = writeBrief({
              locale,
              agentName: first.name,
              title: threadTitle,
              folder: first.workspace,
              messages: history.messages,
              known: yield* knownSecrets(),
              formatTime: briefTime,
            })
            const briefId = randomUUID()
            kept.set(briefId, { place, brief, title: handoverTitle(first.name, locale) })
            for (const old of [...kept.keys()].slice(0, Math.max(0, kept.size - KEPT_MAX)))
              kept.delete(old)
            // The other agents of this server that are not archived. An agent with 50 threads is
            // in the list but off, with the reason (spec 003).
            const candidates = db
              .all<{ id: string; threads: number }>(
                `SELECT a.id AS id, (SELECT COUNT(*) FROM thread t WHERE t.agent_id = a.id) AS threads
                 FROM agent a
                 WHERE a.server_id = ? AND a.archived_at IS NULL AND a.id != ?
                 ORDER BY a.created_at, a.rowid`,
                first.server_id,
                place.agentId,
              )
              .map((r) => ({ agentId: r.id, full: !canAddThread(r.threads) }))
            const opened: HandoverOpen = { briefId, brief, candidates }
            return opened
          }),

        start: (input) =>
          Effect.gen(function* () {
            if (!handoverTextValid(input.text))
              return yield* new AppError({ code: "invalid_input" })
            const found = kept.get(input.briefId)
            if (
              !found ||
              found.place.agentId !== input.place.agentId ||
              found.place.threadId !== input.place.threadId
            )
              return yield* new AppError({ code: "handover_brief_gone" })
            const made = yield* chat.startHandover({
              from: input.place,
              toAgentId: input.toAgentId,
              text: input.text.trim(),
              brief: found.brief,
              title: found.title,
            })
            kept.delete(input.briefId)
            return made
          }),
      })
    }),
  )
}
