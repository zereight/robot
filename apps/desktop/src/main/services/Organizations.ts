import { randomUUID } from "node:crypto"
import {
  type AgentOrgTool,
  lineRefusalCode,
  lineRefusalDetail,
  nameKey,
  ORGS_MAX,
  type Org,
  type OrgCreate,
  type OrgLimitView,
  type OrgLineChange,
  type OrgPatch,
  type OrgToolChoice,
  type OrgToolRow,
  type OrgUsageRow,
  orgDeleteMoveUp,
  orgLineRefusal,
  orgNameProblem,
  orgParentRefusal,
  orgToolNow,
  validDailyLimit,
  withOrgSwitch,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import {
  type OrgRow,
  orgEntriesOf,
  orgGiversFor,
  orgIdsOfAgent,
  orgRow,
  orgTreeOf,
  readOrgs,
  toOrg,
} from "./orgData.ts"
import { orgLimitViewOf, orgUsageOf } from "./orgLimitData.ts"
import {
  flushLineNotes,
  noteLineRepairs,
  noteOrgRepairs,
  repairOrgLines,
  repairOrgTree,
} from "./orgRepair.ts"
import { Platform } from "./Platform.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"

// The organization (spec 030): a group of agents with a lead and a parent organization. This
// service makes, changes and deletes organizations, keeps the tree right, and gives the part
// "Tools" of the form and the lines "From <organization>" of the profile. The access that an
// organization holds beyond tools (the daily token limit and the hand-off range) is stored here and
// read by later steps.

export interface OrganizationsService {
  /** The organizations of a server, in the order of their names (ignoring case). */
  list(serverId: string): Effect.Effect<readonly Org[]>
  get(id: string): Effect.Effect<Org, AppError>
  /**
   * Makes an organization (spec 030, flow 1). The name is 1 to 60 characters and unique, ignoring
   * case. The members are agents of the server that are not archived. The lead is one of the
   * members. The parent follows the rules of the tree (3 levels at most, no loop). A profile holds
   * at most 100 organizations.
   */
  create(input: OrgCreate): Effect.Effect<Org, AppError>
  /**
   * Edit (spec 030, flow 2). A member that is archived and already in the organization stays. A
   * member that is removed is no longer the lead. The same parent again needs no check.
   */
  update(id: string, patch: OrgPatch): Effect.Effect<Org, AppError>
  /**
   * Delete (spec 030, flow 4). The members stay agents. The organization leaves every skill and
   * connection list. Its sub-organizations move up to its parent. There is no Undo.
   */
  remove(id: string): Effect.Effect<void, AppError>
  /** The skills and connections of this computer, with the value of this organization (part "Tools"). */
  tools(orgId: string): Effect.Effect<readonly OrgToolRow[], AppError>
  /**
   * Sets the value of this organization for a skill or a connection. A skill or connection for "All
   * agents" stays as it is. Gives the rows as they are now. Only "On" and "Inherit" can be set in
   * this version.
   */
  setTool(
    orgId: string,
    kind: "skill" | "connection",
    id: string,
    choice: OrgToolChoice,
  ): Effect.Effect<readonly OrgToolRow[], AppError>
  /** The skills and connections that an agent has from organizations (the lines "From <organization>"). */
  toolsOfAgent(agentId: string): Effect.Effect<readonly AgentOrgTool[]>
  /** The daily token limit of an organization, the tokens used today, and where it stands (spec 030). */
  limit(id: string): Effect.Effect<OrgLimitView, AppError>
  /** One row for each organization of a server that has a daily token limit (spec 006, 030). */
  usage(serverId: string): Effect.Effect<readonly OrgUsageRow[]>
}

interface ToolRow {
  id: string
  name: string
  agents: string | null
  organizations: string
  enabled: number
}

const tableOf = (kind: "skill" | "connection") => (kind === "skill" ? "skill" : "tool_connection")

export class Organizations extends Context.Service<Organizations, OrganizationsService>()(
  "robot/main/Organizations",
) {
  static readonly layer = Layer.effect(
    Organizations,
    Effect.gen(function* () {
      const db = yield* Database
      const bus = yield* EventBus
      const platform = yield* Platform
      const servers = yield* Servers
      const providers = yield* Providers

      // The start of the app (spec 030, "Repair"): a tree that breaks the rules is repaired at once.
      // A database that synced uses the stamps of its parent fields; else the tie order decides.
      const synced = db.get("SELECT 1 AS x FROM sync_pair") !== undefined
      const localId = (yield* servers.local).id
      noteOrgRepairs(
        bus,
        platform.dataDir,
        localId,
        repairOrgTree(db, { mode: synced ? "sync" : "import" }),
      )
      // Then the lines (spec 030, "One line", "Repair"). The removals of the migration wait for
      // their log lines. A profile in a sync pair repairs its lines after the settle of the sync
      // (`repairOrgs` of the engine), which also runs at the start: the stamps of a change that
      // waits are not read yet here, and the choice must be the one that the other computer makes.
      flushLineNotes(db, platform.dataDir)
      if (!synced)
        noteLineRepairs(
          bus,
          platform.dataDir,
          localId,
          db.transaction(() => repairOrgLines(db)),
        )

      const changed = (serverId: string) => bus.emit("organizations.changed", { serverId })

      const failNotFound = () => new AppError({ code: "org_not_found" })

      /** The agents of a server by id: whether each is archived. */
      const agentState = (serverId: string, id: string): "live" | "archived" | "none" => {
        const row = db.get<{ server_id: string; archived_at: number | null }>(
          "SELECT server_id, archived_at FROM agent WHERE id = ?",
          id,
        )
        if (!row || row.server_id !== serverId) return "none"
        return row.archived_at === null ? "live" : "archived"
      }

      /**
       * The members of the form: agents of the server. An archived agent may stay when it is a member
       * already (spec 030); a new member must not be archived. The lead is one of the members, and a
       * lead that is archived stays only when it is the lead already.
       */
      const checkMembers = (
        serverId: string,
        memberIds: readonly string[],
        leadId: string | null,
        before?: Org,
      ) =>
        Effect.suspend(() => {
          for (const id of memberIds) {
            const state = agentState(serverId, id)
            if (state === "none" || (state === "archived" && !before?.memberIds.includes(id)))
              return Effect.fail(new AppError({ code: "agent_not_found" }))
          }
          if (leadId !== null) {
            if (!memberIds.includes(leadId))
              return Effect.fail(new AppError({ code: "invalid_lead" }))
            if (agentState(serverId, leadId) === "archived" && before?.leadId !== leadId)
              return Effect.fail(new AppError({ code: "agent_not_found" }))
          }
          return Effect.void
        })

      const checkName = (serverId: string, name: string, exceptId: string | null) =>
        Effect.suspend(() => {
          const problem = orgNameProblem(
            name,
            (key) =>
              db.get(
                "SELECT 1 FROM org_unit WHERE server_id = ? AND name_key = ? AND id != ?",
                serverId,
                key,
                exceptId ?? "",
              ) !== undefined,
          )
          if (problem === "invalid") return Effect.fail(new AppError({ code: "invalid_input" }))
          if (problem === "taken") return Effect.fail(new AppError({ code: "org_name_taken" }))
          return Effect.void
        })

      /** The rules of the tree for a new parent of organization `id` (spec 030). `id` may be a new one. */
      const checkParent = (serverId: string, id: string, parentId: string | null) =>
        Effect.suspend(() => {
          if (parentId === null) return Effect.void
          const refusal = orgParentRefusal(orgTreeOf(db, serverId), id, parentId)
          if (refusal === undefined) return Effect.void
          return Effect.fail(
            new AppError({
              code:
                refusal === "loop"
                  ? "org_parent_loop"
                  : refusal === "levels"
                    ? "org_parent_levels"
                    : "org_parent_not_found",
            }),
          )
        })

      /**
       * The rule "One line" (spec 030) for one change: a save of the form is one change with all its
       * fields, and a move on the chart is a removal and an add. The tree rules run first. An
       * archived agent counts. A removal is never refused.
       */
      const checkLine = (serverId: string, changes: readonly OrgLineChange[]) =>
        Effect.suspend(() => {
          const orgs = readOrgs(db, serverId)
          const agents = db.all<{ id: string; name: string }>(
            "SELECT id, name FROM agent WHERE server_id = ?",
            serverId,
          )
          const refusal = orgLineRefusal(orgs, agents, changes)
          if (refusal === undefined) return Effect.void
          const named = [...orgs, ...changes.map((c) => ({ id: c.id, name: c.name ?? "" }))]
          return Effect.fail(
            new AppError({
              code: lineRefusalCode(refusal),
              detail: lineRefusalDetail(refusal, named, agents),
            }),
          )
        })

      /** The daily token limit (spec 030): off, or a whole number from 10,000 to 100,000,000. */
      const checkLimit = (limit: number | null) =>
        limit === null || validDailyLimit(limit)
          ? Effect.succeed(limit)
          : Effect.fail(new AppError({ code: "invalid_daily_limit" }))

      const writeMembers = (orgId: string, memberIds: readonly string[]) => {
        db.run("DELETE FROM org_member WHERE org_id = ?", orgId)
        for (const [position, agentId] of memberIds.entries())
          db.run(
            "INSERT INTO org_member (org_id, agent_id, position) VALUES (?, ?, ?)",
            orgId,
            agentId,
            position,
          )
      }

      const need = (id: string): Effect.Effect<OrgRow, AppError> => {
        const row = orgRow(db, id)
        return row ? Effect.succeed(row) : Effect.fail(failNotFound())
      }

      const create = Effect.fn("Organizations.create")(function* (input: OrgCreate) {
        const name = input.name.trim()
        if (!db.get("SELECT 1 AS x FROM server WHERE id = ?", input.serverId))
          return yield* new AppError({ code: "server_not_found" })
        const count =
          db.get<{ n: number }>(
            "SELECT COUNT(*) AS n FROM org_unit WHERE server_id = ?",
            input.serverId,
          )?.n ?? 0
        if (count >= ORGS_MAX) return yield* new AppError({ code: "orgs_full" })
        const memberIds = [...new Set(input.memberIds)]
        yield* checkName(input.serverId, name, null)
        yield* checkMembers(input.serverId, memberIds, input.leadId)
        const id = randomUUID()
        const parentId = input.parentId ?? null
        yield* checkParent(input.serverId, id, parentId)
        yield* checkLine(input.serverId, [{ id, name, parentId, memberIds }])
        const limit = yield* checkLimit(input.dailyTokenLimit ?? null)
        const now = Date.now()
        db.transaction(() => {
          db.run(
            `INSERT INTO org_unit (id, server_id, name, name_key, lead_agent_id, parent_id,
              hand_off_range, daily_token_limit, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id,
            input.serverId,
            name,
            nameKey(name),
            input.leadId,
            parentId,
            input.handOffRange ?? "inherit",
            limit,
            now,
            now,
          )
          writeMembers(id, memberIds)
        })
        changed(input.serverId)
        return toOrg(db, orgRow(db, id) as NonNullable<ReturnType<typeof orgRow>>)
      })

      const update = Effect.fn("Organizations.update")(function* (id: string, patch: OrgPatch) {
        const row = yield* need(id)
        const current = toOrg(db, row)
        const name = patch.name !== undefined ? patch.name.trim() : row.name
        const memberIds = patch.memberIds ? [...new Set(patch.memberIds)] : [...current.memberIds]
        // A member that is removed is no longer the lead (spec 030).
        const leadId =
          patch.leadId !== undefined
            ? patch.leadId
            : memberIds.includes(current.leadId ?? "")
              ? current.leadId
              : null
        if (name !== row.name) yield* checkName(row.server_id, name, id)
        yield* checkMembers(row.server_id, memberIds, leadId, current)
        // The same parent again needs no check: a parent that the rules allowed stays allowed.
        const parentId = patch.parentId !== undefined ? patch.parentId : row.parent_id
        if (parentId !== row.parent_id) yield* checkParent(row.server_id, id, parentId)
        // One change with all its fields: the new parent and the new members together.
        const change: OrgLineChange = {
          id,
          ...(parentId !== row.parent_id ? { parentId } : {}),
          ...(patch.memberIds ? { memberIds } : {}),
        }
        if (change.parentId !== undefined || change.memberIds !== undefined)
          yield* checkLine(row.server_id, [change])
        const limit =
          patch.dailyTokenLimit !== undefined && patch.dailyTokenLimit !== row.daily_token_limit
            ? yield* checkLimit(patch.dailyTokenLimit)
            : row.daily_token_limit
        db.transaction(() => {
          db.run(
            `UPDATE org_unit SET name = ?, name_key = ?, lead_agent_id = ?, parent_id = ?,
              hand_off_range = ?, daily_token_limit = ?, updated_at = ? WHERE id = ?`,
            name,
            nameKey(name),
            leadId,
            parentId,
            patch.handOffRange ?? row.hand_off_range,
            limit,
            Date.now(),
            id,
          )
          if (patch.memberIds) writeMembers(id, memberIds)
        })
        changed(row.server_id)
        return toOrg(db, orgRow(db, id) as NonNullable<ReturnType<typeof orgRow>>)
      })

      /** Takes an organization out of the list of every skill and connection (spec 030, flow 4). */
      const leaveToolLists = (orgId: string): { skills: boolean; connections: boolean } => {
        const out = { skills: false, connections: false }
        for (const kind of ["skill", "connection"] as const) {
          for (const row of db.all<ToolRow>(
            `SELECT id, name, agents, organizations, enabled FROM ${tableOf(kind)}
             WHERE organizations LIKE ?`,
            `%${orgId}%`,
          )) {
            const entries = orgEntriesOf(row)
            if (!entries.some((e) => e.id === orgId)) continue
            db.run(
              `UPDATE ${tableOf(kind)} SET organizations = ? WHERE id = ?`,
              JSON.stringify(withOrgSwitch(entries, orgId, "inherit")),
              row.id,
            )
            out[kind === "skill" ? "skills" : "connections"] = true
          }
        }
        return out
      }

      const remove = Effect.fn("Organizations.remove")(function* (id: string) {
        const row = yield* need(id)
        const lists = db.transaction(() => {
          // The sub-organizations move up to the parent of the deleted organization, here and, after
          // a sync, on the other computer (spec 030, flow 4). The tree gets no deeper, and no agent
          // gets off its line.
          const { subIds, parentId } = orgDeleteMoveUp(orgTreeOf(db, row.server_id), id)
          for (const sub of subIds)
            db.run(
              "UPDATE org_unit SET parent_id = ?, updated_at = ? WHERE id = ?",
              parentId,
              Date.now(),
              sub,
            )
          const left = leaveToolLists(id)
          db.run("DELETE FROM org_unit WHERE id = ?", id)
          return left
        })
        if (lists.skills) bus.emit("skills.changed", { serverId: row.server_id })
        if (lists.connections) bus.emit("connections.changed", {})
        changed(row.server_id)
      })

      // --- tools --------------------------------------------------------------------------

      const rowsOf = (kind: "skill" | "connection", serverId: string) =>
        db.all<ToolRow>(
          `SELECT id, name, agents, organizations, enabled FROM ${tableOf(kind)}
           WHERE server_id = ? ORDER BY name_key`,
          serverId,
        )

      const toolRows = (serverId: string, orgId: string): OrgToolRow[] => {
        const tree = orgTreeOf(db, serverId)
        const names = new Map(readOrgs(db, serverId).map((o) => [o.id, o.name] as const))
        return (["skill", "connection"] as const).flatMap((kind) =>
          rowsOf(kind, serverId).map((row) => {
            const all = row.agents === null
            const entries = orgEntriesOf(row)
            const entry = entries.find((e) => e.id === orgId)
            // The line "Now" is for a row that takes the value from above (spec 030, "Access").
            const above = all || entry ? null : orgToolNow(tree, entries, orgId)
            return {
              kind,
              id: row.id,
              name: row.name,
              choice: all ? ("on" as const) : (entry?.value ?? ("inherit" as const)),
              all,
              now: above
                ? {
                    value: above.value,
                    organization: { id: above.from, name: names.get(above.from) ?? "" },
                  }
                : null,
            }
          }),
        )
      }

      const tools = (orgId: string) =>
        need(orgId).pipe(Effect.map((row) => toolRows(row.server_id, orgId)))

      const setTool = (
        orgId: string,
        kind: "skill" | "connection",
        id: string,
        choice: OrgToolChoice,
      ) =>
        Effect.gen(function* () {
          const org = yield* need(orgId)
          const row = db.get<ToolRow>(
            `SELECT id, name, agents, organizations, enabled FROM ${tableOf(kind)}
             WHERE id = ? AND server_id = ?`,
            id,
            org.server_id,
          )
          if (!row)
            return yield* new AppError({
              code: kind === "skill" ? "skill_unavailable" : "connection_not_found",
            })
          // A tool for "All agents" has no list: the switch of an organization has no effect on it.
          if (row.agents !== null) {
            const before = orgEntriesOf(row)
            const next = withOrgSwitch(before, orgId, choice)
            if (JSON.stringify(next) !== JSON.stringify(before)) {
              db.run(
                `UPDATE ${tableOf(kind)} SET organizations = ? WHERE id = ?`,
                JSON.stringify(next),
                id,
              )
              if (kind === "skill") bus.emit("skills.changed", { serverId: org.server_id })
              else bus.emit("connections.changed", {})
            }
          }
          return toolRows(org.server_id, orgId)
        })

      const toolsOfAgent = (agentId: string) =>
        Effect.sync((): AgentOrgTool[] => {
          const agent = db.get<{ server_id: string; model_account_id: string | null }>(
            "SELECT server_id, model_account_id FROM agent WHERE id = ?",
            agentId,
          )
          if (!agent || orgIdsOfAgent(db, agentId).length === 0) return []
          const names = new Map(readOrgs(db, agent.server_id).map((o) => [o.id, o.name] as const))
          // An agent on a vendor runtime has no connections (spec 018), so it has none from an organization.
          const onRuntime =
            agent.model_account_id !== null && providers.isRuntime(agent.model_account_id)
          const out: AgentOrgTool[] = []
          for (const kind of ["skill", "connection"] as const) {
            if (kind === "connection" && onRuntime) continue
            for (const row of rowsOf(kind, agent.server_id)) {
              if (row.enabled !== 1) continue
              const from = orgGiversFor(db, row, agentId)
              if (from.length === 0) continue
              out.push({
                kind,
                id: row.id,
                name: row.name,
                organizations: from.map((id) => ({ id, name: names.get(id) ?? "" })),
              })
            }
          }
          return out
        })

      return Organizations.of({
        list: (serverId) => Effect.sync(() => readOrgs(db, serverId)),
        get: (id) => need(id).pipe(Effect.map((row) => toOrg(db, row))),
        create,
        update,
        remove,
        tools,
        setTool,
        toolsOfAgent,
        limit: (id) =>
          Effect.suspend(() => {
            const view = orgLimitViewOf(db, id)
            return view === null ? Effect.fail(failNotFound()) : Effect.succeed(view)
          }),
        usage: (serverId) => Effect.sync(() => orgUsageOf(db, serverId)),
      })
    }),
  )
}
