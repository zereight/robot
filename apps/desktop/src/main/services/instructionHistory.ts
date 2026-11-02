import { randomUUID } from "node:crypto"
import {
  INSTRUCTION_HISTORY_MAX,
  type InstructionSource,
  type InstructionVersion,
} from "@robot/shared"
import type { DatabaseService } from "./Database.ts"

interface VersionRow {
  id: string
  agent_id: string
  text: string
  source: InstructionSource
  created_at: number
}

const toVersion = (r: VersionRow): InstructionVersion => ({
  id: r.id,
  agentId: r.agent_id,
  text: r.text,
  source: r.source,
  createdAt: r.created_at,
})

/** The versions of the instructions of an agent, newest first (spec 002). */
export const listVersions = (db: DatabaseService, agentId: string): InstructionVersion[] =>
  db
    .all<VersionRow>(
      "SELECT * FROM instruction_version WHERE agent_id = ? ORDER BY created_at DESC, rowid DESC",
      agentId,
    )
    .map(toVersion)

export const getVersion = (db: DatabaseService, id: string): InstructionVersion | undefined => {
  const row = db.get<VersionRow>("SELECT * FROM instruction_version WHERE id = ?", id)
  return row ? toVersion(row) : undefined
}

/** The newest version of an agent, or undefined when it has none. */
export const newestVersion = (db: DatabaseService, agentId: string) => listVersions(db, agentId)[0]

/**
 * Keeps a change of the instructions as a version, with where it came from. The first change of
 * an agent also keeps the text before it, so the user can go back to it; that text came from the
 * form that made the agent, so it counts as "profile". A change that keeps the same text makes no
 * version, except a restore, which always does. At most 50 versions stay; the oldest go first.
 * Returns the id of the new version, or null.
 */
export const recordVersion = (
  db: DatabaseService,
  agentId: string,
  before: string,
  after: string,
  source: InstructionSource,
): string | null => {
  if (before === after && source !== "restore") return null
  const now = Date.now()
  const count = db.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM instruction_version WHERE agent_id = ?",
    agentId,
  )?.n
  const insert = (text: string, from: InstructionSource, at: number) => {
    const id = randomUUID()
    db.run(
      "INSERT INTO instruction_version (id, agent_id, text, source, created_at) VALUES (?, ?, ?, ?, ?)",
      id,
      agentId,
      text,
      from,
      at,
    )
    return id
  }
  if (!count && before !== after) insert(before, "profile", now - 1)
  const id = insert(after, source, now)
  db.run(
    `DELETE FROM instruction_version WHERE agent_id = ? AND id NOT IN (
       SELECT id FROM instruction_version WHERE agent_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    agentId,
    agentId,
    INSTRUCTION_HISTORY_MAX,
  )
  return id
}
