import {
  RETRO_SYSTEM,
  type RetroEvidence,
  type RetroProposal,
  retroProposals,
  retroRequest,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { DECISION_KEY } from "./Decision.ts"
import { askForDraft } from "./draftRequest.ts"
import { AppError } from "./errors.ts"
import { Platform } from "./Platform.ts"
import { Providers, secretKey } from "./Providers.ts"
import { SavedSecrets } from "./SavedSecrets.ts"
import { Secrets } from "./Secrets.ts"

// The retrospective of an organization (spec 030, "Retrospective"). It reads the labels and the
// verdicts of the work of the members of one organization in the last 7 days, asks the model account
// of the lead for one to three proposals, and gives them back. It saves nothing: the user saves a
// proposal in the form of its kind, or closes it.

/** The window of the evidence: the same 7 days as the outcome line of the chart (spec 029). */
const DAY_MS = 24 * 60 * 60 * 1000
const WINDOW_MS = 7 * DAY_MS

export interface RetroService {
  /**
   * One look back at the organization (spec 030, "Retrospective"). One request to the model, no
   * task and no message, and nothing saved. A request id lets the form close while it runs.
   */
  look(input: {
    readonly orgId: string
    readonly requestId: string
  }): Effect.Effect<readonly RetroProposal[], AppError>
  /** Drops a look back: the model call stops and its answer is not used. */
  cancel(requestId: string): Effect.Effect<void>
}

interface OrgRow {
  id: string
  server_id: string
  name: string
  lead_agent_id: string | null
}

interface WorkRow {
  agent_id: string
  label: string
  state: string
  verdict: string | null
  verdict_reason: string | null
}

export class Retro extends Context.Service<Retro, RetroService>()("robot/main/Retro") {
  static readonly layer = Layer.effect(
    Retro,
    Effect.gen(function* () {
      const db = yield* Database
      const platform = yield* Platform
      const providers = yield* Providers
      const secrets = yield* Secrets
      const savedSecrets = yield* SavedSecrets
      const pending = new Map<string, AbortController>()

      /** The keys and values that a text must not hold (spec 014), as the other drafts read them. */
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

      /** The work of the members of the organization in the window, with no text but a label. */
      const evidence = (org: OrgRow, members: readonly string[], now: number): RetroEvidence => {
        const placeholders = members.map(() => "?").join(", ")
        const rows = db.all<WorkRow>(
          `SELECT t.agent_id AS agent_id, t.label AS label, t.state AS state,
             t.verdict AS verdict, t.verdict_reason AS verdict_reason
           FROM task t JOIN agent a ON a.id = t.agent_id
           WHERE t.agent_id IN (${placeholders}) AND t.origin IS NULL AND a.archived_at IS NULL
             AND COALESCE(t.finished_at, t.created_at) >= ?
             AND (t.state IN ('done', 'blocked', 'failed') OR t.verdict IS NOT NULL)
           ORDER BY COALESCE(t.finished_at, t.created_at) DESC`,
          ...members,
          now - WINDOW_MS,
        )
        const names = new Map(
          db
            .all<{ id: string; name: string }>(
              `SELECT id, name FROM agent WHERE id IN (${placeholders})`,
              ...members,
            )
            .map((a) => [a.id, a.name] as const),
        )
        return {
          organization: org.name,
          members: members.flatMap((id) => names.get(id) ?? []),
          work: rows.map((w) => ({
            // The label is the short name that the board and the chart already show (spec 024, 029).
            label: w.label,
            state: w.state === "blocked" || w.state === "failed" ? w.state : "done",
            verdict: w.verdict === "met" || w.verdict === "not_met" ? w.verdict : null,
            verdictReason: w.verdict_reason,
          })),
        }
      }

      return Retro.of({
        cancel: (requestId) =>
          Effect.sync(() => {
            pending.get(requestId)?.abort()
          }),
        look: ({ orgId, requestId }) =>
          Effect.gen(function* () {
            const org = db.get<OrgRow>(
              "SELECT id, server_id, name, lead_agent_id FROM org_unit WHERE id = ?",
              orgId,
            )
            if (!org) return yield* new AppError({ code: "org_not_found" })
            const members = db
              .all<{ agent_id: string }>(
                `SELECT m.agent_id AS agent_id FROM org_member m JOIN agent a ON a.id = m.agent_id
                 WHERE m.org_id = ? AND a.archived_at IS NULL ORDER BY m.position`,
                orgId,
              )
              .map((m) => m.agent_id)
            if (members.length === 0) return yield* new AppError({ code: "retro_no_member" })
            // The lead of the organization asks, or the first member by name when it has none.
            const asker =
              org.lead_agent_id !== null && members.includes(org.lead_agent_id)
                ? org.lead_agent_id
                : (db.get<{ id: string }>(
                    `SELECT a.id AS id FROM agent a WHERE a.id IN (${members.map(() => "?").join(", ")})
                     ORDER BY a.name_key, a.id LIMIT 1`,
                    ...members,
                  )?.id ?? members[0])
            const controller = new AbortController()
            pending.set(requestId, controller)
            const request = retroRequest(evidence(org, members, Date.now()), yield* knownSecrets())
            const answer = yield* askForDraft(
              { db, providers, dataDir: platform.dataDir },
              asker as string,
              RETRO_SYSTEM,
              request,
              controller.signal,
            ).pipe(
              Effect.ensuring(Effect.sync(() => void pending.delete(requestId))),
              Effect.catch((error) =>
                controller.signal.aborted
                  ? Effect.fail(new AppError({ code: "cancelled" }))
                  : Effect.fail(error),
              ),
            )
            if (controller.signal.aborted) return yield* new AppError({ code: "cancelled" })
            const proposals = retroProposals(answer)
            if (!proposals) return yield* new AppError({ code: "retro_empty" })
            return proposals
          }),
      })
    }),
  )
}
