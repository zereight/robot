import {
  type HandOffModel,
  type HandOffRule,
  MAIN_AGENT_HAND_OFF_RULE,
  type Organization as OrganizationState,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { loadHandOffModel, readHandOffRule } from "./handOff.ts"
import { Servers } from "./Servers.ts"

export interface OrganizationOptions {
  /**
   * The main agent of a server (spec 002, flow 7), or null. The app has no switch for the main
   * agent yet, so the answer is null; the work that adds the switch fills this. Tests give one.
   */
  readonly mainAgent?: (serverId: string) => string | null
}

export interface OrganizationService {
  /** The part "Organization" of this profile (spec 013, 030). */
  readonly get: Effect.Effect<OrganizationState>
  /**
   * Sets the hand-off rule (spec 030). A change counts from the next send: a send that started
   * before it ends as it started. A value equal to the rule changes nothing.
   */
  setHandOff(rule: HandOffRule): Effect.Effect<OrganizationState>
  /** The hand-off rule now, read at once. The tools read it at the time of each send. */
  rule(): HandOffRule
  /** The main agent of a server, or null. An archived main agent counts as none. */
  mainAgent(serverId: string): string | null
  /** The agents and channels of a server, as the hand-off rule reads them, at this moment. */
  model(serverId: string): HandOffModel
  /**
   * What the app tells an agent about the hand-off rule in its instructions: the text for the main
   * agent while the rule is "Along the channels", else an empty text (spec 030, "Main agent").
   */
  told(agentId: string): string
}

export class Organization extends Context.Service<Organization, OrganizationService>()(
  "robot/main/Organization",
) {
  static readonly layer = (options: OrganizationOptions = {}) =>
    Layer.effect(
      Organization,
      Effect.gen(function* () {
        const db = yield* Database
        const bus = yield* EventBus
        const servers = yield* Servers

        const read = (): OrganizationState => ({ handOff: readHandOffRule(db) })
        const mainAgent = (serverId: string): string | null => {
          const id = options.mainAgent?.(serverId) ?? null
          if (id === null) return null
          const row = db.get<{ archived_at: number | null }>(
            "SELECT archived_at FROM agent WHERE id = ? AND server_id = ?",
            id,
            serverId,
          )
          return row && row.archived_at === null ? id : null
        }

        return Organization.of({
          get: Effect.sync(read),
          setHandOff: (rule) =>
            Effect.gen(function* () {
              const before = readHandOffRule(db)
              if (before !== rule) {
                // The row is made again when a sync removed it (spec 019): no row is the default.
                db.run(
                  `INSERT INTO organization (id, hand_off, changed_at) VALUES ('organization', ?, ?)
                   ON CONFLICT (id) DO UPDATE SET hand_off = excluded.hand_off,
                     changed_at = excluded.changed_at`,
                  rule,
                  Date.now(),
                )
                bus.emit("organization.changed", { serverId: (yield* servers.local).id })
              }
              return read()
            }),
          rule: () => readHandOffRule(db),
          mainAgent,
          model: (serverId) => loadHandOffModel(db, serverId, mainAgent(serverId)),
          told: (agentId) => {
            if (readHandOffRule(db) !== "channels") return ""
            const row = db.get<{ server_id: string }>(
              "SELECT server_id FROM agent WHERE id = ?",
              agentId,
            )
            return row && mainAgent(row.server_id) === agentId ? MAIN_AGENT_HAND_OFF_RULE : ""
          },
        })
      }),
    )
}
