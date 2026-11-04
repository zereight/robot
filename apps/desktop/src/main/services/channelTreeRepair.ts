import { createHash, randomUUID } from "node:crypto"
import {
  type ChangeTime,
  type RepairChannel,
  repairAfterRestore,
  repairAfterSync,
  type TreeRepairReason,
} from "@robot/shared"
import type { DatabaseService } from "./Database.ts"
import { nextMessageTime } from "./messageTime.ts"

// The repair of a broken channel tree (spec 030, "Repair"). The rules are in the shared tree
// module as pure functions. This file reads the channels, clears the parent field of each channel
// that they name, and posts the muted line in it. It is called where data comes in that was made
// elsewhere: after a sync brought changes, after a copy by sync ended, and after a restore.

/** One repair that was made: the channel, the muted line that was posted in it, and why. */
export interface TreeRepaired {
  readonly channelId: string
  /** The muted line. Absent when that line was there before (the other computer made it first). */
  readonly messageId: string | null
  readonly reason: TreeRepairReason
}

export interface RepairOptions {
  /**
   * "sync": changes of the other computer made the break, and the channel with the later parent
   * change is cleared. "restore": the check goes from the top down.
   */
  readonly mode: "sync" | "restore"
  /**
   * When the parent field of each channel changed last, from the stamps that sync keeps. Both
   * computers hold the same stamps for the same changes, so both choose the same channel.
   */
  readonly changed?: ReadonlyMap<string, ChangeTime>
  readonly now?: () => number
}

/**
 * The id of the muted line of a repair. The two computers can find the same break at the same
 * time and each post the line. With this id both make the same row, and sync keeps one line. It
 * holds the channel, the change of the field that the repair undid, and the reason. A repair with
 * no stamp (no sync) gets an id of its own: the same channel can be repaired again later.
 */
const lineId = (channelId: string, changed: ChangeTime | undefined, reason: TreeRepairReason) =>
  changed
    ? `t${createHash("sha256")
        .update(`tree-repair|${channelId}|${changed.l}.${changed.c}.${changed.n}|${reason}`)
        .digest("hex")
        .slice(0, 31)}`
    : randomUUID()

/**
 * Looks at all channels. A loop or a fourth level is repaired: the parent field of the chosen
 * channel is cleared, and the channel gets one muted line with the reason. The line makes no
 * notification and has no Undo: a repair is not a change of the user. The cleared field is a change
 * like any other, so sync sends it (spec 019). Returns the repairs that were made, none for a tree
 * that is right.
 */
export const repairChannelTree = (db: DatabaseService, options: RepairOptions): TreeRepaired[] => {
  const now = options.now ?? Date.now
  const channels = db
    .all<{ id: string; parent_channel_id: string | null; created_at: number }>(
      "SELECT id, parent_channel_id, created_at FROM channel",
    )
    .map((r): RepairChannel => {
      const changed = options.changed?.get(r.id)
      return {
        id: r.id,
        parentId: r.parent_channel_id,
        createdAt: r.created_at,
        ...(changed ? { parentChanged: changed } : {}),
      }
    })
  const repairs =
    options.mode === "restore" ? repairAfterRestore(channels) : repairAfterSync(channels)
  if (repairs.length === 0) return []
  const made: TreeRepaired[] = []
  db.transaction(() => {
    for (const { id, reason } of repairs) {
      db.run("UPDATE channel SET parent_channel_id = NULL, updated_at = ? WHERE id = ?", now(), id)
      const messageId = lineId(id, options.changed?.get(id), reason)
      if (db.get("SELECT 1 AS x FROM channel_message WHERE id = ?", messageId)) {
        made.push({ channelId: id, messageId: null, reason })
        continue
      }
      const last = db.get<{ t: number | null }>(
        "SELECT MAX(created_at) AS t FROM channel_message WHERE channel_id = ?",
        id,
      )?.t
      const at = nextMessageTime(last, now())
      db.run(
        `INSERT INTO channel_message (id, channel_id, author, agent_id, kind, parts, status, created_at, finished_at)
         VALUES (?, ?, 'agent', NULL, 'text', ?, 'done', ?, ?)`,
        messageId,
        id,
        JSON.stringify([{ kind: "note", note: "tree_repaired", why: reason }]),
        at,
        at,
      )
      made.push({ channelId: id, messageId, reason })
    }
  })
  return made
}
