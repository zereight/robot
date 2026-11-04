import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  AGENT_MESSAGE_KINDS,
  AGENT_NAME_MAX,
  AGENT_ROLE_MAX,
  CHANNEL_NAME_MAX,
  CHANNEL_TOPIC_MAX,
  CONNECTION_NAME_MAX,
  charLength,
  DECISIONS,
  EdgeSchema,
  ENDED_AS,
  FACE_HUES,
  FACE_SHAPES,
  HANDOVER_LIMITS,
  INSTRUCTION_SOURCES,
  isOutsideSource,
  isPlaceOutside,
  isSensitiveLabel,
  KNOWLEDGE_TITLE_MAX,
  MEMORY_USER_TEXT_MAX,
  NoteSchema,
  nameKey,
  parseOutsideSource,
  parsePlaceOutside,
  placeOutsideText,
  REVIEW_CHANGES_MAX,
  ROUTINE_NAME_MAX,
  ROUTINE_PROMPT_MAX,
  RUN_STATES,
  RUNTIME_KINDS,
  ScheduleSchema,
  SECRET_LABEL_MAX,
  SECRET_REASON_MAX,
  SKILL_INSTRUCTIONS_MAX,
  SKILL_NAME_MAX,
  STEP_KINDS,
  STEP_STATES,
  StepSchema,
  type SyncKind,
  TASK_PROGRESS,
  TASK_SOURCES,
  TASK_STATES,
  TEAMS_SENDER_MAX,
  THREAD_TITLE_MAX,
  TriggerSchema,
  VERDICTS,
  validSchedule,
  validTokenLimit,
  validWatch,
  WatchSchema,
  WORKFLOW_NAME_MAX,
  WORKFLOW_NOTES_MAX,
  WORKFLOW_STEPS_MAX,
} from "@robot/shared"
import { Schema } from "effect"
import { releaseSkills } from "../services/agentSkills.ts"
import type { DatabaseService } from "../services/Database.ts"

/** A value that can be written as JSON. */
export type Fields = Record<string, unknown>

export interface FieldDef {
  /** True when the value has the right type and size. Everything from the other computer is checked. */
  readonly check: (value: unknown) => boolean
  /** "max": the larger number wins and the field needs no stamp (read state). */
  readonly merge?: "max"
}

export interface Parent {
  readonly kind: SyncKind
  readonly id: string
}

/** What the kinds need from the app. */
export interface Ctx {
  readonly db: DatabaseService
  /** The id of this device. */
  readonly self: string
  readonly peer: () => { readonly id: string; readonly name: string } | undefined
  readonly localServerId: () => string
  /** The id of a model account here for an id of the other computer. */
  readonly accountOf: (peerAccountId: string) => string
  /** Makes a new, empty workspace folder and returns its path. */
  readonly newWorkspace: (name: string, id: string) => string
  readonly facesDir: string
  readonly removeSecret: (accountId: string) => void
  readonly now: () => number
}

export interface Read {
  readonly fields: Fields
  readonly parent: Parent | null
  /** When the row last changed, for data that has no stamp yet. */
  readonly wall: number
}

export interface KindDef {
  readonly kind: SyncKind
  /** Parents come before children. */
  readonly rank: number
  readonly fields: Readonly<Record<string, FieldDef>>
  /** Fields that a first copy of an item must hold. */
  readonly required: readonly string[]
  /** Fields that only the creator sets. A later change of them is ignored. */
  readonly fixed: readonly string[]
  count(db: DatabaseService): number
  /** Ids in order, after `after`. */
  ids(db: DatabaseService, after: string, limit: number): string[]
  read(ctx: Ctx, id: string): Read | undefined
  /** Makes the row. False when a row that it needs is missing. */
  create(ctx: Ctx, id: string, fields: Fields): boolean
  /** Writes the fields into the row. */
  write(ctx: Ctx, id: string, fields: Fields): void
  remove(ctx: Ctx, id: string): void
  /** A short name for the change list. */
  label(fields: Fields): string
  /** The folder of an agent, which a removal leaves on disk. */
  detail?(ctx: Ctx, id: string): string
}

// ------------------------------------------------------------------------------ field checks

const str =
  (max: number, min = 0) =>
  (v: unknown): boolean =>
    typeof v === "string" && v.length <= max && v.length >= min
const nullable =
  (check: (v: unknown) => boolean) =>
  (v: unknown): boolean =>
    v === null || check(v)
const int = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0
const bool = (v: unknown): boolean => typeof v === "boolean"
const oneOf =
  (list: readonly string[]) =>
  (v: unknown): boolean =>
    typeof v === "string" && list.includes(v)
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** The keys of an object must be exactly those that are allowed; the required ones must be there. */
const shape = (required: readonly string[], optional: readonly string[] = []) => {
  const all = new Set([...required, ...optional])
  return (v: Record<string, unknown>) =>
    Object.keys(v).every((k) => all.has(k)) && required.every((k) => k in v)
}

const strictly = <A>(schema: Schema.Codec<A, unknown>) => {
  const decode = Schema.decodeUnknownSync(schema, { onExcessProperty: "error" } as never)
  return (v: unknown): boolean => {
    try {
      decode(v)
      return true
    } catch {
      return false
    }
  }
}

const TEXT_MAX = 2_000_000
const SAFE_NAME = /^[^/\\]{1,255}$/
const ATTACHMENT_PATH = /^attachments\/[^/\\]{1,255}$/

/** The text of an article in a card that asks: the body, with the lines of its header. */
const ARTICLE_TEXT_MAX = 200_000

const askCheck = (v: unknown): boolean => {
  if (!isObject(v)) return false
  const timeOk = v.askedAt === undefined || int(v.askedAt)
  if (v.kind === "approval") {
    return (
      shape(["kind", "summary"], ["askedAt", "once", "outside", "sensitive"])(v) &&
      // The summary is the command text as the program or the model wrote it, so it may be as
      // long as the input of the same card. A cut would show the user less than what runs.
      str(TEXT_MAX)(v.summary) &&
      timeOk &&
      (v.once === undefined || bool(v.once)) &&
      // A guarded step in a turn that holds outside content names its first source (spec 007).
      (v.outside === undefined || isOutsideSource(v.outside)) &&
      // A step that sends data out in a turn that read a credential place names its label.
      (v.sensitive === undefined || isSensitiveLabel(v.sensitive))
    )
  }
  if (v.kind === "question") {
    return (
      timeOk &&
      shape(["kind", "question", "choices"], ["askedAt"])(v) &&
      str(5000)(v.question) &&
      Array.isArray(v.choices) &&
      v.choices.length <= 50 &&
      v.choices.every(str(1000))
    )
  }
  // A protected card (spec 020). It holds no value: the other computer shows "Answer this on".
  if (v.kind === "secret") {
    const auth = v.auth
    const authOk =
      isObject(auth) &&
      ((auth.kind === "bearer" && shape(["kind"])(auth)) ||
        (auth.kind === "header" && shape(["kind", "header"])(auth) && str(200, 1)(auth.header)) ||
        (auth.kind === "basic" && shape(["kind", "user"])(auth) && str(200, 1)(auth.user)))
    return (
      timeOk &&
      shape(["kind", "name", "label", "reason", "origin", "auth"], ["replace", "askedAt"])(v) &&
      str(40, 1)(v.name) &&
      str(SECRET_LABEL_MAX)(v.label) &&
      str(SECRET_REASON_MAX)(v.reason) &&
      str(2000, 1)(v.origin) &&
      authOk &&
      (v.replace === undefined || bool(v.replace))
    )
  }
  // The agent wants to change an article that the user edited last (spec 019). The card holds the
  // old and the new text, so that the user can answer it on either computer.
  if (v.kind === "article") {
    return (
      timeOk &&
      shape(["kind", "title", "before", "after"], ["askedAt"])(v) &&
      str(KNOWLEDGE_TITLE_MAX * 4)(v.title) &&
      str(ARTICLE_TEXT_MAX)(v.before) &&
      nullable(str(ARTICLE_TEXT_MAX))(v.after)
    )
  }
  return false
}

/**
 * What a knowledge tool did, as it shows in the card of the message (spec 019). Only this line
 * travels with the message. The articles, the sources and the change list do not sync (019), so
 * the other computer shows the line without an undo.
 */
const knowledgeNoteCheck = (v: unknown): boolean => {
  if (!isObject(v)) return false
  const title = str(KNOWLEDGE_TITLE_MAX * 4)
  if (v.kind === "read") return shape(["kind", "title"])(v) && title(v.title)
  if (v.kind === "write") {
    return (
      shape(["kind", "title", "change", "changeId"])(v) &&
      title(v.title) &&
      oneOf(["add", "edit", "delete"])(v.change) &&
      str(100, 1)(v.changeId)
    )
  }
  if (v.kind === "source") return shape(["kind", "name"])(v) && str(500)(v.name)
  if (v.kind === "failed") {
    return shape(["kind", "title", "code"])(v) && title(v.title) && str(100, 1)(v.code)
  }
  return false
}

/**
 * What the memory tool did, as it shows in the card of the message. The note holds ids only. The
 * history and the proposals do not sync (019), so the other computer shows the line as plain
 * text, with no undo and no link.
 */
const memoryNoteCheck = (v: unknown): boolean => {
  if (!isObject(v)) return false
  if (v.kind === "saved") return shape(["kind", "historyId"])(v) && str(100, 1)(v.historyId)
  if (v.kind === "suggested") return shape(["kind", "proposalId"])(v) && str(100, 1)(v.proposalId)
  return false
}

const faceCheck = (v: unknown): boolean =>
  isObject(v) &&
  shape(["shape", "hue"])(v) &&
  int(v.shape) &&
  (v.shape as number) < FACE_SHAPES &&
  int(v.hue) &&
  (v.hue as number) < FACE_HUES

const modelCheck = (v: unknown): boolean =>
  isObject(v) &&
  shape(["accountId", "model", "effort"])(v) &&
  str(100, 1)(v.accountId) &&
  str(300, 1)(v.model) &&
  nullable(str(40))(v.effort)

/** A value of one field that a change from the chat set, by the field (spec 002). */
const SETTING_VALUE: Readonly<Record<string, (v: unknown) => boolean>> = {
  name: str(AGENT_NAME_MAX * 4, 1),
  role: str(AGENT_ROLE_MAX * 4),
  instructions: str(TEXT_MAX),
  face: faceCheck,
  model: nullable(modelCheck),
  language: oneOf(["system", "en", "ko"]),
  theme: oneOf(["system", "dark", "light"]),
  textSize: oneOf(["small", "default", "large"]),
  compactPlaces: bool,
  reduceMotion: oneOf(["system", "on", "off"]),
}

/**
 * What a call of the settings tool changed (spec 002). The line and its Undo travel with the
 * message, so the user can undo the change on either computer.
 */
const settingsNoteCheck = (v: unknown): boolean => {
  if (!isObject(v) || !shape(["changes"], ["versionId", "undone"])(v)) return false
  if (v.versionId !== undefined && !str(100, 1)(v.versionId)) return false
  if (v.undone !== undefined && !bool(v.undone)) return false
  return (
    Array.isArray(v.changes) &&
    v.changes.length >= 1 &&
    v.changes.length <= 10 &&
    v.changes.every((c) => {
      if (!isObject(c) || !shape(["field", "before", "after"])(c)) return false
      const check = typeof c.field === "string" ? SETTING_VALUE[c.field] : undefined
      return check ? check(c.before) && check(c.after) : false
    })
  )
}

/** The card of a connection tool, or of a search of tools (spec 018). Names only, no arguments. */
const connectionNoteCheck = (v: unknown): boolean => {
  if (!isObject(v)) return false
  // A name of 40 characters can take two code units for each.
  if (v.kind === "call")
    return (
      shape(["kind", "connection", "tool"])(v) &&
      str(CONNECTION_NAME_MAX * 4, 1)(v.connection) &&
      str(500, 1)(v.tool)
    )
  if (v.kind === "search")
    return shape(["kind", "words", "found"])(v) && str(1000)(v.words) && int(v.found)
  return false
}

const partCheck = (v: unknown): boolean => {
  if (!isObject(v)) return false
  switch (v.kind) {
    case "text":
    case "thinking":
      return shape(["kind", "text"])(v) && str(TEXT_MAX)(v.text)
    // A skill chip syncs with its message (spec 019): its name and its copy of the instructions.
    case "skill":
      return (
        shape(["kind", "name", "instructions"])(v) &&
        // A name of 40 characters can take two code units for each.
        str(SKILL_NAME_MAX * 2, 1)(v.name) &&
        str(SKILL_INSTRUCTIONS_MAX, 1)(v.instructions)
      )
    // The line "Compacted" syncs with its summary (spec 003, 019).
    case "compacted":
      return (
        shape(["kind", "summary", "at", "auto"])(v) &&
        str(TEXT_MAX)(v.summary) &&
        int(v.at) &&
        bool(v.auto)
      )
    case "note":
      // A note travels as a code with its names. The window writes the words (spec 002, 009).
      if (v.note === "compact_failed")
        return shape(["kind", "note", "code"])(v) && str(100, 1)(v.code)
      // The muted line "<main> reached its limit. <backup> goes on." travels with the two names and
      // the reset time (spec 006, 003, 019).
      if (v.note === "backup_goes_on")
        return (
          shape(["kind", "note", "main", "backup", "until"])(v) &&
          str(600, 1)(v.main) &&
          str(600, 1)(v.backup) &&
          nullable(int)(v.until)
        )
      // The muted line "Kept going (1 of 8)" travels with the two numbers (spec 005, 019).
      if (v.note === "kept_going")
        return shape(["kind", "note", "n", "of"])(v) && int(v.n) && int(v.of)
      // The muted lines "The connection NAME is not available." and "Tools of the connection NAME wait
      // for your review." travel with the name (spec 018).
      if (v.note === "connection_down" || v.note === "connection_held")
        return shape(["kind", "note", "name"])(v) && str(CONNECTION_NAME_MAX * 4, 1)(v.name)
      // The muted line "Handed over to <name>" travels with the ids of the new thread (spec 003, 019).
      if (v.note === "handed_over")
        return (
          shape(["kind", "note", "toName", "toAgentId", "toThreadId"])(v) &&
          str(AGENT_NAME_MAX * 4, 1)(v.toName) &&
          str(100, 1)(v.toAgentId) &&
          str(100, 1)(v.toThreadId)
        )
      if (v.note === "starter_not_made")
        return (
          shape(["kind", "note", "what", "name", "why"])(v) &&
          oneOf(["routine", "skill"])(v.what) &&
          // A name of 40 characters can take two code units for each.
          str(Math.max(ROUTINE_NAME_MAX, SKILL_NAME_MAX * 2), 1)(v.name) &&
          oneOf(["limit", "error"])(v.why)
        )
      return (
        shape(["kind", "note", "routine"])(v) &&
        oneOf(["watch_unchanged"])(v.note) &&
        str(ROUTINE_NAME_MAX)(v.routine)
      )
    // The handover card syncs with the brief and the ids of the place it came from (spec 003, 019).
    case "handover":
      return (
        shape(["kind", "brief", "fromName", "fromAgentId", "fromThreadId"])(v) &&
        str(HANDOVER_LIMITS.brief * 2)(v.brief) &&
        str(AGENT_NAME_MAX * 4, 1)(v.fromName) &&
        str(100, 1)(v.fromAgentId) &&
        nullable(str(100, 1))(v.fromThreadId)
      )
    case "file":
      return (
        shape(["kind", "name", "path", "size"])(v) &&
        typeof v.name === "string" &&
        SAFE_NAME.test(v.name) &&
        v.name !== "." &&
        v.name !== ".." &&
        typeof v.path === "string" &&
        ATTACHMENT_PATH.test(v.path) &&
        !v.path.endsWith("/..") &&
        !v.path.endsWith("/.") &&
        int(v.size)
      )
    case "tool":
      return (
        shape(
          ["kind", "id", "name", "label", "state", "input", "output"],
          [
            "ask",
            "memoryId",
            "memory",
            "decision",
            "knowledge",
            "secret",
            "settings",
            "connection",
          ],
        )(v) &&
        str(200, 1)(v.id) &&
        str(200)(v.name) &&
        str(2000)(v.label) &&
        oneOf(["running", "waiting", "done", "failed"])(v.state) &&
        str(TEXT_MAX)(v.input) &&
        str(TEXT_MAX)(v.output) &&
        (v.ask === undefined || askCheck(v.ask)) &&
        (v.memoryId === undefined || str(100)(v.memoryId)) &&
        (v.memory === undefined || memoryNoteCheck(v.memory)) &&
        (v.knowledge === undefined || knowledgeNoteCheck(v.knowledge)) &&
        (v.secret === undefined || oneOf(["saved", "cancelled"])(v.secret)) &&
        (v.settings === undefined || settingsNoteCheck(v.settings)) &&
        (v.connection === undefined || connectionNoteCheck(v.connection)) &&
        (v.decision === undefined ||
          (isObject(v.decision) &&
            shape(["answer", "by"])(v.decision) &&
            oneOf(["allow", "deny"])(v.decision.answer) &&
            str(100)(v.decision.by)))
      )
    default:
      return false
  }
}

const partsCheck = (v: unknown): boolean =>
  Array.isArray(v) && v.length <= 5000 && v.every(partCheck)

const errorCheck = (v: unknown): boolean =>
  v === null ||
  (isObject(v) &&
    shape(["code", "detail", "resetsAt"])(v) &&
    str(200)(v.code) &&
    str(20_000)(v.detail) &&
    (v.resetsAt === null || int(v.resetsAt)))

const MESSAGE_STATUS = ["done", "streaming", "stopped", "failed"]
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/
const MAX_FACE_IMAGE_BYTES = 1024 * 1024

// ------------------------------------------------------------------------------ helpers

const q = {
  count: (db: DatabaseService, table: string) =>
    db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0,
  ids: (db: DatabaseService, table: string, after: string, limit: number) =>
    db
      .all<{ id: string }>(`SELECT id FROM ${table} WHERE id > ? ORDER BY id LIMIT ?`, after, limit)
      .map((r) => r.id),
}

const has = (db: DatabaseService, table: string, id: string) =>
  db.get(`SELECT 1 AS x FROM ${table} WHERE id = ?`, id) !== undefined

/** The text of the first text part, cut short, for the change list. */
const firstText = (parts: unknown): string => {
  if (!Array.isArray(parts)) return ""
  for (const part of parts as { kind?: string; text?: string }[]) {
    if (part.kind === "text" && typeof part.text === "string") {
      return [...part.text.replace(/\s+/g, " ").trim()].slice(0, 60).join("")
    }
  }
  return ""
}

const sqlValue = (value: unknown): string | number | null => {
  if (value === null || value === undefined) return null
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number" || typeof value === "string") return value
  return JSON.stringify(value)
}

/** Builds `UPDATE table SET a = ?, b = ? WHERE ...` for the given column values. */
const update = (
  db: DatabaseService,
  table: string,
  where: string,
  whereArgs: (string | number)[],
  columns: Record<string, unknown>,
) => {
  const names = Object.keys(columns)
  if (names.length === 0) return
  db.run(
    `UPDATE ${table} SET ${names.map((n) => `${n} = ?`).join(", ")} WHERE ${where}`,
    ...names.map((n) => sqlValue(columns[n])),
    ...whereArgs,
  )
}

const insert = (db: DatabaseService, table: string, columns: Record<string, unknown>) => {
  const names = Object.keys(columns)
  db.run(
    `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
    ...names.map((n) => sqlValue(columns[n])),
  )
}

/** An id of the other computer's origin, as stored: this device is NULL. */
const originColumn = (ctx: Ctx, wire: unknown) => (wire === ctx.self ? null : (wire as string))

/**
 * Where a routine or workflow runs, from a new item of the other computer (spec 019). Only the
 * user of the computer that would run it can choose that, with "Run on this computer". So an
 * item that arrives for the first time and names this computer is stored as running on the other
 * computer.
 */
const arrivingRunsOn = (ctx: Ctx, wire: unknown) =>
  wire === ctx.self ? (ctx.peer()?.id ?? null) : originColumn(ctx, wire)

// ------------------------------------------------------------------------------ account

// The kinds of account are those of the app: the three API kinds and every vendor program. The
// separate sign-in of an account (spec 006) belongs to this computer, so it is not a field here:
// an account that arrives has none, and one that leaves does not carry it.
const RUNTIME_PROVIDERS: readonly string[] = RUNTIME_KINDS
const providerKinds = [
  "openai",
  "anthropic",
  "custom",
  ...RUNTIME_PROVIDERS,
] as const satisfies readonly string[]

interface AccountRow {
  id: string
  kind: string
  name: string
  base_url: string
  created_at: number
}

const account: KindDef = {
  kind: "account",
  rank: 0,
  fields: {
    name: { check: (v) => typeof v === "string" && charLength(v.trim()) >= 1 && v.length <= 120 },
    vendor: { check: oneOf(providerKinds) },
    baseUrl: { check: str(2000) },
    createdAt: { check: int },
  },
  required: ["name", "vendor", "baseUrl", "createdAt"],
  fixed: ["createdAt"],
  count: (db) => q.count(db, "provider_account"),
  ids: (db, after, limit) => q.ids(db, "provider_account", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<AccountRow>("SELECT * FROM provider_account WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: { name: r.name, vendor: r.kind, baseUrl: r.base_url, createdAt: r.created_at },
      parent: null,
      wall: r.created_at,
    }
  },
  create: (ctx, id, f) => {
    // No key arrives with the account, and a vendor program must be connected on this computer.
    insert(ctx.db, "provider_account", {
      id,
      kind: f.vendor,
      name: (f.name as string).trim(),
      base_url: f.baseUrl,
      created_at: f.createdAt,
      off: RUNTIME_PROVIDERS.includes(f.vendor as string) ? 1 : 0,
    })
    return true
  },
  write: (ctx, id, f) =>
    update(ctx.db, "provider_account", "id = ?", [id], {
      ...(f.name !== undefined ? { name: (f.name as string).trim() } : {}),
      ...(f.vendor !== undefined ? { kind: f.vendor } : {}),
      ...(f.baseUrl !== undefined ? { base_url: f.baseUrl } : {}),
    }),
  remove: (ctx, id) => {
    ctx.removeSecret(id)
    ctx.db.run(
      "UPDATE agent SET model_account_id = NULL, model_name = NULL, model_effort = NULL WHERE model_account_id = ?",
      id,
    )
    // A backup on the account goes too (spec 006).
    ctx.db.run(
      "UPDATE agent SET backup_account_id = NULL, backup_model = NULL, backup_effort = NULL WHERE backup_account_id = ?",
      id,
    )
    ctx.db.run("DELETE FROM provider_account WHERE id = ?", id)
  },
  label: (f) => String(f.name ?? ""),
}

// ------------------------------------------------------------------------------ agent

interface AgentRow {
  id: string
  name: string
  role: string
  instructions: string
  face_shape: number
  face_hue: number
  face_image: string | null
  model_account_id: string | null
  model_name: string | null
  model_effort: string | null
  backup_account_id: string | null
  backup_model: string | null
  backup_effort: string | null
  workspace: string
  archived_at: number | null
  created_at: number
  updated_at: number
  last_read_at: number
  sensitive_mark: string | null
  outside_mark: string | null
}

const readFace = (ctx: Ctx, file: string | null) => {
  if (!file) return null
  const path = join(ctx.facesDir, file)
  return existsSync(path) ? `data:image/png;base64,${readFileSync(path).toString("base64")}` : null
}

/** Stores a picture of the other computer as a file of its own. Returns the file name. */
const storeFace = (ctx: Ctx, id: string, dataUrl: string | null, old: string | null) => {
  if (old) rmSync(join(ctx.facesDir, old), { force: true })
  if (dataUrl === null) return null
  const match = DATA_URL.exec(dataUrl)
  const bytes = match?.[2] ? Buffer.from(match[2], "base64") : undefined
  if (!bytes || bytes.length === 0 || bytes.length > MAX_FACE_IMAGE_BYTES) return null
  mkdirSync(ctx.facesDir, { recursive: true })
  const file = `${id}-${ctx.now()}.png`
  writeFileSync(join(ctx.facesDir, file), bytes)
  return file
}

const modelOf = (ctx: Ctx, value: unknown) => {
  if (!isObject(value)) return { model_account_id: null, model_name: null, model_effort: null }
  const local = ctx.accountOf(value.accountId as string)
  // An account that is not here (it was deleted) leaves the agent with no model.
  if (!has(ctx.db, "provider_account", local)) {
    return { model_account_id: null, model_name: null, model_effort: null }
  }
  return {
    model_account_id: local,
    model_name: value.model,
    model_effort: value.effort,
  }
}

/**
 * The columns of the backup model (spec 006, "Backup model"). Unlike the main model, a backup that
 * names an account that this computer lacks stays: it is not ready here, the form says so, and the
 * choice is not lost when the agent syncs back.
 */
const backupColumns = (ctx: Ctx, value: unknown) =>
  isObject(value)
    ? {
        backup_account_id: ctx.accountOf(value.accountId as string),
        backup_model: value.model,
        backup_effort: value.effort,
      }
    : { backup_account_id: null, backup_model: null, backup_effort: null }

const modelShape = (v: unknown) =>
  isObject(v) &&
  shape(["accountId", "model", "effort"])(v) &&
  str(100, 1)(v.accountId) &&
  str(300, 1)(v.model) &&
  nullable(str(40))(v.effort)

const agent: KindDef = {
  kind: "agent",
  rank: 1,
  fields: {
    name: {
      check: (v) => {
        if (typeof v !== "string") return false
        const n = charLength(v.trim())
        return n >= 1 && n <= AGENT_NAME_MAX
      },
    },
    role: { check: (v) => typeof v === "string" && charLength(v) <= AGENT_ROLE_MAX },
    instructions: { check: str(500_000) },
    face: {
      check: (v) =>
        isObject(v) &&
        shape(["shape", "hue"])(v) &&
        Number.isInteger(v.shape) &&
        (v.shape as number) >= 0 &&
        (v.shape as number) < FACE_SHAPES &&
        Number.isInteger(v.hue) &&
        (v.hue as number) >= 0 &&
        (v.hue as number) < FACE_HUES,
    },
    faceImage: { check: nullable((v) => typeof v === "string" && v.length < 1_500_000) },
    model: {
      check: nullable(
        (v) =>
          isObject(v) &&
          shape(["accountId", "model", "effort"])(v) &&
          str(100, 1)(v.accountId) &&
          str(300, 1)(v.model) &&
          nullable(str(40))(v.effort),
      ),
    },
    // The backup model is a setting of the agent and syncs with it (spec 019). The hold of the main
    // model is a state of one computer and never travels. A computer of an older step has none.
    backupModel: { check: nullable(modelShape) },
    archived: { check: bool },
    // The mark of a sensitive read of the chat (spec 007). A computer of an older step has none.
    sensitive: { check: nullable(isSensitiveLabel) },
    // The outside content that the next turns of the chat hold, with the program mark (spec 007).
    // A computer of an older step has none.
    outside: { check: nullable(isPlaceOutside) },
    readAt: { check: int, merge: "max" },
    createdAt: { check: int },
  },
  required: ["name", "role", "instructions", "face", "model", "archived", "createdAt"],
  fixed: ["createdAt"],
  count: (db) => q.count(db, "agent"),
  ids: (db, after, limit) => q.ids(db, "agent", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<AgentRow>("SELECT * FROM agent WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: {
        name: r.name,
        role: r.role,
        instructions: r.instructions,
        face: { shape: r.face_shape, hue: r.face_hue },
        faceImage: readFace(ctx, r.face_image),
        model:
          r.model_account_id && r.model_name
            ? { accountId: r.model_account_id, model: r.model_name, effort: r.model_effort }
            : null,
        backupModel:
          r.backup_account_id && r.backup_model
            ? { accountId: r.backup_account_id, model: r.backup_model, effort: r.backup_effort }
            : null,
        archived: r.archived_at !== null,
        sensitive: isSensitiveLabel(r.sensitive_mark) ? r.sensitive_mark : null,
        outside: parsePlaceOutside(r.outside_mark),
        readAt: r.last_read_at,
        createdAt: r.created_at,
      },
      parent: null,
      wall: r.updated_at,
    }
  },
  create: (ctx, id, f) => {
    const face = f.face as { shape: number; hue: number }
    const file = typeof f.faceImage === "string" ? storeFace(ctx, id, f.faceImage, null) : null
    const now = ctx.now()
    insert(ctx.db, "agent", {
      id,
      server_id: ctx.localServerId(),
      name: (f.name as string).trim(),
      name_key: nameKey(f.name as string),
      role: (f.role as string).trim(),
      instructions: f.instructions,
      face_shape: face.shape,
      face_hue: face.hue,
      face_image: file,
      ...modelOf(ctx, f.model),
      ...backupColumns(ctx, f.backupModel),
      // A new agent has no folder of its own on this computer and asks for every step ("Ask for
      // everything", spec 019). The level is named here: it must not follow the order of the list.
      workspace: ctx.newWorkspace(f.name as string, id),
      section: "agents",
      permission: "ask_all",
      memory_enabled: 1,
      archived_at: f.archived === true ? now : null,
      sensitive_mark: isSensitiveLabel(f.sensitive) ? f.sensitive : null,
      outside_mark: placeOutsideText(isPlaceOutside(f.outside) ? f.outside : null),
      created_at: f.createdAt,
      updated_at: now,
      last_read_at: typeof f.readAt === "number" ? f.readAt : 0,
    })
    return true
  },
  write: (ctx, id, f) => {
    const row = ctx.db.get<AgentRow>("SELECT * FROM agent WHERE id = ?", id)
    if (!row) return
    const now = ctx.now()
    const columns: Record<string, unknown> = {}
    if (f.name !== undefined) {
      columns.name = (f.name as string).trim()
      columns.name_key = nameKey(f.name as string)
    }
    if (f.role !== undefined) columns.role = (f.role as string).trim()
    if (f.instructions !== undefined) columns.instructions = f.instructions
    if (f.face !== undefined) {
      const face = f.face as { shape: number; hue: number }
      columns.face_shape = face.shape
      columns.face_hue = face.hue
    }
    if (f.faceImage !== undefined) {
      columns.face_image = storeFace(
        ctx,
        id,
        typeof f.faceImage === "string" ? f.faceImage : null,
        row.face_image,
      )
    }
    if (f.model !== undefined) Object.assign(columns, modelOf(ctx, f.model))
    if (f.backupModel !== undefined) Object.assign(columns, backupColumns(ctx, f.backupModel))
    if (f.archived !== undefined) {
      columns.archived_at = f.archived ? (row.archived_at ?? now) : null
    }
    if (f.sensitive !== undefined)
      columns.sensitive_mark = isSensitiveLabel(f.sensitive) ? f.sensitive : null
    if (f.outside !== undefined)
      columns.outside_mark = placeOutsideText(isPlaceOutside(f.outside) ? f.outside : null)
    if (typeof f.readAt === "number") columns.last_read_at = Math.max(row.last_read_at, f.readAt)
    columns.updated_at = now
    update(ctx.db, "agent", "id = ?", [id], columns)
  },
  remove: (ctx, id) => {
    const row = ctx.db.get<AgentRow>("SELECT * FROM agent WHERE id = ?", id)
    if (!row) return
    if (row.face_image) rmSync(join(ctx.facesDir, row.face_image), { force: true })
    // The agent leaves the skills of this computer, as after a delete here (spec 017). Skills do
    // not sync, so each computer cleans its own.
    releaseSkills(ctx.db, id)
    // Sync never deletes files: the workspace folder stays where it is.
    ctx.db.run("DELETE FROM agent WHERE id = ?", id)
  },
  label: (f) => String(f.name ?? ""),
  detail: (ctx, id) =>
    ctx.db.get<{ workspace: string }>("SELECT workspace FROM agent WHERE id = ?", id)?.workspace ??
    "",
}

// ------------------------------------------------------------------------------ channel

interface ChannelRow {
  id: string
  name: string
  topic: string
  lead_agent_id: string | null
  review_parts: number
  sensitive_mark: string | null
  outside_mark: string | null
  created_at: number
  updated_at: number
  last_read_at: number
}

const setMembers = (ctx: Ctx, channelId: string, members: readonly string[]) => {
  ctx.db.run("DELETE FROM channel_member WHERE channel_id = ?", channelId)
  let position = 0
  for (const agentId of members) {
    if (!has(ctx.db, "agent", agentId)) continue
    ctx.db.run(
      "INSERT OR IGNORE INTO channel_member (channel_id, agent_id, position) VALUES (?, ?, ?)",
      channelId,
      agentId,
      position++,
    )
  }
}

const channel: KindDef = {
  kind: "channel",
  rank: 2,
  fields: {
    name: {
      check: (v) => {
        if (typeof v !== "string") return false
        const n = charLength(v.trim())
        return n >= 1 && n <= CHANNEL_NAME_MAX
      },
    },
    topic: { check: (v) => typeof v === "string" && charLength(v) <= CHANNEL_TOPIC_MAX },
    lead: { check: nullable(str(100, 1)) },
    // "Review parts" (spec 004). A computer of an older step has none, and it counts as off.
    reviewParts: { check: (v) => typeof v === "boolean" },
    // The mark of a sensitive read of the channel (spec 007). A computer of an older step has none.
    sensitive: { check: nullable(isSensitiveLabel) },
    // The outside content that the next turns of the channel hold, with the program mark (spec 007).
    // A computer of an older step has none.
    outside: { check: nullable(isPlaceOutside) },
    members: {
      check: (v) => Array.isArray(v) && v.length <= 500 && v.every(str(100, 1)),
    },
    readAt: { check: int, merge: "max" },
    createdAt: { check: int },
  },
  required: ["name", "topic", "lead", "members", "createdAt"],
  fixed: ["createdAt"],
  count: (db) => q.count(db, "channel"),
  ids: (db, after, limit) => q.ids(db, "channel", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<ChannelRow>("SELECT * FROM channel WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: {
        name: r.name,
        topic: r.topic,
        lead: r.lead_agent_id,
        reviewParts: r.review_parts === 1,
        sensitive: isSensitiveLabel(r.sensitive_mark) ? r.sensitive_mark : null,
        outside: parsePlaceOutside(r.outside_mark),
        members: ctx.db
          .all<{ agent_id: string }>(
            "SELECT agent_id FROM channel_member WHERE channel_id = ? ORDER BY position",
            id,
          )
          .map((m) => m.agent_id),
        readAt: r.last_read_at,
        createdAt: r.created_at,
      },
      parent: null,
      wall: r.updated_at,
    }
  },
  create: (ctx, id, f) => {
    const now = ctx.now()
    insert(ctx.db, "channel", {
      id,
      server_id: ctx.localServerId(),
      name: (f.name as string).trim(),
      name_key: nameKey(f.name as string),
      topic: f.topic,
      lead_agent_id: f.lead,
      review_parts: f.reviewParts === true ? 1 : 0,
      sensitive_mark: isSensitiveLabel(f.sensitive) ? f.sensitive : null,
      outside_mark: placeOutsideText(isPlaceOutside(f.outside) ? f.outside : null),
      created_at: f.createdAt,
      updated_at: now,
      last_read_at: typeof f.readAt === "number" ? f.readAt : 0,
    })
    setMembers(ctx, id, f.members as string[])
    return true
  },
  write: (ctx, id, f) => {
    const row = ctx.db.get<ChannelRow>("SELECT * FROM channel WHERE id = ?", id)
    if (!row) return
    const columns: Record<string, unknown> = {}
    if (f.name !== undefined) {
      columns.name = (f.name as string).trim()
      columns.name_key = nameKey(f.name as string)
    }
    if (f.topic !== undefined) columns.topic = f.topic
    if (f.lead !== undefined) columns.lead_agent_id = f.lead
    if (typeof f.reviewParts === "boolean") columns.review_parts = f.reviewParts ? 1 : 0
    if (f.sensitive !== undefined)
      columns.sensitive_mark = isSensitiveLabel(f.sensitive) ? f.sensitive : null
    if (f.outside !== undefined)
      columns.outside_mark = placeOutsideText(isPlaceOutside(f.outside) ? f.outside : null)
    if (typeof f.readAt === "number") columns.last_read_at = Math.max(row.last_read_at, f.readAt)
    columns.updated_at = ctx.now()
    update(ctx.db, "channel", "id = ?", [id], columns)
    if (f.members !== undefined) setMembers(ctx, id, f.members as string[])
  },
  remove: (ctx, id) => ctx.db.run("DELETE FROM channel WHERE id = ?", id),
  label: (f) => String(f.name ?? ""),
}

// ------------------------------------------------------------------------------ memory

interface MemoryRow {
  id: string
  agent_id: string
  text: string
  source: string
  created_at: number
  updated_at: number
}

const memory: KindDef = {
  kind: "memory",
  rank: 3,
  fields: {
    agentId: { check: str(100, 1) },
    text: {
      check: (v) =>
        typeof v === "string" && v.trim() !== "" && charLength(v) <= MEMORY_USER_TEXT_MAX,
    },
    source: { check: oneOf(["user", "agent", "proposal"]) },
    createdAt: { check: int },
    updatedAt: { check: int },
  },
  required: ["agentId", "text", "source", "createdAt", "updatedAt"],
  fixed: ["agentId", "source", "createdAt"],
  count: (db) => q.count(db, "memory"),
  ids: (db, after, limit) => q.ids(db, "memory", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<MemoryRow>("SELECT * FROM memory WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: {
        agentId: r.agent_id,
        text: r.text,
        source: r.source,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      },
      parent: { kind: "agent", id: r.agent_id },
      wall: r.updated_at,
    }
  },
  create: (ctx, id, f) => {
    if (!has(ctx.db, "agent", f.agentId as string)) return false
    insert(ctx.db, "memory", {
      id,
      agent_id: f.agentId,
      text: (f.text as string).trim(),
      source: f.source,
      created_at: f.createdAt,
      updated_at: f.updatedAt,
    })
    return true
  },
  write: (ctx, id, f) =>
    update(ctx.db, "memory", "id = ?", [id], {
      ...(f.text !== undefined ? { text: (f.text as string).trim() } : {}),
      ...(f.updatedAt !== undefined ? { updated_at: f.updatedAt } : {}),
    }),
  remove: (ctx, id) => ctx.db.run("DELETE FROM memory WHERE id = ?", id),
  label: (f) => [...String(f.text ?? "")].slice(0, 60).join(""),
}

// ------------------------------------------------------------------------------ instruction history

interface VersionRow {
  id: string
  agent_id: string
  text: string
  source: string
  created_at: number
}

/**
 * A version of the instructions of an agent (spec 002). It goes with the agent (019). A version
 * never changes; each computer drops its oldest versions over 50, and the drop syncs too.
 */
const iversion: KindDef = {
  kind: "iversion",
  rank: 3,
  fields: {
    agentId: { check: str(100, 1) },
    text: { check: str(TEXT_MAX) },
    source: { check: oneOf(INSTRUCTION_SOURCES) },
    createdAt: { check: int },
  },
  required: ["agentId", "text", "source", "createdAt"],
  fixed: ["agentId", "text", "source", "createdAt"],
  count: (db) => q.count(db, "instruction_version"),
  ids: (db, after, limit) => q.ids(db, "instruction_version", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<VersionRow>("SELECT * FROM instruction_version WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: { agentId: r.agent_id, text: r.text, source: r.source, createdAt: r.created_at },
      parent: { kind: "agent", id: r.agent_id },
      wall: r.created_at,
    }
  },
  create: (ctx, id, f) => {
    if (!has(ctx.db, "agent", f.agentId as string)) return false
    insert(ctx.db, "instruction_version", {
      id,
      agent_id: f.agentId,
      text: f.text,
      source: f.source,
      created_at: f.createdAt,
    })
    return true
  },
  write: () => {},
  remove: (ctx, id) => ctx.db.run("DELETE FROM instruction_version WHERE id = ?", id),
  label: (f) => [...String(f.text ?? "").replace(/\s+/g, " ")].slice(0, 60).join(""),
}

// ------------------------------------------------------------------------------ messages

interface MessageRow {
  id: string
  agent_id: string
  author: string
  parts: string
  status: string
  error_code: string | null
  error_detail: string | null
  error_resets_at: number | null
  reply_to: string | null
  model: string | null
  created_at: number
  finished_at: number | null
  edited_at: number | null
  from_name: string | null
  origin: string | null
  thread_id: string | null
  program_mark: string | null
  teams_sender: string | null
}

const errorOf = (r: {
  error_code: string | null
  error_detail: string | null
  error_resets_at: number | null
}) =>
  r.error_code
    ? { code: r.error_code, detail: r.error_detail ?? "", resetsAt: r.error_resets_at }
    : null

const errorColumns = (error: unknown) => {
  const e = error as { code: string; detail: string; resetsAt: number | null } | null
  return {
    error_code: e?.code ?? null,
    error_detail: e ? e.detail : null,
    error_resets_at: e?.resetsAt ?? null,
  }
}

/** The program mark of a message as the column stores it: JSON text of a source, or null. */
const markColumn = (value: unknown): string | null =>
  isOutsideSource(value) ? JSON.stringify(value) : null

const message: KindDef = {
  kind: "message",
  rank: 3,
  fields: {
    agentId: { check: str(100, 1) },
    author: { check: oneOf(["user", "agent"]) },
    parts: { check: partsCheck },
    status: { check: oneOf(MESSAGE_STATUS) },
    error: { check: errorCheck },
    replyTo: { check: nullable(str(100, 1)) },
    model: { check: nullable(str(300)) },
    createdAt: { check: int },
    finishedAt: { check: nullable(int) },
    editedAt: { check: nullable(int) },
    sender: { check: nullable(str(100)) },
    origin: { check: str(64, 1) },
    // The thread of the message (spec 003). Null for the main thread. A computer that does not
    // send it has the main thread only.
    threadId: { check: nullable(str(100, 1)) },
    // The first source of the turn that started or made the message, when that turn holds the
    // program mark (spec 007). A computer of an older step has none.
    programMark: { check: nullable(isOutsideSource) },
    // The name of the sender of a message from Teams, as the Teams page showed it (spec 028). It is
    // stored with the message, as the text is. A computer of an older step has none.
    teamsSender: { check: nullable(str(TEAMS_SENDER_MAX * 4)) },
  },
  required: [
    "agentId",
    "author",
    "parts",
    "status",
    "error",
    "replyTo",
    "model",
    "createdAt",
    "finishedAt",
    "editedAt",
    "sender",
    "origin",
  ],
  fixed: ["agentId", "author", "createdAt", "sender", "origin", "threadId", "teamsSender"],
  count: (db) => q.count(db, "message"),
  ids: (db, after, limit) => q.ids(db, "message", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<MessageRow>("SELECT * FROM message WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: {
        agentId: r.agent_id,
        author: r.author,
        parts: JSON.parse(r.parts),
        status: r.status,
        error: errorOf(r),
        replyTo: r.reply_to,
        model: r.model,
        createdAt: r.created_at,
        finishedAt: r.finished_at,
        editedAt: r.edited_at,
        sender: r.from_name,
        origin: r.origin ?? ctx.self,
        threadId: r.thread_id,
        programMark: parseOutsideSource(r.program_mark),
        teamsSender: r.teams_sender,
      },
      parent: { kind: "agent", id: r.agent_id },
      wall: Math.max(r.created_at, r.finished_at ?? 0, r.edited_at ?? 0),
    }
  },
  create: (ctx, id, f) => {
    if (!has(ctx.db, "agent", f.agentId as string)) return false
    const threadId = (f.threadId as string | null | undefined) ?? null
    // A thread of another agent is no place for the message.
    if (
      threadId !== null &&
      ctx.db.get(
        "SELECT 1 AS x FROM thread WHERE id = ? AND agent_id = ?",
        threadId,
        f.agentId as string,
      ) === undefined
    )
      return false
    const peer = ctx.peer()
    insert(ctx.db, "message", {
      id,
      agent_id: f.agentId,
      thread_id: threadId,
      author: f.author,
      parts: JSON.stringify(f.parts),
      status: f.status,
      ...errorColumns(f.error),
      reply_to: f.replyTo,
      model: f.model,
      // What ran on the other computer is not counted in the usage numbers of this one.
      input_tokens: 0,
      output_tokens: 0,
      created_at: f.createdAt,
      finished_at: f.finishedAt,
      edited_at: f.editedAt,
      from_device: peer?.id ?? null,
      from_name: (f.sender as string | null) ?? peer?.name ?? null,
      origin: originColumn(ctx, f.origin),
      program_mark: markColumn(f.programMark),
      teams_sender: (f.teamsSender as string | null | undefined) ?? null,
    })
    return true
  },
  write: (ctx, id, f) =>
    update(ctx.db, "message", "id = ?", [id], {
      ...(f.programMark !== undefined ? { program_mark: markColumn(f.programMark) } : {}),
      ...(f.parts !== undefined ? { parts: JSON.stringify(f.parts) } : {}),
      ...(f.status !== undefined ? { status: f.status } : {}),
      ...(f.error !== undefined ? errorColumns(f.error) : {}),
      ...(f.replyTo !== undefined ? { reply_to: f.replyTo } : {}),
      ...(f.model !== undefined ? { model: f.model } : {}),
      ...(f.finishedAt !== undefined ? { finished_at: f.finishedAt } : {}),
      ...(f.editedAt !== undefined ? { edited_at: f.editedAt } : {}),
    }),
  remove: (ctx, id) => ctx.db.run("DELETE FROM message WHERE id = ?", id),
  label: (f) => firstText(f.parts),
}

interface ThreadRow {
  id: string
  agent_id: string
  title: string | null
  titled: number
  created_at: number
  archived_at: number | null
  fork_thread_id: string | null
  fork_message_id: string | null
  sensitive_mark: string | null
  outside_mark: string | null
  updated_at: number
}

/**
 * A thread of an agent (spec 003, "Threads"). It syncs as messages do (019). The read time and the
 * pause of automatic compact stay on each computer.
 */
const thread: KindDef = {
  kind: "thread",
  rank: 2,
  fields: {
    agentId: { check: str(100, 1) },
    title: { check: nullable(str(THREAD_TITLE_MAX * 2, 1)) },
    titled: { check: bool },
    createdAt: { check: int },
    archivedAt: { check: nullable(int) },
    forkThreadId: { check: nullable(str(100, 1)) },
    forkMessageId: { check: nullable(str(100, 1)) },
    // The marks of the thread: a thread is a place of its own (spec 007, 019). A computer of an
    // older step has none.
    sensitive: { check: nullable(isSensitiveLabel) },
    outside: { check: nullable(isPlaceOutside) },
  },
  required: ["agentId", "title", "titled", "createdAt", "archivedAt"],
  fixed: ["agentId", "createdAt", "forkThreadId", "forkMessageId"],
  count: (db) => q.count(db, "thread"),
  ids: (db, after, limit) => q.ids(db, "thread", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<ThreadRow>("SELECT * FROM thread WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: {
        agentId: r.agent_id,
        title: r.title,
        titled: r.titled === 1,
        createdAt: r.created_at,
        archivedAt: r.archived_at,
        forkThreadId: r.fork_thread_id,
        forkMessageId: r.fork_message_id,
        sensitive: isSensitiveLabel(r.sensitive_mark) ? r.sensitive_mark : null,
        outside: parsePlaceOutside(r.outside_mark),
      },
      parent: { kind: "agent", id: r.agent_id },
      wall: Math.max(r.created_at, r.archived_at ?? 0, r.updated_at),
    }
  },
  create: (ctx, id, f) => {
    if (!has(ctx.db, "agent", f.agentId as string)) return false
    insert(ctx.db, "thread", {
      id,
      agent_id: f.agentId,
      title: f.title,
      titled: f.titled ? 1 : 0,
      created_at: f.createdAt,
      archived_at: f.archivedAt,
      fork_thread_id: f.forkThreadId ?? null,
      fork_message_id: f.forkMessageId ?? null,
      sensitive_mark: isSensitiveLabel(f.sensitive) ? f.sensitive : null,
      outside_mark: placeOutsideText(isPlaceOutside(f.outside) ? f.outside : null),
      updated_at: f.createdAt,
    })
    return true
  },
  write: (ctx, id, f) =>
    update(ctx.db, "thread", "id = ?", [id], {
      ...(f.title !== undefined ? { title: f.title } : {}),
      ...(f.titled !== undefined ? { titled: f.titled ? 1 : 0 } : {}),
      ...(f.archivedAt !== undefined ? { archived_at: f.archivedAt } : {}),
      ...(f.sensitive !== undefined
        ? {
            sensitive_mark: isSensitiveLabel(f.sensitive) ? f.sensitive : null,
            updated_at: ctx.now(),
          }
        : {}),
      ...(f.outside !== undefined
        ? {
            outside_mark: placeOutsideText(isPlaceOutside(f.outside) ? f.outside : null),
            updated_at: ctx.now(),
          }
        : {}),
    }),
  remove: (ctx, id) => ctx.db.run("DELETE FROM thread WHERE id = ?", id),
  label: (f) => (typeof f.title === "string" ? f.title : ""),
}

interface ChannelMessageRow {
  id: string
  channel_id: string
  author: string
  agent_id: string | null
  kind: string
  parts: string
  status: string
  error_code: string | null
  error_detail: string | null
  error_resets_at: number | null
  task_id: string | null
  awaiting: number
  model: string | null
  created_at: number
  finished_at: number | null
  from_name: string | null
  origin: string | null
  program_mark: string | null
  teams_sender: string | null
}

const cmessage: KindDef = {
  kind: "cmessage",
  rank: 3,
  fields: {
    channelId: { check: str(100, 1) },
    author: { check: oneOf(["user", "agent"]) },
    agentId: { check: nullable(str(100, 1)) },
    kind: { check: oneOf(["text", "plan", "summary"]) },
    parts: { check: partsCheck },
    status: { check: oneOf(MESSAGE_STATUS) },
    error: { check: errorCheck },
    taskId: { check: nullable(str(100, 1)) },
    awaiting: { check: bool },
    model: { check: nullable(str(300)) },
    createdAt: { check: int },
    finishedAt: { check: nullable(int) },
    sender: { check: nullable(str(100)) },
    origin: { check: str(64, 1) },
    // As for a message of a chat: the first source of a turn that holds the program mark.
    programMark: { check: nullable(isOutsideSource) },
    // As for a message of a chat: the name of the sender of a message from Teams (spec 028).
    teamsSender: { check: nullable(str(TEAMS_SENDER_MAX * 4)) },
  },
  required: [
    "channelId",
    "author",
    "agentId",
    "kind",
    "parts",
    "status",
    "error",
    "taskId",
    "awaiting",
    "model",
    "createdAt",
    "finishedAt",
    "sender",
    "origin",
  ],
  fixed: ["channelId", "author", "agentId", "createdAt", "sender", "origin", "teamsSender"],
  count: (db) => q.count(db, "channel_message"),
  ids: (db, after, limit) => q.ids(db, "channel_message", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<ChannelMessageRow>("SELECT * FROM channel_message WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: {
        channelId: r.channel_id,
        author: r.author,
        agentId: r.agent_id,
        kind: r.kind,
        parts: JSON.parse(r.parts),
        status: r.status,
        error: errorOf(r),
        taskId: r.task_id,
        awaiting: r.awaiting === 1,
        model: r.model,
        createdAt: r.created_at,
        finishedAt: r.finished_at,
        sender: r.from_name,
        origin: r.origin ?? ctx.self,
        programMark: parseOutsideSource(r.program_mark),
        teamsSender: r.teams_sender,
      },
      parent: { kind: "channel", id: r.channel_id },
      wall: Math.max(r.created_at, r.finished_at ?? 0),
    }
  },
  create: (ctx, id, f) => {
    if (!has(ctx.db, "channel", f.channelId as string)) return false
    const peer = ctx.peer()
    insert(ctx.db, "channel_message", {
      id,
      channel_id: f.channelId,
      author: f.author,
      agent_id: f.agentId,
      kind: f.kind,
      parts: JSON.stringify(f.parts),
      status: f.status,
      ...errorColumns(f.error),
      task_id: f.taskId,
      awaiting: f.awaiting ? 1 : 0,
      model: f.model,
      input_tokens: 0,
      output_tokens: 0,
      created_at: f.createdAt,
      finished_at: f.finishedAt,
      from_device: peer?.id ?? null,
      from_name: (f.sender as string | null) ?? peer?.name ?? null,
      origin: originColumn(ctx, f.origin),
      program_mark: markColumn(f.programMark),
      teams_sender: (f.teamsSender as string | null | undefined) ?? null,
    })
    return true
  },
  write: (ctx, id, f) =>
    update(ctx.db, "channel_message", "id = ?", [id], {
      ...(f.programMark !== undefined ? { program_mark: markColumn(f.programMark) } : {}),
      ...(f.kind !== undefined ? { kind: f.kind } : {}),
      ...(f.parts !== undefined ? { parts: JSON.stringify(f.parts) } : {}),
      ...(f.status !== undefined ? { status: f.status } : {}),
      ...(f.error !== undefined ? errorColumns(f.error) : {}),
      ...(f.taskId !== undefined ? { task_id: f.taskId } : {}),
      ...(f.awaiting !== undefined ? { awaiting: f.awaiting ? 1 : 0 } : {}),
      ...(f.model !== undefined ? { model: f.model } : {}),
      ...(f.finishedAt !== undefined ? { finished_at: f.finishedAt } : {}),
    }),
  remove: (ctx, id) => ctx.db.run("DELETE FROM channel_message WHERE id = ?", id),
  label: (f) => firstText(f.parts),
}

// ------------------------------------------------------------------------------ task

interface TaskRow {
  id: string
  agent_id: string
  prompt: string
  label: string
  source: string
  source_id: string | null
  parent_id: string | null
  retry_of: string | null
  message_id: string | null
  state: string
  error_code: string | null
  error_detail: string | null
  created_at: number
  started_at: number | null
  finished_at: number | null
  asked_at: number | null
  first_reply_at: number | null
  origin: string | null
  progress: string | null
  done_test: string | null
  verdict: string | null
  verdict_reason: string | null
  judged_at: number | null
  decided_at: number | null
  ended_at: number | null
  ended_as: string | null
  decision: string | null
  decision_text: string | null
  agent_message: string | null
  input_tokens: number | null
  output_tokens: number | null
  cached_tokens: number | null
  cost_micros: number | null
  token_limit: number | null
}

const task: KindDef = {
  kind: "task",
  rank: 4,
  fields: {
    agentId: { check: str(100, 1) },
    prompt: { check: str(TEXT_MAX) },
    label: { check: str(500) },
    source: { check: oneOf(TASK_SOURCES) },
    sourceId: { check: nullable(str(100, 1)) },
    parentId: { check: nullable(str(100, 1)) },
    retryOf: { check: nullable(str(100, 1)) },
    messageId: { check: nullable(str(100, 1)) },
    state: { check: oneOf(TASK_STATES) },
    error: {
      check: (v) =>
        v === null ||
        (isObject(v) && shape(["code", "detail"])(v) && str(200)(v.code) && str(20_000)(v.detail)),
    },
    createdAt: { check: int },
    startedAt: { check: nullable(int) },
    finishedAt: { check: nullable(int) },
    // The times of a task (spec 005). A computer of an older step has none, so they are optional.
    askedAt: { check: nullable(int) },
    firstReplyAt: { check: nullable(int) },
    origin: { check: str(64, 1) },
    // How far the turn went (spec 005). It syncs with the task; null for a task from before.
    progress: { check: nullable(oneOf(TASK_PROGRESS)) },
    // The done test, the verdict of the lead and the decision of the user (spec 004, 005, 019).
    // The done test is set when the part is made. The verdict and the decision come later.
    doneTest: { check: nullable(str(1000, 1)) },
    verdict: { check: nullable(oneOf(VERDICTS)) },
    verdictReason: { check: nullable(str(1000, 1)) },
    judgedAt: { check: nullable(int) },
    decidedAt: { check: nullable(int) },
    // The moments of a task (spec 005, 019): when the turn ended and how, and what the user decided.
    endedAt: { check: nullable(int) },
    endedAs: { check: nullable(oneOf(ENDED_AS)) },
    decision: { check: nullable(oneOf(DECISIONS)) },
    decisionText: { check: nullable(str(REVIEW_CHANGES_MAX * 2)) },
    // A send or a reply of a message from another agent (spec 029, 019). It is set when the task
    // is made. A computer of an older step has none: the task is then not counted as a hand-off.
    agentMessage: { check: nullable(oneOf(AGENT_MESSAGE_KINDS)) },
    // The usage of the task and the token limit of its run (spec 005, 009, 019). The numbers are
    // counts of tokens, never text. A computer of an older step has none, so they are optional.
    inputTokens: { check: nullable(int) },
    outputTokens: { check: nullable(int) },
    cachedTokens: { check: nullable(int) },
    costMicros: { check: nullable(int) },
    tokenLimit: { check: nullable(validTokenLimit) },
  },
  required: [
    "agentId",
    "prompt",
    "label",
    "source",
    "sourceId",
    "parentId",
    "retryOf",
    "messageId",
    "state",
    "error",
    "createdAt",
    "startedAt",
    "finishedAt",
    "origin",
    "progress",
    "doneTest",
    "verdict",
    "verdictReason",
    "judgedAt",
    "decidedAt",
    "endedAt",
    "endedAs",
    "decision",
    "decisionText",
  ],
  fixed: [
    "agentId",
    "prompt",
    "label",
    "source",
    "sourceId",
    "parentId",
    "retryOf",
    "createdAt",
    "askedAt",
    "origin",
    "doneTest",
    "agentMessage",
  ],
  count: (db) => q.count(db, "task"),
  ids: (db, after, limit) => q.ids(db, "task", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<TaskRow>("SELECT * FROM task WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: {
        agentId: r.agent_id,
        prompt: r.prompt,
        label: r.label,
        source: r.source,
        sourceId: r.source_id,
        parentId: r.parent_id,
        retryOf: r.retry_of,
        messageId: r.message_id,
        state: r.state,
        error: r.error_code ? { code: r.error_code, detail: r.error_detail ?? "" } : null,
        createdAt: r.created_at,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        askedAt: r.asked_at,
        firstReplyAt: r.first_reply_at,
        origin: r.origin ?? ctx.self,
        progress: r.progress,
        doneTest: r.done_test,
        verdict: r.verdict,
        verdictReason: r.verdict_reason,
        judgedAt: r.judged_at,
        decidedAt: r.decided_at,
        endedAt: r.ended_at,
        endedAs: r.ended_as,
        decision: r.decision,
        decisionText: r.decision_text,
        agentMessage: r.agent_message,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cachedTokens: r.cached_tokens,
        costMicros: r.cost_micros,
        tokenLimit: r.token_limit,
      },
      parent: { kind: "agent", id: r.agent_id },
      wall: r.finished_at ?? r.started_at ?? r.created_at,
    }
  },
  create: (ctx, id, f) => {
    if (!has(ctx.db, "agent", f.agentId as string)) return false
    const e = f.error as { code: string; detail: string } | null
    insert(ctx.db, "task", {
      id,
      agent_id: f.agentId,
      prompt: f.prompt,
      label: f.label,
      source: f.source,
      source_id: f.sourceId,
      parent_id: f.parentId,
      retry_of: f.retryOf,
      message_id: f.messageId,
      state: f.state,
      error_code: e?.code ?? null,
      error_detail: e ? e.detail : null,
      created_at: f.createdAt,
      started_at: f.startedAt,
      finished_at: f.finishedAt,
      asked_at: f.askedAt ?? null,
      first_reply_at: f.firstReplyAt ?? null,
      origin: originColumn(ctx, f.origin),
      progress: f.progress,
      done_test: f.doneTest ?? null,
      verdict: f.verdict ?? null,
      verdict_reason: f.verdictReason ?? null,
      judged_at: f.judgedAt ?? null,
      decided_at: f.decidedAt ?? null,
      ended_at: f.endedAt ?? null,
      ended_as: f.endedAs ?? null,
      decision: f.decision ?? null,
      decision_text: f.decisionText ?? null,
      agent_message: f.agentMessage ?? null,
      input_tokens: f.inputTokens ?? null,
      output_tokens: f.outputTokens ?? null,
      cached_tokens: f.cachedTokens ?? null,
      cost_micros: f.costMicros ?? null,
      token_limit: f.tokenLimit ?? null,
    })
    return true
  },
  write: (ctx, id, f) => {
    const e = f.error as { code: string; detail: string } | null | undefined
    update(ctx.db, "task", "id = ?", [id], {
      ...(f.progress !== undefined ? { progress: f.progress } : {}),
      ...(f.verdict !== undefined ? { verdict: f.verdict } : {}),
      ...(f.verdictReason !== undefined ? { verdict_reason: f.verdictReason } : {}),
      ...(f.judgedAt !== undefined ? { judged_at: f.judgedAt } : {}),
      ...(f.decidedAt !== undefined ? { decided_at: f.decidedAt } : {}),
      ...(f.endedAt !== undefined ? { ended_at: f.endedAt } : {}),
      ...(f.endedAs !== undefined ? { ended_as: f.endedAs } : {}),
      ...(f.decision !== undefined ? { decision: f.decision } : {}),
      ...(f.decisionText !== undefined ? { decision_text: f.decisionText } : {}),
      ...(f.messageId !== undefined ? { message_id: f.messageId } : {}),
      ...(f.state !== undefined ? { state: f.state } : {}),
      ...(f.error !== undefined
        ? { error_code: e?.code ?? null, error_detail: e ? e.detail : null }
        : {}),
      ...(f.startedAt !== undefined ? { started_at: f.startedAt } : {}),
      ...(f.finishedAt !== undefined ? { finished_at: f.finishedAt } : {}),
      ...(f.firstReplyAt !== undefined ? { first_reply_at: f.firstReplyAt } : {}),
      ...(f.inputTokens !== undefined ? { input_tokens: f.inputTokens } : {}),
      ...(f.outputTokens !== undefined ? { output_tokens: f.outputTokens } : {}),
      ...(f.cachedTokens !== undefined ? { cached_tokens: f.cachedTokens } : {}),
      ...(f.costMicros !== undefined ? { cost_micros: f.costMicros } : {}),
    })
  },
  remove: (ctx, id) => ctx.db.run("DELETE FROM task WHERE id = ?", id),
  label: (f) => String(f.label ?? ""),
}

// ------------------------------------------------------------------------------ routine

interface RoutineRow {
  id: string
  agent_id: string
  name: string
  prompt: string
  schedule: string
  channel_id: string | null
  enabled: number
  created_at: number
  updated_at: number
  runs_on: string | null
  watch: string | null
  model_account_id: string | null
  model_name: string | null
  model_effort: string | null
  token_limit: number | null
}

const isSchedule = strictly(ScheduleSchema as unknown as Schema.Codec<unknown, unknown>)
const isWatch = strictly(WatchSchema as unknown as Schema.Codec<unknown, unknown>)
/**
 * The routine model as columns. The model stays also when its account is not here: a run then
 * fails as "not connected" and does not use another model (spec 009).
 */
const routineModelOf = (ctx: Ctx, value: unknown) =>
  isObject(value)
    ? {
        model_account_id: ctx.accountOf(value.accountId as string),
        model_name: value.model,
        model_effort: value.effort,
      }
    : { model_account_id: null, model_name: null, model_effort: null }

const routine: KindDef = {
  kind: "routine",
  rank: 3,
  fields: {
    agentId: { check: str(100, 1) },
    name: { check: str(ROUTINE_NAME_MAX, 1) },
    prompt: { check: str(ROUTINE_PROMPT_MAX, 1) },
    // A routine has a schedule or a watch (spec 009): the other one is null.
    schedule: {
      check: nullable(
        (v) => isSchedule(v) && validSchedule(v as Parameters<typeof validSchedule>[0]),
      ),
    },
    watch: {
      check: nullable((v) => isWatch(v) && validWatch(v as Parameters<typeof validWatch>[0])),
    },
    model: { check: nullable(modelCheck) },
    // The most tokens that one run may use (spec 009). A computer of an older step has none.
    tokenLimit: { check: nullable(validTokenLimit) },
    channelId: { check: nullable(str(100, 1)) },
    enabled: { check: bool },
    runsOn: { check: str(64, 1) },
    createdAt: { check: int },
  },
  required: [
    "agentId",
    "name",
    "prompt",
    "schedule",
    "watch",
    "model",
    "channelId",
    "enabled",
    "runsOn",
    "createdAt",
  ],
  fixed: ["agentId", "createdAt"],
  count: (db) => q.count(db, "routine"),
  ids: (db, after, limit) => q.ids(db, "routine", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<RoutineRow>("SELECT * FROM routine WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: {
        agentId: r.agent_id,
        name: r.name,
        prompt: r.prompt,
        schedule: r.watch === null ? JSON.parse(r.schedule) : null,
        watch: r.watch === null ? null : JSON.parse(r.watch),
        model:
          r.model_account_id && r.model_name
            ? { accountId: r.model_account_id, model: r.model_name, effort: r.model_effort }
            : null,
        tokenLimit: r.token_limit,
        channelId: r.channel_id,
        enabled: r.enabled === 1,
        runsOn: r.runs_on ?? ctx.self,
        createdAt: r.created_at,
      },
      parent: { kind: "agent", id: r.agent_id },
      wall: r.updated_at,
    }
  },
  create: (ctx, id, f) => {
    if (!has(ctx.db, "agent", f.agentId as string)) return false
    // Exactly one trigger.
    if ((f.schedule === null) === (f.watch === null)) return false
    const now = ctx.now()
    insert(ctx.db, "routine", {
      id,
      server_id: ctx.localServerId(),
      agent_id: f.agentId,
      name: f.name,
      prompt: f.prompt,
      schedule: JSON.stringify(f.schedule),
      watch: f.watch === null ? null : JSON.stringify(f.watch),
      ...routineModelOf(ctx, f.model),
      token_limit: f.tokenLimit ?? null,
      channel_id: f.channelId,
      enabled: f.enabled ? 1 : 0,
      // The missed-run rule counts from the time the routine came to this computer.
      last_checked_at: now,
      created_at: f.createdAt,
      updated_at: now,
      runs_on: arrivingRunsOn(ctx, f.runsOn),
    })
    return true
  },
  write: (ctx, id, f) => {
    const columns: Record<string, unknown> = {}
    if (f.name !== undefined) columns.name = f.name
    if (f.prompt !== undefined) columns.prompt = f.prompt
    if (f.schedule !== undefined) columns.schedule = JSON.stringify(f.schedule)
    if (f.watch !== undefined) columns.watch = f.watch === null ? null : JSON.stringify(f.watch)
    if (f.model !== undefined) Object.assign(columns, routineModelOf(ctx, f.model))
    if (f.tokenLimit !== undefined) columns.token_limit = f.tokenLimit
    if (f.channelId !== undefined) columns.channel_id = f.channelId
    if (f.enabled !== undefined) columns.enabled = f.enabled ? 1 : 0
    // A change that makes it run on this computer is ignored: the user here decides that.
    if (f.runsOn !== undefined && f.runsOn !== ctx.self) {
      columns.runs_on = originColumn(ctx, f.runsOn)
      columns.last_checked_at = ctx.now()
    }
    if (f.schedule !== undefined || f.enabled !== undefined) columns.last_checked_at = ctx.now()
    // A new watch keeps its first result again at its first check.
    if (f.watch !== undefined)
      ctx.db.run("UPDATE routine_state SET watch_result = NULL WHERE routine_id = ?", id)
    columns.updated_at = ctx.now()
    update(ctx.db, "routine", "id = ?", [id], columns)
  },
  remove: (ctx, id) => ctx.db.run("DELETE FROM routine WHERE id = ?", id),
  label: (f) => String(f.name ?? ""),
}

const rskip: KindDef = {
  kind: "rskip",
  rank: 4,
  fields: {
    routineId: { check: str(100, 1) },
    at: { check: int },
    kind: { check: oneOf(["missed", "skipped", "failed", "recorded"]) },
    // Why a check failed or a run could not start.
    reason: {
      check: nullable(
        (v) =>
          isObject(v) && shape(["code", "detail"])(v) && str(200)(v.code) && str(2000)(v.detail),
      ),
    },
  },
  required: ["routineId", "at", "kind"],
  fixed: ["routineId", "at", "kind"],
  count: (db) => q.count(db, "routine_skip"),
  ids: (db, after, limit) => q.ids(db, "routine_skip", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<{ routine_id: string; at: number; kind: string; reason: string | null }>(
      "SELECT * FROM routine_skip WHERE id = ?",
      id,
    )
    if (!r) return undefined
    return {
      fields: {
        routineId: r.routine_id,
        at: r.at,
        kind: r.kind,
        reason: r.reason === null ? null : JSON.parse(r.reason),
      },
      parent: { kind: "routine", id: r.routine_id },
      wall: r.at,
    }
  },
  create: (ctx, id, f) => {
    if (!has(ctx.db, "routine", f.routineId as string)) return false
    insert(ctx.db, "routine_skip", {
      id,
      routine_id: f.routineId,
      at: f.at,
      kind: f.kind,
      reason: f.reason ? JSON.stringify(f.reason) : null,
    })
    return true
  },
  write: () => {},
  remove: (ctx, id) => ctx.db.run("DELETE FROM routine_skip WHERE id = ?", id),
  label: (f) => String(f.kind ?? ""),
}

// ------------------------------------------------------------------------------ workflow

interface WorkflowRow {
  id: string
  name: string
  trigger: string
  steps: string
  edges: string
  notes: string
  enabled: number
  created_at: number
  updated_at: number
  runs_on: string | null
}

const isTrigger = strictly(TriggerSchema as unknown as Schema.Codec<unknown, unknown>)
const isSteps = strictly(
  Schema.Array(StepSchema).check(Schema.isMaxLength(WORKFLOW_STEPS_MAX)) as unknown as Schema.Codec<
    unknown,
    unknown
  >,
)
const isEdges = strictly(Schema.Array(EdgeSchema) as unknown as Schema.Codec<unknown, unknown>)
/** The notes on the canvas of a workflow (spec 010). They sync with the workflow (019). */
const isNotes = strictly(
  Schema.Array(NoteSchema).check(Schema.isMaxLength(WORKFLOW_NOTES_MAX)) as unknown as Schema.Codec<
    unknown,
    unknown
  >,
)

const workflow: KindDef = {
  kind: "workflow",
  rank: 3,
  fields: {
    name: { check: str(WORKFLOW_NAME_MAX, 1) },
    trigger: { check: isTrigger },
    steps: { check: isSteps },
    edges: { check: (v) => isEdges(v) && (v as unknown[]).length <= 500 },
    notes: { check: isNotes },
    enabled: { check: bool },
    runsOn: { check: str(64, 1) },
    createdAt: { check: int },
  },
  required: ["name", "trigger", "steps", "edges", "notes", "enabled", "runsOn", "createdAt"],
  fixed: ["createdAt"],
  count: (db) => q.count(db, "workflow"),
  ids: (db, after, limit) => q.ids(db, "workflow", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<WorkflowRow>("SELECT * FROM workflow WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: {
        name: r.name,
        trigger: JSON.parse(r.trigger),
        steps: JSON.parse(r.steps),
        edges: JSON.parse(r.edges),
        notes: JSON.parse(r.notes),
        enabled: r.enabled === 1,
        runsOn: r.runs_on ?? ctx.self,
        createdAt: r.created_at,
      },
      parent: null,
      wall: r.updated_at,
    }
  },
  create: (ctx, id, f) => {
    const now = ctx.now()
    insert(ctx.db, "workflow", {
      id,
      server_id: ctx.localServerId(),
      name: f.name,
      trigger: JSON.stringify(f.trigger),
      steps: JSON.stringify(f.steps),
      edges: JSON.stringify(f.edges),
      notes: JSON.stringify(f.notes),
      enabled: f.enabled ? 1 : 0,
      last_checked_at: now,
      created_at: f.createdAt,
      updated_at: now,
      runs_on: arrivingRunsOn(ctx, f.runsOn),
    })
    return true
  },
  write: (ctx, id, f) => {
    const columns: Record<string, unknown> = {}
    if (f.name !== undefined) columns.name = f.name
    if (f.trigger !== undefined) columns.trigger = JSON.stringify(f.trigger)
    if (f.steps !== undefined) columns.steps = JSON.stringify(f.steps)
    if (f.edges !== undefined) columns.edges = JSON.stringify(f.edges)
    if (f.notes !== undefined) columns.notes = JSON.stringify(f.notes)
    if (f.enabled !== undefined) columns.enabled = f.enabled ? 1 : 0
    // A change that makes it run on this computer is ignored: the user here decides that.
    if (f.runsOn !== undefined && f.runsOn !== ctx.self) {
      columns.runs_on = originColumn(ctx, f.runsOn)
      columns.last_checked_at = ctx.now()
    }
    if (f.trigger !== undefined || f.enabled !== undefined) columns.last_checked_at = ctx.now()
    columns.updated_at = ctx.now()
    update(ctx.db, "workflow", "id = ?", [id], columns)
  },
  remove: (ctx, id) => ctx.db.run("DELETE FROM workflow WHERE id = ?", id),
  label: (f) => String(f.name ?? ""),
}

interface RunRow {
  id: string
  workflow_id: string
  state: string
  trigger: string
  trigger_text: string
  started_at: number
  finished_at: number | null
  origin: string | null
}

const wrun: KindDef = {
  kind: "wrun",
  rank: 4,
  fields: {
    workflowId: { check: str(100, 1) },
    state: { check: oneOf(RUN_STATES) },
    trigger: { check: str(100) },
    triggerText: { check: str(TEXT_MAX) },
    startedAt: { check: int },
    finishedAt: { check: nullable(int) },
    origin: { check: str(64, 1) },
  },
  required: ["workflowId", "state", "trigger", "triggerText", "startedAt", "finishedAt", "origin"],
  fixed: ["workflowId", "trigger", "triggerText", "startedAt", "origin"],
  count: (db) => q.count(db, "workflow_run"),
  ids: (db, after, limit) => q.ids(db, "workflow_run", after, limit),
  read: (ctx, id) => {
    const r = ctx.db.get<RunRow>("SELECT * FROM workflow_run WHERE id = ?", id)
    if (!r) return undefined
    return {
      fields: {
        workflowId: r.workflow_id,
        state: r.state,
        trigger: r.trigger,
        triggerText: r.trigger_text,
        startedAt: r.started_at,
        finishedAt: r.finished_at,
        origin: r.origin ?? ctx.self,
      },
      parent: { kind: "workflow", id: r.workflow_id },
      wall: r.finished_at ?? r.started_at,
    }
  },
  create: (ctx, id, f) => {
    if (!has(ctx.db, "workflow", f.workflowId as string)) return false
    insert(ctx.db, "workflow_run", {
      id,
      workflow_id: f.workflowId,
      state: f.state,
      trigger: f.trigger,
      trigger_text: f.triggerText,
      started_at: f.startedAt,
      finished_at: f.finishedAt,
      origin: originColumn(ctx, f.origin),
    })
    return true
  },
  write: (ctx, id, f) =>
    update(ctx.db, "workflow_run", "id = ?", [id], {
      ...(f.state !== undefined ? { state: f.state } : {}),
      ...(f.finishedAt !== undefined ? { finished_at: f.finishedAt } : {}),
    }),
  remove: (ctx, id) => ctx.db.run("DELETE FROM workflow_run WHERE id = ?", id),
  label: (f) => String(f.trigger ?? ""),
}

interface StepRow {
  run_id: string
  step_id: string
  name: string
  kind: string
  state: string
  input: string
  result: string
  error: string
  branch: string
  task_id: string | null
}

const splitStepId = (id: string): [string, string] => {
  const i = id.indexOf("|")
  return [id.slice(0, i), id.slice(i + 1)]
}

const wstep: KindDef = {
  kind: "wstep",
  rank: 5,
  fields: {
    runId: { check: str(100, 1) },
    stepId: { check: str(64, 1) },
    name: { check: str(500) },
    kind: { check: oneOf(STEP_KINDS) },
    state: { check: oneOf(STEP_STATES) },
    input: { check: str(TEXT_MAX) },
    result: { check: str(TEXT_MAX) },
    error: { check: str(20_000) },
    branch: { check: str(10) },
    taskId: { check: nullable(str(100, 1)) },
  },
  required: [
    "runId",
    "stepId",
    "name",
    "kind",
    "state",
    "input",
    "result",
    "error",
    "branch",
    "taskId",
  ],
  fixed: ["runId", "stepId", "name", "kind"],
  count: (db) => q.count(db, "workflow_run_step"),
  ids: (db, after, limit) =>
    db
      .all<{ id: string }>(
        `SELECT run_id || '|' || step_id AS id FROM workflow_run_step
         WHERE run_id || '|' || step_id > ? ORDER BY run_id || '|' || step_id LIMIT ?`,
        after,
        limit,
      )
      .map((r) => r.id),
  read: (ctx, id) => {
    const [runId, stepId] = splitStepId(id)
    const r = ctx.db.get<StepRow>(
      "SELECT * FROM workflow_run_step WHERE run_id = ? AND step_id = ?",
      runId,
      stepId,
    )
    if (!r) return undefined
    const run = ctx.db.get<{ started_at: number }>(
      "SELECT started_at FROM workflow_run WHERE id = ?",
      runId,
    )
    return {
      fields: {
        runId: r.run_id,
        stepId: r.step_id,
        name: r.name,
        kind: r.kind,
        state: r.state,
        input: r.input,
        result: r.result,
        error: r.error,
        branch: r.branch,
        taskId: r.task_id,
      },
      parent: { kind: "wrun", id: r.run_id },
      wall: run?.started_at ?? 0,
    }
  },
  create: (ctx, id, f) => {
    const [runId, stepId] = splitStepId(id)
    if (f.runId !== runId || f.stepId !== stepId) return false
    if (!has(ctx.db, "workflow_run", runId)) return false
    insert(ctx.db, "workflow_run_step", {
      run_id: runId,
      step_id: stepId,
      name: f.name,
      kind: f.kind,
      state: f.state,
      input: f.input,
      result: f.result,
      error: f.error,
      branch: f.branch,
      task_id: f.taskId,
    })
    return true
  },
  write: (ctx, id, f) => {
    const [runId, stepId] = splitStepId(id)
    update(ctx.db, "workflow_run_step", "run_id = ? AND step_id = ?", [runId, stepId], {
      ...(f.state !== undefined ? { state: f.state } : {}),
      ...(f.input !== undefined ? { input: f.input } : {}),
      ...(f.result !== undefined ? { result: f.result } : {}),
      ...(f.error !== undefined ? { error: f.error } : {}),
      ...(f.branch !== undefined ? { branch: f.branch } : {}),
      ...(f.taskId !== undefined ? { task_id: f.taskId } : {}),
    })
  },
  remove: (ctx, id) => {
    const [runId, stepId] = splitStepId(id)
    ctx.db.run("DELETE FROM workflow_run_step WHERE run_id = ? AND step_id = ?", runId, stepId)
  },
  label: (f) => String(f.name ?? ""),
}

/** Every kind, by name. */
export const KINDS: Readonly<Record<SyncKind, KindDef>> = {
  account,
  agent,
  channel,
  memory,
  message,
  thread,
  cmessage,
  routine,
  workflow,
  task,
  rskip,
  wrun,
  wstep,
  iversion,
}

/** The kinds in the order in which they are copied: parents first. */
export const KIND_ORDER: readonly SyncKind[] = (Object.values(KINDS) as KindDef[])
  .slice()
  .sort((a, b) => a.rank - b.rank)
  .map((k) => k.kind)

/** The text of an item id is limited so that it can never name a path or a statement. */
export const validId = (kind: SyncKind, id: unknown): id is string =>
  typeof id === "string" &&
  (kind === "wstep"
    ? /^[A-Za-z0-9_.:-]{1,100}\|[\x21-\x7b\x7d-\x7e]{1,64}$/.test(id)
    : /^[A-Za-z0-9_.:-]{1,100}$/.test(id))
