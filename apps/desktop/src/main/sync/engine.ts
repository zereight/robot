import { createHash } from "node:crypto"
import {
  AGENT_NAME_MAX,
  CHANNEL_NAME_MAX,
  nameKey,
  ORG_NAME_MAX,
  SYNC_CHANGES_MAX,
  type SyncChangeEntry,
  type SyncKind,
  TOMBSTONE_KEEP_MS,
} from "@robot/shared"
import type { DatabaseService } from "../services/Database.ts"
import { type OrgRepaired, repairOrgTree } from "../services/orgRepair.ts"
import { compareStamps, HybridClock, NO_STAMP, type Stamp, sameStamp, wireStamp } from "./clock.ts"
import { type Ctx, type Fields, KIND_ORDER, KINDS, type KindDef, type Parent } from "./kinds.ts"
import type { ParsedOp, WireOp } from "./wire.ts"

/** The "authored at" mark of data that had no stamp when sync began. Any change that differs counts as made apart. */
export const ASEQ_INITIAL = 2 ** 40

export interface EngineDeps {
  readonly db: DatabaseService
  /** The id of this device. */
  readonly self: string
  readonly selfName: () => string
  readonly peer: () => { readonly id: string; readonly name: string } | undefined
  readonly localServerId: () => string
  readonly newWorkspace: (name: string, id: string) => string
  readonly facesDir: string
  readonly removeSecret: (accountId: string) => void
  /**
   * Called with the repairs of the organization tree that the engine made (spec 030, "Repair"). The
   * caller writes the line of the organization log and tells the window.
   */
  readonly onOrgRepair?: (repairs: readonly OrgRepaired[]) => void
  readonly now?: () => number
}

export interface Touch {
  readonly kind: SyncKind
  readonly id: string
  readonly action: "added" | "changed" | "deleted"
  readonly parent: Parent | null
}

export interface ApplyResult {
  /** Ops that changed something here. */
  applied: number
  /** Ops that were not valid for this computer (a missing parent, a failed write). */
  dropped: number
  readonly touches: Touch[]
}

export interface Pending {
  readonly seq: number
  readonly ver: number
  readonly kind: SyncKind
  readonly id: string
  readonly op: WireOp
}

export interface ApplyOptions {
  /** The data of the other computer replaces the data here, whatever the stamps say. */
  readonly force: boolean
  /** The ops are part of the first copy. */
  readonly snapshot: boolean
}

interface FieldRow {
  field: string
  l: number
  c: number
  n: string
  h: string
  aseq: number
}

interface ItemRow {
  origin: string
  parent_kind: SyncKind | null
  parent_id: string | null
}

const stable = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null"
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(",")}}`
}

/** A short hash of a value, to see whether a field changed without keeping a second copy of it. */
export const hashOf = (v: unknown) =>
  createHash("sha1").update(stable(v)).digest("base64url").slice(0, 22)

const stampOf = (row: FieldRow): Stamp => ({ l: row.l, c: row.c, n: row.n })

const NAMED: Partial<Record<SyncKind, number>> = {
  agent: AGENT_NAME_MAX,
  channel: CHANNEL_NAME_MAX,
  orgunit: ORG_NAME_MAX,
}

/** The table of a kind whose name is unique, when it is not the name of the kind. */
const tableOf = (kind: SyncKind): string => (kind === "orgunit" ? "org_unit" : kind)

/** The name of a changed item, shortened so that `suffix` still fits. */
export const fitName = (base: string, suffix: string, max: number) => {
  const room = Math.max(1, max - [...suffix].length)
  return `${[...base.trim()].slice(0, room).join("").trimEnd()}${suffix}`
}

/** An id for the item that keeps the text a change would lose. Both computers make the same one. */
const lostTextId = (memoryId: string, loser: Stamp) =>
  `c${createHash("sha256").update(`lost|${memoryId}|${loser.l}.${loser.c}.${loser.n}`).digest("hex").slice(0, 31)}`

/**
 * The data side of sync (spec 019): records the changes of this computer with stamps, hands them
 * out in order, and applies the changes of the other computer by the rules (newest change wins per
 * field, a deletion wins, a name stays unique, no text is lost). It holds no connection.
 */
export class SyncEngine {
  readonly clock: HybridClock
  readonly ctx: Ctx
  readonly #db: DatabaseService
  readonly #deps: EngineDeps
  readonly #now: () => number
  #lastPurge = 0

  constructor(deps: EngineDeps) {
    this.#deps = deps
    this.#db = deps.db
    this.#now = deps.now ?? Date.now
    const saved = deps.db.get<{ value: string }>("SELECT value FROM sync_state WHERE key = 'hlc'")
    const state = saved ? (JSON.parse(saved.value) as { l: number; c: number }) : { l: 0, c: 0 }
    this.clock = new HybridClock(
      deps.self,
      state,
      (s) =>
        deps.db.run(
          "INSERT INTO sync_state (key, value) VALUES ('hlc', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
          JSON.stringify(s),
        ),
      this.#now,
    )
    this.ctx = {
      db: deps.db,
      self: deps.self,
      peer: deps.peer,
      localServerId: deps.localServerId,
      accountOf: (peerId) =>
        deps.db.get<{ local_id: string }>(
          "SELECT local_id FROM sync_alias WHERE peer_id = ?",
          peerId,
        )?.local_id ?? peerId,
      newWorkspace: deps.newWorkspace,
      facesDir: deps.facesDir,
      removeSecret: deps.removeSecret,
      now: this.#now,
    }
  }

  // ------------------------------------------------------------------------------ records

  #item(kind: SyncKind, id: string) {
    return this.#db.get<ItemRow>(
      "SELECT origin, parent_kind, parent_id FROM sync_item WHERE kind = ? AND id = ?",
      kind,
      id,
    )
  }

  #fieldRows(kind: SyncKind, id: string) {
    return new Map(
      this.#db
        .all<FieldRow>(
          "SELECT field, l, c, n, h, aseq FROM sync_field WHERE kind = ? AND id = ?",
          kind,
          id,
        )
        .map((r) => [r.field, r]),
    )
  }

  #register(kind: SyncKind, id: string, origin: string, parent: Parent | null, initial = 0) {
    this.#db.run(
      "INSERT OR REPLACE INTO sync_item (kind, id, origin, parent_kind, parent_id, initial) VALUES (?, ?, ?, ?, ?, ?)",
      kind,
      id,
      origin,
      parent?.kind ?? null,
      parent?.id ?? null,
      initial,
    )
  }

  #putField(kind: SyncKind, id: string, field: string, stamp: Stamp, hash: string, aseq: number) {
    this.#db.run(
      `INSERT OR REPLACE INTO sync_field (kind, id, field, l, c, n, h, aseq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      kind,
      id,
      field,
      stamp.l,
      stamp.c,
      stamp.n,
      hash,
      aseq,
    )
  }

  /** Forgets an item and the items below it. They leave no record. */
  #forget(kind: SyncKind, id: string) {
    const children = this.#db.all<{ kind: SyncKind; id: string }>(
      "SELECT kind, id FROM sync_item WHERE parent_kind = ? AND parent_id = ?",
      kind,
      id,
    )
    for (const child of children) this.#forget(child.kind, child.id)
    this.#db.run("DELETE FROM sync_item WHERE kind = ? AND id = ?", kind, id)
    this.#db.run("DELETE FROM sync_field WHERE kind = ? AND id = ?", kind, id)
    this.#db.run("DELETE FROM sync_out WHERE kind = ? AND id = ?", kind, id)
    this.#db.run("DELETE FROM sync_dirty WHERE kind = ? AND id = ?", kind, id)
  }

  #tomb(kind: SyncKind, id: string) {
    return this.#db.get<{ l: number; c: number; n: string }>(
      "SELECT l, c, n FROM sync_tomb WHERE kind = ? AND id = ?",
      kind,
      id,
    )
  }

  appliedSeq(): number {
    return (
      this.#db.get<{ applied_seq: number }>("SELECT applied_seq FROM sync_pair")?.applied_seq ?? 0
    )
  }

  // ------------------------------------------------------------------------------ own changes

  /**
   * Looks at the rows that changed and makes a change record for each one: a stamp for each field
   * that differs from what was last recorded, or a deletion record for a row that is gone. Returns
   * true when rows are left.
   */
  flush(limit = 400): boolean {
    const rows = this.#db.all<{ kind: SyncKind; id: string }>(
      "SELECT kind, id FROM sync_dirty LIMIT ?",
      limit,
    )
    if (rows.length === 0) return false
    rows.sort(
      (a, b) => KINDS[a.kind].rank - KINDS[b.kind].rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    this.#db.transaction(() => {
      for (const { kind, id } of rows) {
        this.#author(kind, id)
        this.#db.run("DELETE FROM sync_dirty WHERE kind = ? AND id = ?", kind, id)
      }
    })
    this.#purgeTombs()
    return this.#db.get("SELECT 1 AS x FROM sync_dirty LIMIT 1") !== undefined
  }

  /** Records a pending change of one row now, before the row is compared with a change of the other computer. */
  #settle(kind: SyncKind, id: string) {
    if (this.#db.get("SELECT 1 AS x FROM sync_dirty WHERE kind = ? AND id = ?", kind, id)) {
      this.#author(kind, id)
      this.#db.run("DELETE FROM sync_dirty WHERE kind = ? AND id = ?", kind, id)
    }
  }

  #author(kind: SyncKind, id: string) {
    const def = KINDS[kind]
    const item = this.#item(kind, id)
    const cur = def.read(this.ctx, id)
    if (!cur) {
      if (!item) return
      const parentGone =
        item.parent_kind !== null &&
        item.parent_id !== null &&
        (this.#tomb(item.parent_kind, item.parent_id) !== undefined ||
          KINDS[item.parent_kind].read(this.ctx, item.parent_id) === undefined)
      this.#forget(kind, id)
      // A row that went with its parent needs no record of its own: the parent's record covers it.
      if (parentGone || this.#tomb(kind, id)) return
      const stamp = this.clock.tick()
      this.#db.run(
        "INSERT OR REPLACE INTO sync_tomb (kind, id, l, c, n, at) VALUES (?, ?, ?, ?, ?, ?)",
        kind,
        id,
        stamp.l,
        stamp.c,
        stamp.n,
        this.#now(),
      )
      this.#enqueue(kind, id, { k: kind, i: id, d: wireStamp(stamp), a: this.appliedSeq() })
      return
    }
    // A row for an item that was deleted: the deletion stands.
    if (this.#tomb(kind, id)) return
    const stored = this.#fieldRows(kind, id)
    const changed: string[] = []
    for (const name of Object.keys(def.fields)) {
      const value = cur.fields[name]
      if (value === undefined) continue
      if (stored.get(name)?.h !== hashOf(value)) changed.push(name)
    }
    const isNew = !item
    if (isNew) this.#register(kind, id, this.#deps.self, cur.parent)
    if (changed.length === 0) return
    const stamp = this.clock.tick()
    const fields: Record<string, { v: unknown; s: [number, number, string] }> = {}
    for (const name of changed) fields[name] = { v: cur.fields[name], s: wireStamp(stamp) }
    const seq = this.#enqueue(kind, id, {
      k: kind,
      i: id,
      f: fields,
      a: this.appliedSeq(),
      ...(isNew ? { o: this.#deps.self } : {}),
    })
    for (const name of changed) {
      this.#putField(kind, id, name, stamp, hashOf(cur.fields[name]), seq)
    }
  }

  /** Puts a change in the log. A newer change of the same item joins the one that waits. */
  #enqueue(kind: SyncKind, id: string, op: WireOp): number {
    const old = this.#db.get<{ seq: number; op: string; ver: number }>(
      "SELECT seq, op, ver FROM sync_out WHERE kind = ? AND id = ?",
      kind,
      id,
    )
    if (!old) {
      this.#db.run(
        "INSERT INTO sync_out (kind, id, op) VALUES (?, ?, ?)",
        kind,
        id,
        JSON.stringify(op),
      )
      return (
        this.#db.get<{ seq: number }>(
          "SELECT seq FROM sync_out WHERE kind = ? AND id = ?",
          kind,
          id,
        )?.seq ?? 0
      )
    }
    const prev = JSON.parse(old.op) as WireOp
    const merged: WireOp = op.d
      ? op
      : {
          k: kind,
          i: id,
          f: { ...prev.f, ...op.f },
          a: op.a ?? 0,
          ...(prev.o || op.o ? { o: prev.o ?? op.o } : {}),
        }
    // A first copy of an item keeps its place, so a child never comes before its parent.
    if (prev.o && !op.d) {
      this.#db.run(
        "UPDATE sync_out SET op = ?, ver = ver + 1 WHERE seq = ?",
        JSON.stringify(merged),
        old.seq,
      )
      return old.seq
    }
    this.#db.run("DELETE FROM sync_out WHERE seq = ?", old.seq)
    this.#db.run(
      "INSERT INTO sync_out (kind, id, op, ver) VALUES (?, ?, ?, ?)",
      kind,
      id,
      JSON.stringify(merged),
      old.ver + 1,
    )
    return (
      this.#db.get<{ seq: number }>("SELECT seq FROM sync_out WHERE kind = ? AND id = ?", kind, id)
        ?.seq ?? 0
    )
  }

  #purgeTombs() {
    const now = this.#now()
    if (now - this.#lastPurge < 3_600_000) return
    this.#lastPurge = now
    this.#db.run("DELETE FROM sync_tomb WHERE at < ?", now - TOMBSTONE_KEEP_MS)
  }

  // ------------------------------------------------------------------------------ giving out

  /** The oldest changes that wait, within a count and a size. */
  pending(limit: number, maxBytes: number): Pending[] {
    const rows = this.#db.all<{ seq: number; kind: SyncKind; id: string; op: string; ver: number }>(
      "SELECT seq, kind, id, op, ver FROM sync_out ORDER BY seq LIMIT ?",
      limit,
    )
    const out: Pending[] = []
    let bytes = 0
    for (const r of rows) {
      bytes += r.op.length
      if (out.length > 0 && bytes > maxBytes) break
      out.push({
        seq: r.seq,
        ver: r.ver,
        kind: r.kind,
        id: r.id,
        op: { ...(JSON.parse(r.op) as WireOp), q: r.seq },
      })
    }
    return out
  }

  hasPending(): boolean {
    return this.#db.get("SELECT 1 AS x FROM sync_out LIMIT 1") !== undefined
  }

  pendingCount(): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_out")?.n ?? 0
  }

  /** The other computer has these changes. A change that grew meanwhile stays. */
  ack(sent: readonly Pending[]) {
    this.#db.transaction(() => {
      for (const p of sent) {
        this.#db.run("DELETE FROM sync_out WHERE seq = ? AND ver = ?", p.seq, p.ver)
      }
    })
  }

  /** Drops a change that cannot be sent (it is too large). */
  discard(p: Pending) {
    this.#db.run("DELETE FROM sync_out WHERE seq = ?", p.seq)
  }

  // ------------------------------------------------------------------------------ first copy

  /** Number of items a first copy holds. */
  snapshotTotal(): number {
    return this.#db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_item")?.n ?? 0
  }

  /**
   * Gives every row a stamp from the time it last changed. A generator: it yields after a few
   * hundred rows, so the app can do other work in between.
   */
  *stampAll(): Generator<number> {
    let count = 0
    for (const kind of KIND_ORDER) {
      let after = ""
      for (;;) {
        const ids = KINDS[kind].ids(this.#db, after, 250)
        if (ids.length === 0) break
        this.#db.transaction(() => {
          for (const id of ids) {
            this.#stampInitial(kind, id)
            this.#db.run("DELETE FROM sync_dirty WHERE kind = ? AND id = ?", kind, id)
          }
        })
        after = ids[ids.length - 1] as string
        count += ids.length
        yield count
      }
    }
  }

  #stampInitial(kind: SyncKind, id: string) {
    if (this.#item(kind, id)) return this.#settle(kind, id)
    const cur = KINDS[kind].read(this.ctx, id)
    if (!cur) return
    const stamp = this.clock.at(cur.wall)
    this.#register(kind, id, this.#deps.self, cur.parent, 1)
    for (const [name, value] of Object.entries(cur.fields)) {
      if (value === undefined || !KINDS[kind].fields[name]) continue
      this.#putField(kind, id, name, stamp, hashOf(value), ASEQ_INITIAL)
    }
  }

  /** After the first copy, a text that was only on this computer is not a change made apart any more. */
  settleInitial() {
    this.#db.run("UPDATE sync_field SET aseq = 0 WHERE aseq >= ?", ASEQ_INITIAL)
    this.#db.run("UPDATE sync_item SET initial = 0 WHERE initial = 1")
  }

  /** When the last sync with the other computer ended. Data that changed before is common to both. */
  get stoppedAt(): number {
    const row = this.#db.get<{ value: string }>(
      "SELECT value FROM sync_state WHERE key = 'last_stop'",
    )
    return row ? Number(row.value) || 0 : 0
  }

  markStopped(at = this.#now()) {
    this.#db.run(
      "INSERT INTO sync_state (key, value) VALUES ('last_stop', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      String(at),
    )
  }

  /** The next part of the first copy, in the order parents first. */
  snapshotBatch(
    cursor: string,
    maxItems: number,
    maxBytes: number,
  ): { ops: WireOp[]; cursor: string; done: boolean } {
    const [first, ...rest] = cursor.split(":")
    let kindIndex = Number(first) || 0
    let after = rest.join(":")
    const ops: WireOp[] = []
    let bytes = 0
    while (kindIndex < KIND_ORDER.length && ops.length < maxItems && bytes < maxBytes) {
      const kind = KIND_ORDER[kindIndex] as SyncKind
      const ids = this.#db
        .all<{ id: string }>(
          "SELECT id FROM sync_item WHERE kind = ? AND id > ? ORDER BY id LIMIT ?",
          kind,
          after,
          maxItems - ops.length,
        )
        .map((r) => r.id)
      if (ids.length === 0) {
        kindIndex++
        after = ""
        continue
      }
      for (const id of ids) {
        after = id
        this.#settle(kind, id)
        const op = this.#snapshotOp(kind, id)
        if (!op) continue
        ops.push(op)
        bytes += JSON.stringify(op).length
        if (bytes >= maxBytes) break
      }
    }
    return { ops, cursor: `${kindIndex}:${after}`, done: kindIndex >= KIND_ORDER.length }
  }

  #snapshotOp(kind: SyncKind, id: string): WireOp | undefined {
    const item = this.#item(kind, id)
    const cur = KINDS[kind].read(this.ctx, id)
    if (!item || !cur) return undefined
    const stored = this.#fieldRows(kind, id)
    const fields: Record<string, { v: unknown; s: [number, number, string] }> = {}
    for (const name of Object.keys(KINDS[kind].fields)) {
      const value = cur.fields[name]
      const row = stored.get(name)
      if (value === undefined || !row) continue
      fields[name] = { v: value, s: wireStamp(stampOf(row)) }
    }
    return { k: kind, i: id, f: fields, a: this.appliedSeq(), o: item.origin }
  }

  // ------------------------------------------------------------------------------ their changes

  /** Applies changes of the other computer. Each op is all or nothing. */
  apply(ops: readonly ParsedOp[], options: ApplyOptions): ApplyResult {
    const result: ApplyResult = { applied: 0, dropped: 0, touches: [] }
    this.#db.transaction(() => {
      // A change of an organization that was made here and waits for its stamp gets it before the
      // stamps of this batch count: the repair of the organization tree compares them (spec 030).
      if (ops.some((op) => op.kind === "orgunit")) this.#settleOrgs()
      for (const op of ops) {
        this.#db.run("SAVEPOINT sync_op")
        try {
          if (this.#applyOne(op, options, result)) result.applied++
          else result.dropped++
          this.#db.run("RELEASE sync_op")
        } catch (error) {
          this.#db.run("ROLLBACK TO sync_op")
          this.#db.run("RELEASE sync_op")
          result.dropped++
          console.error("sync: a change could not be applied", op.kind, String(error))
        }
      }
    })
    return result
  }

  // ------------------------------------------------------------------------------ organization tree

  /**
   * Repairs the organization tree after changes of the other computer (spec 030, "Repair", 019).
   * Two changes that are right alone can make a loop or a fourth level. The parent field of the
   * organization whose parent change is later is cleared, both computers choose the same one, and
   * the cleared field is a change like any other. `apply` does not call it: a sync sends its
   * changes in batches, and a set of changes that makes a valid tree can arrive in two of them.
   * The caller runs it after the sync has applied all the changes that it has, and after a first
   * copy is whole.
   */
  repairOrgs(): Touch[] {
    return this.#db.transaction(() => this.#repairOrgs())
  }

  /** Records the changes of organizations that were made here and wait for their stamps. */
  #settleOrgs() {
    for (const row of this.#db.all<{ id: string }>(
      "SELECT id FROM sync_dirty WHERE kind = 'orgunit'",
    ))
      this.#settle("orgunit", row.id)
  }

  #repairOrgs(): Touch[] {
    // Both computers must compare each parent change with the same stamp.
    this.#settleOrgs()
    const changed = new Map(
      this.#db
        .all<{ id: string; l: number; c: number; n: string }>(
          "SELECT id, l, c, n FROM sync_field WHERE kind = 'orgunit' AND field = 'parent'",
        )
        .map((r) => [r.id, { l: r.l, c: r.c, n: r.n }]),
    )
    const repaired = repairOrgTree(this.#db, { mode: "sync", changed, now: this.#now })
    if (repaired.length > 0) this.#deps.onOrgRepair?.(repaired)
    return repaired.map(
      (r): Touch => ({ kind: "orgunit", id: r.id, action: "changed", parent: null }),
    )
  }

  // ------------------------------------------------------------------------------ main agent

  /**
   * Keeps one main agent on a server after changes of the other computer (spec 002, 019). Two
   * computers can each turn the switch on for another agent while they are apart. Each change is
   * right alone, and together they leave two agents with the flag. The agent whose change of the
   * flag is the later one keeps it, and the flag of the others is cleared. Both computers hold the
   * same stamps, so both choose the same agent. The cleared flag is a change like any other: it
   * waits to go out, and the other computer finds nothing to repair. Returns what the window
   * needs to know.
   *
   * `apply` does not call it. The caller runs it after the sync has applied all
   * the changes that it has, and after a first copy is whole.
   */
  repairMain(): Touch[] {
    return this.#db.transaction(() => this.#repairMain())
  }

  #repairMain(): Touch[] {
    const touches: Touch[] = []
    const servers = this.#db.all<{ server_id: string }>(
      "SELECT server_id FROM agent WHERE is_main = 1 GROUP BY server_id HAVING COUNT(*) > 1",
    )
    if (servers.length === 0) return touches
    // A change made here that waits for its stamp gets it first, so both computers compare
    // the same stamps.
    for (const row of this.#db.all<{ id: string }>(
      "SELECT id FROM sync_dirty WHERE kind = 'agent'",
    ))
      this.#settle("agent", row.id)
    const stamps = new Map(
      this.#db
        .all<{ id: string; l: number; c: number; n: string }>(
          "SELECT id, l, c, n FROM sync_field WHERE kind = 'agent' AND field = 'isMain'",
        )
        .map((r) => [r.id, { l: r.l, c: r.c, n: r.n }]),
    )
    for (const { server_id } of servers) {
      const flagged = this.#db
        .all<{ id: string }>("SELECT id FROM agent WHERE server_id = ? AND is_main = 1", server_id)
        .map((r) => r.id)
      // The later change wins. Equal stamps cannot come from two computers, but the order of the
      // ids keeps the choice the same on both.
      const order = (a: string, b: string) =>
        compareStamps(stamps.get(b) ?? NO_STAMP, stamps.get(a) ?? NO_STAMP) ||
        (a < b ? -1 : a > b ? 1 : 0)
      for (const id of [...flagged].sort(order).slice(1)) {
        this.#db.run("UPDATE agent SET is_main = 0, updated_at = ? WHERE id = ?", this.#now(), id)
        touches.push({ kind: "agent", id, action: "changed", parent: null })
      }
    }
    return touches
  }

  #applyOne(op: ParsedOp, options: ApplyOptions, result: ApplyResult): boolean {
    const kind = op.kind
    const def = KINDS[kind]
    const peer = this.#deps.peer()
    if (!peer) return false
    for (const { stamp } of op.fields.values()) this.clock.observe(stamp)
    if (op.deleted) this.clock.observe(op.deleted)

    let id = op.id
    if (kind === "account") {
      const alias = this.#db.get<{ local_id: string }>(
        "SELECT local_id FROM sync_alias WHERE peer_id = ?",
        id,
      )
      if (alias) id = alias.local_id
    }
    if (options.snapshot) {
      this.#db.run("INSERT OR IGNORE INTO sync_seen (kind, id) VALUES (?, ?)", kind, id)
    }
    this.#settle(kind, id)

    if (op.deleted) return this.#applyDelete(def, id, op.deleted, result)
    const tomb = this.#tomb(kind, id)
    if (tomb) {
      // A whole item that was made again after its deletion (the user chose Keep) comes back.
      const whole =
        op.origin !== undefined &&
        def.required.every((name) => op.fields.has(name)) &&
        [...op.fields.values()].every((f) => compareStamps(f.stamp, tomb) > 0)
      if (!whole) return false
      this.#db.run("DELETE FROM sync_tomb WHERE kind = ? AND id = ?", kind, id)
    }

    let cur = def.read(this.ctx, id)
    if (!cur && kind === "account") {
      // Model accounts with the same name, vendor and address are one account.
      const match = this.#matchAccount(op)
      if (match) {
        this.#db.run(
          "INSERT OR REPLACE INTO sync_alias (peer_id, local_id) VALUES (?, ?)",
          op.id,
          match,
        )
        this.#db.run("INSERT OR IGNORE INTO sync_seen (kind, id) VALUES (?, ?)", kind, match)
        id = match
        this.#settle(kind, id)
        cur = def.read(this.ctx, id)
      }
    }
    if (!cur) return this.#applyCreate(def, id, op, options, result, peer)
    return this.#applyUpdate(def, id, op, cur.fields, options, result, peer)
  }

  #matchAccount(op: ParsedOp): string | undefined {
    const name = String(op.fields.get("name")?.value ?? "")
    const vendor = String(op.fields.get("vendor")?.value ?? "")
    const baseUrl = String(op.fields.get("baseUrl")?.value ?? "")
    const rows = this.#db.all<{ id: string; name: string; kind: string; base_url: string }>(
      "SELECT id, name, kind, base_url FROM provider_account",
    )
    return rows.find(
      (r) =>
        nameKey(r.name) === nameKey(name) &&
        r.kind === vendor &&
        r.base_url === baseUrl &&
        r.id !== op.id &&
        !this.#db.get("SELECT 1 AS x FROM sync_alias WHERE local_id = ?", r.id),
    )?.id
  }

  #applyCreate(
    def: KindDef,
    id: string,
    op: ParsedOp,
    options: ApplyOptions,
    result: ApplyResult,
    peer: { id: string; name: string },
  ): boolean {
    const kind = def.kind
    if (!def.required.every((name) => op.fields.has(name))) return false
    const fields: Fields = {}
    for (const [name, field] of op.fields) fields[name] = field.value
    if (NAMED[kind] !== undefined && typeof fields.name === "string") {
      const stamp = op.fields.get("name")?.stamp ?? NO_STAMP
      fields.name = this.#clashFree(kind, id, fields.name, stamp, options.force)
    }
    if (!def.create(this.ctx, id, fields)) return false
    const cur = def.read(this.ctx, id)
    if (!cur) return false
    this.#register(kind, id, op.origin ?? peer.id, cur.parent)
    for (const [name, value] of Object.entries(cur.fields)) {
      if (value === undefined || !def.fields[name]) continue
      this.#putField(kind, id, name, op.fields.get(name)?.stamp ?? NO_STAMP, hashOf(value), 0)
    }
    this.#db.run("DELETE FROM sync_dirty WHERE kind = ? AND id = ?", kind, id)
    this.#change(kind, id, def.label(cur.fields), "added", "")
    result.touches.push({ kind, id, action: "added", parent: cur.parent })
    return true
  }

  #applyUpdate(
    def: KindDef,
    id: string,
    op: ParsedOp,
    current: Fields,
    options: ApplyOptions,
    result: ApplyResult,
    peer: { id: string; name: string },
  ): boolean {
    const kind = def.kind
    const stored = this.#fieldRows(kind, id)
    const write: Fields = {}
    const stamps = new Map<string, Stamp>()
    for (const [name, field] of op.fields) {
      const fd = def.fields[name]
      if (!fd || def.fixed.includes(name)) continue
      const row = stored.get(name)
      const local = row ? stampOf(row) : NO_STAMP
      if (fd.merge === "max") {
        if (typeof field.value === "number" && field.value > Number(current[name] ?? 0)) {
          write[name] = field.value
          stamps.set(name, field.stamp)
        }
        continue
      }
      if (hashOf(field.value) === (row?.h ?? "")) {
        // The same value. The newer stamp is kept so that both computers hold the same one.
        if (compareStamps(field.stamp, local) > 0 && row) {
          this.#putField(kind, id, name, field.stamp, row.h, row.aseq)
        }
        continue
      }
      const stoppedAt = this.stoppedAt
      const madeApart =
        row !== undefined &&
        row.n === this.#deps.self &&
        (row.aseq >= ASEQ_INITIAL
          ? local.l > stoppedAt && field.stamp.l > stoppedAt
          : row.aseq > op.seen)
      const incomingWins = options.force || compareStamps(field.stamp, local) > 0
      if (kind === "memory" && name === "text" && madeApart && !options.force) {
        // Two computers edited one memory item while apart: the newest text stays, and the other
        // text is saved as a new item of the same agent.
        const loser = incomingWins
          ? { text: String(current.text ?? ""), stamp: local }
          : { text: String(field.value), stamp: field.stamp }
        this.#saveLostText(
          id,
          String(current.agentId ?? ""),
          String(current.source ?? "user"),
          loser,
        )
      }
      if (!incomingWins) continue
      write[name] = field.value
      stamps.set(name, field.stamp)
    }
    if (typeof write.name === "string" && NAMED[kind] !== undefined) {
      write.name = this.#clashFree(
        kind,
        id,
        write.name,
        stamps.get("name") ?? NO_STAMP,
        options.force,
      )
    }
    if (Object.keys(write).length === 0) return true
    def.write(this.ctx, id, write)
    const cur = def.read(this.ctx, id)
    if (cur) {
      for (const name of Object.keys(write)) {
        const value = cur.fields[name]
        if (value === undefined) continue
        this.#putField(kind, id, name, stamps.get(name) ?? NO_STAMP, hashOf(value), 0)
      }
      this.#change(kind, id, def.label(cur.fields), "changed", "")
      result.touches.push({ kind, id, action: "changed", parent: cur.parent })
    }
    this.#db.run("DELETE FROM sync_dirty WHERE kind = ? AND id = ?", kind, id)
    void peer
    return true
  }

  #applyDelete(def: KindDef, id: string, stamp: Stamp, result: ApplyResult): boolean {
    const kind = def.kind
    const cur = def.read(this.ctx, id)
    if (cur) {
      const detail = def.detail?.(this.ctx, id) ?? ""
      const label = def.label(cur.fields)
      def.remove(this.ctx, id)
      this.#change(kind, id, label, "deleted", detail)
      result.touches.push({ kind, id, action: "deleted", parent: cur.parent })
    }
    this.#forget(kind, id)
    this.#db.run(
      "INSERT OR REPLACE INTO sync_tomb (kind, id, l, c, n, at) VALUES (?, ?, ?, ?, ?, ?)",
      kind,
      id,
      stamp.l,
      stamp.c,
      stamp.n,
      this.#now(),
    )
    return true
  }

  // ------------------------------------------------------------------------------ names

  #authorName(stamp: Stamp | string) {
    const id = typeof stamp === "string" ? stamp : stamp.n
    return id === this.#deps.self || id === ""
      ? this.#deps.selfName()
      : (this.#deps.peer()?.name ?? id)
  }

  /** A name that no other row of the kind holds, with the origin in brackets when it is taken. */
  #uniqueName(kind: SyncKind, forId: string, base: string, authorId: string, taken?: Set<string>) {
    const max = NAMED[kind] ?? AGENT_NAME_MAX
    const suffix = ` (${this.#authorName(authorId)})`
    const free = (candidate: string) =>
      !this.#db.get(
        `SELECT 1 AS x FROM ${tableOf(kind)} WHERE name_key = ? AND id != ?`,
        nameKey(candidate),
        forId,
      ) && !taken?.has(nameKey(candidate))
    let candidate = fitName(base, suffix, max)
    for (let n = 2; !free(candidate); n++) candidate = fitName(base, `${suffix} ${n}`, max)
    return candidate
  }

  /**
   * A name stays unique (spec 002). When another item here holds the name, the one whose name was
   * set later gets the name of its origin computer in brackets. Both computers compare the same
   * two stamps, so both give the brackets to the same item.
   */
  #clashFree(kind: SyncKind, id: string, name: string, stamp: Stamp, force: boolean): string {
    const other = this.#db.get<{ id: string; name: string }>(
      `SELECT id, name FROM ${tableOf(kind)} WHERE name_key = ? AND id != ?`,
      nameKey(name),
      id,
    )
    if (!other) return name
    // A rename here that waits to be recorded counts: both computers compare the same two stamps.
    this.#settle(kind, other.id)
    const row = this.#fieldRows(kind as SyncKind, other.id).get("name")
    const otherStamp = row ? stampOf(row) : NO_STAMP
    const order = compareStamps(stamp, otherStamp) || (id < other.id ? -1 : 1)
    if (!force && order > 0) return this.#uniqueName(kind, id, name, stamp.n)
    const renamed = this.#uniqueName(kind, other.id, other.name, otherStamp.n || this.#deps.self)
    this.#db.run(
      `UPDATE ${tableOf(kind)} SET name = ?, name_key = ? WHERE id = ?`,
      renamed,
      nameKey(renamed),
      other.id,
    )
    this.#db.run(
      "UPDATE sync_field SET h = ? WHERE kind = ? AND id = ? AND field = 'name'",
      hashOf(renamed),
      kind,
      other.id,
    )
    this.#db.run("DELETE FROM sync_dirty WHERE kind = ? AND id = ?", kind, other.id)
    this.#change(kind, other.id, renamed, "changed", "")
    return name
  }

  // ------------------------------------------------------------------------------ lost text

  #saveLostText(
    memoryId: string,
    agentId: string,
    source: string,
    loser: { text: string; stamp: Stamp },
  ) {
    const def = KINDS.memory
    const id = lostTextId(memoryId, loser.stamp)
    if (def.read(this.ctx, id) || this.#tomb("memory", id)) return
    const fields: Fields = {
      agentId,
      text: loser.text,
      source,
      createdAt: loser.stamp.l,
      updatedAt: loser.stamp.l,
    }
    if (!def.create(this.ctx, id, fields)) return
    const cur = def.read(this.ctx, id)
    if (!cur) return
    // Both computers make this item with the same id and the same stamps, so it travels nowhere.
    this.#register("memory", id, loser.stamp.n, cur.parent)
    for (const [name, value] of Object.entries(cur.fields)) {
      if (value === undefined || !def.fields[name]) continue
      this.#putField("memory", id, name, loser.stamp, hashOf(value), 0)
    }
    this.#db.run("DELETE FROM sync_dirty WHERE kind = 'memory' AND id = ?", id)
    this.#change("memory", id, def.label(cur.fields), "added", "")
  }

  // ------------------------------------------------------------------------------ change list

  #change(
    kind: SyncKind,
    id: string,
    name: string,
    action: SyncChangeEntry["action"],
    detail: string,
  ) {
    // Streaming and state changes of messages and tasks would fill the list; only new messages count.
    const shown: readonly SyncKind[] = [
      "account",
      "agent",
      "channel",
      "memory",
      "routine",
      "workflow",
      "message",
      "cmessage",
    ]
    if (!shown.includes(kind)) return
    if ((kind === "message" || kind === "cmessage") && action !== "added") return
    this.#db.run(
      "INSERT INTO sync_change (at, kind, item_id, name, action, detail) VALUES (?, ?, ?, ?, ?, ?)",
      this.#now(),
      kind,
      id,
      name,
      action,
      detail,
    )
    this.#db.run(
      "DELETE FROM sync_change WHERE id <= (SELECT MAX(id) FROM sync_change) - ?",
      SYNC_CHANGES_MAX,
    )
  }

  changes(): SyncChangeEntry[] {
    return this.#db
      .all<{
        id: number
        at: number
        kind: SyncKind
        name: string
        action: string
        detail: string
      }>(
        "SELECT id, at, kind, name, action, detail FROM sync_change ORDER BY id DESC LIMIT ?",
        SYNC_CHANGES_MAX,
      )
      .map((r) => ({ ...r, action: r.action as SyncChangeEntry["action"] }))
  }

  // ------------------------------------------------------------------------------ keeping

  /**
   * The user chose Keep for items that the other computer deleted. They are made again with new
   * stamps, so they go back to the other computer (spec 019, Delete). Their children go too.
   */
  revive(kind: SyncKind, id: string) {
    this.#db.transaction(() => {
      this.#revive(kind, id)
    })
  }

  #revive(kind: SyncKind, id: string) {
    this.#settle(kind, id)
    const cur = KINDS[kind].read(this.ctx, id)
    const item = this.#item(kind, id)
    if (!cur || !item) return
    const stamp = this.clock.tick()
    const fields: Record<string, { v: unknown; s: [number, number, string] }> = {}
    for (const name of Object.keys(KINDS[kind].fields)) {
      const value = cur.fields[name]
      if (value === undefined) continue
      fields[name] = { v: value, s: wireStamp(stamp) }
    }
    this.#db.run("DELETE FROM sync_tomb WHERE kind = ? AND id = ?", kind, id)
    this.#db.run("DELETE FROM sync_out WHERE kind = ? AND id = ?", kind, id)
    const seq = this.#enqueue(kind, id, {
      k: kind,
      i: id,
      f: fields,
      a: this.appliedSeq(),
      o: item.origin,
    })
    for (const name of Object.keys(fields)) {
      this.#putField(kind, id, name, stamp, hashOf(cur.fields[name]), seq)
    }
    const children = this.#db.all<{ kind: SyncKind; id: string }>(
      "SELECT kind, id FROM sync_item WHERE parent_kind = ? AND parent_id = ? ORDER BY kind, id",
      kind,
      id,
    )
    for (const child of children) this.#revive(child.kind, child.id)
  }

  // ------------------------------------------------------------------------------ taking data

  /**
   * After a first copy that replaces the data here: removes what the other computer does not
   * have. Files stay: a removed agent leaves its workspace folder on disk. Returns how many items
   * went.
   */
  prune(): number {
    let removed = 0
    this.#db.transaction(() => {
      for (const kind of [...KIND_ORDER].reverse()) {
        const def = KINDS[kind]
        let after = ""
        for (;;) {
          const ids = def.ids(this.#db, after, 500)
          if (ids.length === 0) break
          after = ids[ids.length - 1] as string
          for (const id of ids) {
            if (this.#db.get("SELECT 1 AS x FROM sync_seen WHERE kind = ? AND id = ?", kind, id))
              continue
            // Only data that was here before the sync began can go. New data was made during the copy.
            if (
              !this.#db.get(
                "SELECT 1 AS x FROM sync_item WHERE kind = ? AND id = ? AND initial = 1",
                kind,
                id,
              )
            )
              continue
            if (!def.read(this.ctx, id)) continue
            def.remove(this.ctx, id)
            this.#forget(kind, id)
            removed++
          }
        }
      }
      this.#db.run("DELETE FROM sync_seen")
    })
    return removed
  }

  /** Removes all records of a sync. The data stays. The clock stays, so later stamps stay above old ones. */
  wipe() {
    this.#db.transaction(() => {
      for (const table of [
        "sync_item",
        "sync_field",
        "sync_tomb",
        "sync_out",
        "sync_dirty",
        "sync_seen",
        "sync_alias",
        "sync_change",
      ]) {
        this.#db.run(`DELETE FROM ${table}`)
      }
    })
  }

  // ------------------------------------------------------------------------------ comparing

  /** The same stamp on both sides means the same change. Used by tests. */
  stampOfField(kind: SyncKind, id: string, field: string): Stamp | undefined {
    const row = this.#fieldRows(kind, id).get(field)
    return row ? stampOf(row) : undefined
  }

  sameStampOfField(kind: SyncKind, id: string, field: string, other: Stamp): boolean {
    const mine = this.stampOfField(kind, id, field)
    return mine !== undefined && sameStamp(mine, other)
  }
}
