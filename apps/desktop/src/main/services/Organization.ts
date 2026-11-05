import {
  type HandOffModel,
  type HandOffRule,
  MAIN_AGENT_HAND_OFF_RULE,
  type Organization as OrganizationState,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { loadHandOffModel, readAskUpTheLine, readHandOffRule, readMainAgent } from "./handOff.ts"
import { Servers } from "./Servers.ts"

export interface OrganizationService {
  /** The part "Organization" of this profile (spec 013, 030). */
  readonly get: Effect.Effect<OrganizationState>
  /**
   * Sets the hand-off rule (spec 030). A change counts from the next send: a send that started
   * before it ends as it started. A value equal to the rule changes nothing.
   */
  setHandOff(rule: HandOffRule): Effect.Effect<OrganizationState>
  /**
   * Turns the switch "Ask up the line" on or off (spec 030). A change counts from the next pass of
   * a lead; a look that is on the line when it goes off stops (see `onAskUpTheLine`). A value equal
   * to the switch changes nothing.
   */
  setAskUpTheLine(on: boolean): Effect.Effect<OrganizationState>
  /** The switch "Ask up the line" now, read at once. The line reads it at each pass. */
  askUpTheLine(): boolean
  /**
   * Calls `listener` after the switch "Ask up the line" went off, here or by sync (spec 030). The
   * channels use it to stop the looks that are on the line.
   */
  onAskUpTheLineOff(listener: () => void): void
  /** The hand-off rule now, read at once. The tools read it at the time of each send. */
  rule(): HandOffRule
  /**
   * The main agent of a server, or null (spec 002, flow 7): the agent with the switch "Main agent"
   * on. An archived main agent counts as none.
   */
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
  static readonly layer = () =>
    Layer.effect(
      Organization,
      Effect.gen(function* () {
        const db = yield* Database
        const bus = yield* EventBus
        const servers = yield* Servers

        const read = (): OrganizationState => ({
          handOff: readHandOffRule(db),
          askUpTheLine: readAskUpTheLine(db),
        })
        const offListeners: (() => void)[] = []
        // A change by sync also moves the switch. The bus tells the same event for it.
        let wasOn = readAskUpTheLine(db)
        const noteSwitch = () => {
          const now = readAskUpTheLine(db)
          const wentOff = wasOn && !now
          wasOn = now
          if (wentOff) for (const listener of offListeners) listener()
        }
        bus.tap((event) => {
          if (event === "organization.changed") noteSwitch()
        })
        const mainAgent = (serverId: string): string | null => readMainAgent(db, serverId)

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
          setAskUpTheLine: (on) =>
            Effect.gen(function* () {
              if (readAskUpTheLine(db) !== on) {
                db.run(
                  `INSERT INTO organization (id, ask_up_the_line, changed_at) VALUES ('organization', ?, ?)
                   ON CONFLICT (id) DO UPDATE SET ask_up_the_line = excluded.ask_up_the_line,
                     changed_at = excluded.changed_at`,
                  on ? 1 : 0,
                  Date.now(),
                )
                bus.emit("organization.changed", { serverId: (yield* servers.local).id })
              }
              return read()
            }),
          askUpTheLine: () => readAskUpTheLine(db),
          onAskUpTheLineOff: (listener) => {
            offListeners.push(listener)
          },
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
