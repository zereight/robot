import { type SkillAfterAgentDelete, skillAfterAgentDelete } from "@robot/shared"
import type { DatabaseService } from "./Database.ts"
import { orgEntriesOf } from "./orgData.ts"

// What happens to the skills of a server when one of its agents is deleted (spec 017, "Rules").
// These are plain functions on the database: the delete of the agent calls them, and so does the
// removal of an agent that arrives from the other computer in a sync (spec 019). Skills do not
// sync, so each computer cleans its own.

interface SkillAgentsRow {
  id: string
  agents: string | null
  channels: string
  organizations: string
}

/** A JSON list of ids, or `undefined` when the text holds no readable list. */
const listOf = (text: string | null): readonly string[] | undefined => {
  if (text === null) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) && parsed.every((id) => typeof id === "string")
      ? (parsed as string[])
      : undefined
  } catch {
    return undefined
  }
}

/** The list of agent ids of a row, or `undefined` when the row holds no readable list. */
const idsOf = (row: SkillAgentsRow): readonly string[] | undefined => listOf(row.agents)

/** What would happen to each skill of the server of the agent if the agent were deleted. */
const plan = (db: DatabaseService, agentId: string) => {
  const serverId = db.get<{ server_id: string }>(
    "SELECT server_id FROM agent WHERE id = ?",
    agentId,
  )?.server_id
  if (serverId === undefined) return { serverId, steps: [] }
  const exists = (id: string) => Boolean(db.get("SELECT 1 FROM agent WHERE id = ?", id))
  const channelExists = (id: string) => Boolean(db.get("SELECT 1 FROM channel WHERE id = ?", id))
  const orgExists = (id: string) => Boolean(db.get("SELECT 1 FROM org_unit WHERE id = ?", id))
  const steps: { id: string; after: SkillAfterAgentDelete }[] = []
  for (const row of db.all<SkillAgentsRow>(
    "SELECT id, agents, channels, organizations FROM skill WHERE server_id = ? AND agents IS NOT NULL",
    serverId,
  )) {
    const ids = idsOf(row)
    if (!ids) continue
    // A channel or an organization in the list that is still there keeps the skill (spec 030).
    const channelsLeft = (listOf(row.channels) ?? []).filter(channelExists).length
    const orgsLeft = orgEntriesOf(row).filter((o) => o.value === "on" && orgExists(o.id)).length
    const after = skillAfterAgentDelete(ids, agentId, exists, channelsLeft + orgsLeft)
    if (after.kind !== "same") steps.push({ id: row.id, after })
  }
  return { serverId, steps }
}

/** How many skills a delete of the agent would delete: those that are only for this agent. */
export const skillsOnlyFor = (db: DatabaseService, agentId: string): number =>
  plan(db, agentId).steps.filter((step) => step.after.kind === "delete").length

/**
 * Takes the agent out of the list of every skill that names it, and deletes each skill that was
 * only for it. Call it before the row of the agent goes, inside the same transaction. Archive
 * does not call it. Returns the server and what changed, so that the caller can tell the window.
 */
export const releaseSkills = (
  db: DatabaseService,
  agentId: string,
): {
  readonly serverId: string | undefined
  readonly deleted: number
  readonly shortened: number
} => {
  const { serverId, steps } = plan(db, agentId)
  let deleted = 0
  let shortened = 0
  for (const { id, after } of steps) {
    if (after.kind === "delete") {
      db.run("DELETE FROM skill WHERE id = ?", id)
      deleted++
    } else if (after.kind === "shorter") {
      db.run("UPDATE skill SET agents = ? WHERE id = ?", JSON.stringify(after.agentIds), id)
      shortened++
    }
  }
  return { serverId, deleted, shortened }
}
