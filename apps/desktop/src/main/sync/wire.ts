import type { SyncKind } from "@robot/shared"
import { isSyncKind } from "@robot/shared"
import { readStamp, STAMP_FUTURE_MS, type Stamp } from "./clock.ts"
import { KINDS, validId } from "./kinds.ts"

/** One field of an item with the stamp of the change that set it. */
export interface WireField {
  readonly v: unknown
  readonly s: readonly [number, number, string]
}

/**
 * A change to one item, as it crosses the link. `f` holds the fields that changed (all of them in
 * a first copy). `d` is the deletion stamp. `q` is the number of the change in the sender's log, and
 * `a` is the number of the newest change of the receiver that the sender had applied when it made
 * this one, so the receiver can tell a change made after seeing its own from one made apart.
 */
export interface WireOp {
  readonly k: SyncKind
  readonly i: string
  readonly d?: readonly [number, number, string]
  readonly f?: Readonly<Record<string, WireField>>
  readonly q?: number
  readonly a?: number
  /** The device that made the item. */
  readonly o?: string
}

export interface PushSnapshot {
  readonly total: number
  readonly done: boolean
  readonly cursor: string
}

export interface PushBatch {
  readonly ops: readonly WireOp[]
  readonly snap?: PushSnapshot
}

/** An op that passed the checks, with real stamps. */
export interface ParsedOp {
  readonly kind: SyncKind
  readonly id: string
  readonly deleted: Stamp | undefined
  readonly fields: ReadonlyMap<string, { readonly value: unknown; readonly stamp: Stamp }>
  readonly seq: number | undefined
  readonly seen: number
  readonly origin: string | undefined
}

export const MAX_OPS_PER_BATCH = 2000
export const MAX_OP_BYTES = 4 * 1024 * 1024
export const MAX_BATCH_BYTES = 6 * 1024 * 1024

const OP_KEYS = new Set(["k", "i", "d", "f", "q", "a", "o"])

/** Reads one op from the other computer. Returns undefined when anything is wrong with it. */
export const parseOp = (raw: unknown, now: number): ParsedOp | undefined => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const op = raw as Record<string, unknown>
  if (!Object.keys(op).every((k) => OP_KEYS.has(k))) return undefined
  if (!isSyncKind(op.k) || !validId(op.k, op.i)) return undefined
  const kind = op.k
  const limit = now + STAMP_FUTURE_MS
  let deleted: Stamp | undefined
  if (op.d !== undefined) {
    deleted = readStamp(op.d, limit)
    if (!deleted || op.f !== undefined) return undefined
  } else if (typeof op.f !== "object" || op.f === null || Array.isArray(op.f)) {
    return undefined
  }
  const fields = new Map<string, { value: unknown; stamp: Stamp }>()
  if (op.f !== undefined) {
    const def = KINDS[kind]
    const entries = Object.entries(op.f as Record<string, unknown>)
    if (entries.length === 0 || entries.length > Object.keys(def.fields).length) return undefined
    for (const [name, field] of entries) {
      const fd = def.fields[name]
      if (!fd || typeof field !== "object" || field === null || Array.isArray(field)) {
        return undefined
      }
      const wire = field as Record<string, unknown>
      if (!Object.keys(wire).every((k) => k === "v" || k === "s") || !("v" in wire)) {
        return undefined
      }
      const stamp = readStamp(wire.s, limit)
      if (!stamp || !fd.check(wire.v)) return undefined
      fields.set(name, { value: wire.v, stamp })
    }
  }
  let seq: number | undefined
  if (op.q !== undefined) {
    if (!Number.isSafeInteger(op.q) || (op.q as number) < 0) return undefined
    seq = op.q as number
  }
  let seen = 0
  if (op.a !== undefined) {
    if (!Number.isSafeInteger(op.a) || (op.a as number) < 0) return undefined
    seen = op.a as number
  }
  let origin: string | undefined
  if (op.o !== undefined) {
    if (typeof op.o !== "string" || op.o.length === 0 || op.o.length > 64) return undefined
    origin = op.o
  }
  return { kind, id: op.i as string, deleted, fields, seq, seen, origin }
}

export interface ParsedBatch {
  readonly ops: ParsedOp[]
  /** Ops that were refused because they did not pass the checks. */
  readonly refused: number
  readonly snap: PushSnapshot | undefined
}

/** Reads a push from the other computer. Returns undefined when the push itself is not valid. */
export const parseBatch = (raw: unknown, now: number): ParsedBatch | undefined => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined
  const batch = raw as Record<string, unknown>
  if (!Object.keys(batch).every((k) => k === "ops" || k === "snap")) return undefined
  if (!Array.isArray(batch.ops) || batch.ops.length > MAX_OPS_PER_BATCH) return undefined
  let snap: PushSnapshot | undefined
  if (batch.snap !== undefined) {
    const s = batch.snap as Record<string, unknown> | null
    if (
      typeof s !== "object" ||
      s === null ||
      !Number.isSafeInteger(s.total) ||
      (s.total as number) < 0 ||
      typeof s.done !== "boolean" ||
      typeof s.cursor !== "string" ||
      s.cursor.length > 300
    ) {
      return undefined
    }
    snap = { total: s.total as number, done: s.done, cursor: s.cursor }
  }
  const ops: ParsedOp[] = []
  let refused = 0
  for (const raw of batch.ops) {
    const op = parseOp(raw, now)
    if (op) ops.push(op)
    else refused++
  }
  return { ops, refused, snap }
}
