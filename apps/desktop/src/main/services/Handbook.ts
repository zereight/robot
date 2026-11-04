import { randomUUID } from "node:crypto"
import {
  HANDBOOK_HISTORY_MAX,
  type HandbookSource,
  type Handbook as HandbookState,
  type HandbookVersion,
  handbookTooLong,
  looksLikeSecret,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { DECISION_KEY } from "./Decision.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { Providers, secretKey } from "./Providers.ts"
import { SavedSecrets } from "./SavedSecrets.ts"
import { Secrets } from "./Secrets.ts"

interface VersionRow {
  id: string
  server_id: string
  text: string
  source: HandbookSource
  created_at: number
}

const toVersion = (r: VersionRow): HandbookVersion => ({
  id: r.id,
  serverId: r.server_id,
  text: r.text,
  source: r.source,
  createdAt: r.created_at,
})

export interface HandbookService {
  /** The handbook of a server: its newest version, or an empty text when it was never written. */
  get(serverId: string): Effect.Effect<HandbookState>
  /** The last 20 versions, newest first. */
  history(serverId: string): Effect.Effect<readonly HandbookVersion[]>
  /**
   * Saves a text as the handbook (spec 002). A text over 20000 characters, and a text that looks
   * like a secret, are refused with the reason and change nothing. A text equal to the handbook
   * makes no version. A change counts from the next turn: a turn that runs keeps its text.
   */
  save(
    serverId: string,
    text: string,
    source: HandbookSource,
  ): Effect.Effect<HandbookState, AppError>
  /** Makes the text of a version the handbook again, as a new version from a restore. */
  restore(serverId: string, versionId: string): Effect.Effect<HandbookState, AppError>
  /**
   * True when `text` looks like a secret: a key or token of a known form, or a stored key (spec
   * 014). The instructions of a channel (004) use the same rule.
   */
  holdsSecret(text: string): Effect.Effect<boolean>
  /** The text that a turn of an agent reads, or "" (spec 002). It reads the database at once. */
  text(serverId: string): string
}

export class Handbook extends Context.Service<Handbook, HandbookService>()("robot/main/Handbook") {
  static readonly layer = Layer.effect(
    Handbook,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const secrets = yield* Secrets
      const providers = yield* Providers
      const savedSecrets = yield* SavedSecrets

      const newest = (serverId: string) =>
        db.get<VersionRow>(
          "SELECT * FROM handbook_version WHERE server_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
          serverId,
        )
      const state = (serverId: string): HandbookState => {
        const row = newest(serverId)
        return { serverId, text: row?.text ?? "", updatedAt: row?.created_at ?? null }
      }

      /** The keys and values that a text must not hold (spec 014), as the export hides them. */
      const knownSecrets = Effect.gen(function* () {
        return [
          ...(yield* providers.list)
            .map((a) => secrets.get(secretKey(a.id)))
            .filter((k): k is string => k !== null),
          ...[secrets.get(DECISION_KEY)].filter((k): k is string => k !== null),
          ...savedSecrets.knownValues(),
        ]
      })

      const holdsSecret = (text: string) =>
        Effect.map(knownSecrets, (known) => looksLikeSecret(text, known))

      /** Keeps a text as the newest version. At most 20 versions stay; the oldest go first. */
      const record = (serverId: string, text: string, source: HandbookSource) => {
        db.run(
          "INSERT INTO handbook_version (id, server_id, text, source, created_at) VALUES (?, ?, ?, ?, ?)",
          randomUUID(),
          serverId,
          text,
          source,
          Date.now(),
        )
        db.run(
          `DELETE FROM handbook_version WHERE server_id = ? AND id NOT IN (
             SELECT id FROM handbook_version WHERE server_id = ?
             ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
          serverId,
          serverId,
          HANDBOOK_HISTORY_MAX,
        )
        bus.emit("handbook.changed", { serverId })
      }

      const save = Effect.fn("Handbook.save")(function* (
        serverId: string,
        text: string,
        source: HandbookSource,
      ) {
        if (!db.get("SELECT 1 AS x FROM server WHERE id = ?", serverId))
          return yield* new AppError({ code: "invalid_input" })
        if (handbookTooLong(text)) return yield* new AppError({ code: "handbook_too_long" })
        if (yield* holdsSecret(text)) return yield* new AppError({ code: "handbook_secret" })
        // A save that keeps the text makes no version, except a restore, which always does.
        if (text !== state(serverId).text || source === "restore") record(serverId, text, source)
        return state(serverId)
      })

      return Handbook.of({
        get: (serverId) => Effect.sync(() => state(serverId)),
        history: (serverId) =>
          Effect.sync(() =>
            db
              .all<VersionRow>(
                `SELECT * FROM handbook_version WHERE server_id = ?
                 ORDER BY created_at DESC, rowid DESC LIMIT ?`,
                serverId,
                HANDBOOK_HISTORY_MAX,
              )
              .map(toVersion),
          ),
        save,
        holdsSecret,
        restore: Effect.fn("Handbook.restore")(function* (serverId: string, versionId: string) {
          const row = db.get<VersionRow>("SELECT * FROM handbook_version WHERE id = ?", versionId)
          if (!row || row.server_id !== serverId)
            return yield* new AppError({ code: "version_not_found" })
          return yield* save(serverId, row.text, "restore")
        }),
        text: (serverId) => state(serverId).text,
      })
    }),
  )
}
