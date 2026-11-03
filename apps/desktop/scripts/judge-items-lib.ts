// The export of docs/judge-validation.md ("Data"). It reads a COPY of the database of the app and
// writes the finished parts of channel jobs that have a done test as the items that
// judge-replay-lib.ts reads. A person labels the items, and then the replay measures the verdicts.
//
// WHAT AN ITEM HOLDS (the fields are the ones at the top of judge-replay-lib.ts):
//   id        "real-0001", "real-0002", ... in the order of time. Never the id of a task.
//   group     "job-0001", ... One value for all parts of the same job. Never the id of a task.
//   tag       always "real".
//   label     the label of the part.
//   doneTest  the done test of the part.
//   reply     the FULL text of the newest reply of the part, built as the app builds it.
//   member    the name of the agent that wrote the reply.
//   channel   the name of the channel.
//   topic     the topic of the channel. Left out when the channel has none.
//   members   the members of the channel: name and role line.
//   messages  the last 12 messages of the channel that were done or stopped and older than the
//             verdict of the part, or older than the end of the last part of the job when the part
//             has no verdict. Oldest first, each as {who, text}, with "who" named as the check
//             text of the app names it: "User", the name of the agent, or "Agent".
//
// WHAT AN ITEM NEVER HOLDS: the verdict, the reason of a verdict, the decision of the user, and the
// field "human". A person must label an item without seeing them. The code below does not even
// select those columns. The state of a channel at the time of a check is not saved, so "members"
// are the members now and "messages" are rebuilt: this is close and not equal.
//
// SAFETY: the database is opened read-only, and the file is never changed. The user makes a copy
// of the database first. The output holds the conversations of the user, so it must stay outside
// the repository, it is created with mode 0600, and an existing file is not replaced unless the
// user says so. The command prints counts only. An error names a table, a column or an option,
// never a value.
import { Database } from "bun:sqlite"
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import {
  CHECK_MESSAGES,
  type CheckMember,
  type CheckMessage,
  type MessagePart,
  messageText,
} from "@robot/shared"

/** A fault that the user can read. Its message names a table, a column or an option, never a value. */
export class ItemsError extends Error {
  override readonly name = "ItemsError"
}

/** One item, as the replay reads it. There is no "human": a person adds it. */
export interface JudgeItem {
  readonly id: string
  readonly group: string
  readonly tag: "real"
  readonly label: string
  readonly doneTest: string
  readonly reply: string
  readonly member: string
  readonly channel: string
  readonly topic?: string
  readonly members: readonly CheckMember[]
  readonly messages: readonly CheckMessage[]
}

/** Counts only. Never any text of an item. */
export interface ExportSummary {
  /** The parts of channel jobs in the database, in any state. */
  readonly found: number
  /** Parts older than --since. They are out of the export and are not "skipped". */
  readonly beforeSince: number
  readonly notDone: number
  readonly noDoneTest: number
  /** Parts that are done and have a done test, and have no reply text. */
  readonly noReply: number
  /** Parts whose reply or channel cannot be read from the data. */
  readonly unreadable: number
  /** Parts that qualify but are older than the newest --limit parts. */
  readonly overLimit: number
  readonly written: number
  /** The jobs of the written items. */
  readonly jobs: number
}

export interface ExportOptions {
  /** Only parts made at this time or later (ms). Null for all. */
  readonly since: number | null
  /** At most this many parts: the newest ones. Null for all. */
  readonly limit: number | null
}

// ------------------------------------------------------------------------------ the database

/**
 * What the export reads. A database from an older version of the app can lack a newer column. The
 * check names every missing one. The verdict, its reason and the decision are not in this list on
 * purpose: they are never read.
 */
const NEEDED: Readonly<Record<string, readonly string[]>> = {
  task: [
    "id",
    "agent_id",
    "label",
    "source",
    "source_id",
    "parent_id",
    "state",
    "done_test",
    "created_at",
    "finished_at",
    "judged_at",
  ],
  agent: ["id", "name", "role"],
  channel: ["id", "name", "topic"],
  channel_member: ["channel_id", "agent_id", "position"],
  channel_message: [
    "id",
    "channel_id",
    "author",
    "agent_id",
    "parts",
    "status",
    "task_id",
    "created_at",
  ],
}

const OLDER =
  "It may come from an older version of the app. Start a newer version once, then copy the database again."

const missingFrom = (db: Database): string[] => {
  const missing: string[] = []
  for (const [table, columns] of Object.entries(NEEDED)) {
    const have = new Set(
      (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
    )
    if (have.size === 0) {
      missing.push(`the table ${table}`)
      continue
    }
    for (const column of columns) if (!have.has(column)) missing.push(`${table}.${column}`)
  }
  return missing
}

/**
 * Opens the copy read-only. The app keeps its database in WAL mode, so a copy of a closed database
 * still says "WAL" in its header, and a plain read-only open of it fails when no "-wal" file
 * stands next to it. Two ways, and neither one writes to the file:
 *  - A "-wal" file stands next to the copy: open it read-only. The committed rows in the "-wal"
 *    file are read too. SQLite may add a "-shm" file next to the copy.
 *  - No "-wal" file: open it as "immutable". The file is read as it is, with no lock, no side file.
 */
export const openCopy = (path: string): Database => {
  const file = resolve(path)
  let info: ReturnType<typeof statSync>
  try {
    info = statSync(file)
  } catch {
    throw new ItemsError("The file of --db does not exist.")
  }
  if (!info.isFile()) throw new ItemsError("--db must name a file.")
  const target = existsSync(`${file}-wal`)
    ? file
    : `${pathToFileURL(file).href}?mode=ro&immutable=1`
  const db = new Database(target, { readonly: true })
  // A second lock on writes: any statement that would write fails.
  db.run("PRAGMA query_only = ON")
  return db
}

const sqliteFault = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" && code.startsWith("SQLITE_") ? code : null
}

// ----------------------------------------------------------------------------- reading text

/** The text of a message or a reply, as the app builds it. Null when the saved parts cannot be read. */
const textOf = (parts: string): string | null => {
  try {
    const list: unknown = JSON.parse(parts)
    return Array.isArray(list) ? messageText({ parts: list as MessagePart[] }) : null
  } catch {
    return null
  }
}

const pad = (n: number) => String(n).padStart(4, "0")

interface PartRow {
  id: string
  parent_id: string
  channel_id: string
  label: string
  done_test: string | null
  state: string
  agent_name: string
  created_at: number
  finished_at: number | null
  judged_at: number | null
}

interface ChannelInfo {
  readonly name: string
  readonly topic: string
  readonly members: readonly CheckMember[]
  readonly names: ReadonlyMap<string, string>
}

const PARTS = `SELECT t.id, t.parent_id, t.source_id AS channel_id, t.label, t.done_test, t.state,
  a.name AS agent_name, t.created_at, t.finished_at, t.judged_at
  FROM task t JOIN agent a ON a.id = t.agent_id
  WHERE t.source = 'channel' AND t.source_id IS NOT NULL AND t.parent_id IS NOT NULL
  ORDER BY t.created_at, t.rowid`

const build = (db: Database, options: ExportOptions) => {
  const missing = missingFrom(db)
  if (missing.length > 0) throw new ItemsError(`The database lacks ${missing.join(", ")}. ${OLDER}`)

  const rows = db.query(PARTS).all() as PartRow[]
  // The end of the last part of each job: a part with no verdict has no moment of verdict.
  const jobEnd = new Map<string, number>()
  for (const row of rows)
    jobEnd.set(
      row.parent_id,
      Math.max(jobEnd.get(row.parent_id) ?? 0, row.finished_at ?? row.created_at),
    )

  // The same newest reply that the app reads for a part.
  const replyQuery = db.query(
    `SELECT parts FROM channel_message WHERE channel_id = ? AND task_id = ? AND author = 'agent'
     ORDER BY created_at DESC, rowid DESC LIMIT 1`,
  )
  const channelQuery = db.query("SELECT name, topic FROM channel WHERE id = ?")
  const memberQuery = db.query(
    `SELECT a.id, a.name, a.role FROM channel_member m JOIN agent a ON a.id = m.agent_id
     WHERE m.channel_id = ? ORDER BY m.position`,
  )
  const channels = new Map<string, ChannelInfo | null>()
  const channelOf = (id: string) => {
    if (channels.has(id)) return channels.get(id) ?? null
    const row = channelQuery.get(id) as { name: string; topic: string } | null
    let info: ChannelInfo | null = null
    if (row) {
      const members = memberQuery.all(id) as { id: string; name: string; role: string }[]
      info = {
        name: row.name,
        topic: row.topic,
        members: members.map((m) => ({ name: m.name, role: m.role })),
        names: new Map(members.map((m) => [m.id, m.name])),
      }
    }
    channels.set(id, info)
    return info
  }

  const counts = { beforeSince: 0, notDone: 0, noDoneTest: 0, noReply: 0, unreadable: 0 }
  const kept: { row: PartRow; reply: string; channel: ChannelInfo }[] = []
  for (const row of rows) {
    if (options.since !== null && row.created_at < options.since) {
      counts.beforeSince++
      continue
    }
    // The first reason that fits is the one that is counted.
    if (row.state !== "done") {
      counts.notDone++
      continue
    }
    if (row.done_test === null || row.done_test.trim() === "") {
      counts.noDoneTest++
      continue
    }
    const saved = replyQuery.get(row.channel_id, row.id) as { parts: string } | null
    const reply = saved ? textOf(saved.parts) : ""
    if (reply === null) {
      counts.unreadable++
      continue
    }
    if (reply.trim() === "") {
      counts.noReply++
      continue
    }
    const channel = channelOf(row.channel_id)
    if (!channel) {
      counts.unreadable++
      continue
    }
    kept.push({ row, reply, channel })
  }

  // --limit keeps the newest parts.
  let overLimit = 0
  if (options.limit !== null && kept.length > options.limit) {
    overLimit = kept.length - options.limit
    kept.splice(0, overLimit)
  }

  const messageQuery = db.query(
    `SELECT author, agent_id, parts FROM channel_message
     WHERE channel_id = ? AND status IN ('done', 'stopped') AND created_at < ?
     ORDER BY created_at DESC, rowid DESC LIMIT ${CHECK_MESSAGES}`,
  )
  const groups = new Map<string, string>()
  const items: JudgeItem[] = kept.map(({ row, reply, channel }, index) => {
    if (!groups.has(row.parent_id)) groups.set(row.parent_id, `job-${pad(groups.size + 1)}`)
    // The time of the verdict, or the end of the last part of the job when there is none.
    const before = row.judged_at ?? jobEnd.get(row.parent_id) ?? row.created_at
    const messages = (
      messageQuery.all(row.channel_id, before) as {
        author: string
        agent_id: string | null
        parts: string
      }[]
    )
      .reverse()
      .map((message) => ({
        // Named as the app names it in the check text.
        who:
          message.author === "user"
            ? "User"
            : (channel.names.get(message.agent_id ?? "") ?? "Agent"),
        text: textOf(message.parts) ?? "",
      }))
    return {
      id: `real-${pad(index + 1)}`,
      group: groups.get(row.parent_id) as string,
      tag: "real",
      label: row.label,
      doneTest: row.done_test as string,
      reply,
      member: row.agent_name,
      channel: channel.name,
      ...(channel.topic === "" ? {} : { topic: channel.topic }),
      members: channel.members,
      messages,
    } satisfies JudgeItem
  })

  const summary: ExportSummary = {
    found: rows.length,
    ...counts,
    overLimit,
    written: items.length,
    jobs: groups.size,
  }
  return { items, summary }
}

/**
 * Reads the finished parts of channel jobs from a COPY of the database. Opens it read-only and
 * closes it. Throws an ItemsError for a fault; its message names a table, a column or an option.
 */
export const exportItems = (path: string, options: ExportOptions) => {
  let db: Database | undefined
  try {
    db = openCopy(path)
    return build(db, options)
  } catch (error) {
    if (error instanceof ItemsError) throw error
    const code = sqliteFault(error)
    if (code) throw new ItemsError(`The file of --db cannot be read as a database (${code}).`)
    throw error
  } finally {
    db?.close()
  }
}

/** The text of the file: one JSON object on each line. */
export const itemsToJsonl = (items: readonly JudgeItem[]) =>
  items.map((item) => JSON.stringify(item)).join("\n") + (items.length > 0 ? "\n" : "")

/** What the command prints. Numbers and fixed words only. */
export const summaryText = (s: ExportSummary) =>
  [
    `Parts of channel jobs in the database: ${s.found}`,
    `Items written: ${s.written}, from ${s.jobs} job${s.jobs === 1 ? "" : "s"}`,
    `Parts skipped: ${s.notDone + s.noDoneTest + s.noReply + s.unreadable}`,
    `  not done: ${s.notDone}`,
    `  no done test: ${s.noDoneTest}`,
    `  no reply text: ${s.noReply}`,
    `  reply or channel not readable: ${s.unreadable}`,
    `Parts older than --since: ${s.beforeSince}`,
    `Parts left out by --limit: ${s.overLimit}`,
  ].join("\n")

// ------------------------------------------------------------------------------- the paths

const repositoryRoot = resolve(import.meta.dirname, "../../..")

/**
 * The folders that count as "this repository": the checkout that holds this script, and the main
 * checkout when this one is a linked worktree (its ".git" file points into the main one).
 */
export const repositoryRoots = (root: string = repositoryRoot): string[] => {
  const roots = [root]
  try {
    const link = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(root, ".git"), "utf8"))?.[1]
    if (link) {
      // <main>/.git/worktrees/<name>
      const gitdir = resolve(root, link.trim())
      if (basename(dirname(gitdir)) === "worktrees") roots.push(dirname(dirname(dirname(gitdir))))
    }
  } catch {
    // ".git" is a folder, or it is not there: there is no other checkout to name.
  }
  return roots
}

/** The real path of the deepest part of a path that exists, then the rest. Links are followed. */
const realPathOf = (path: string): string => {
  const rest: string[] = []
  let head = resolve(path)
  for (;;) {
    try {
      return join(realpathSync.native(head), ...rest)
    } catch {
      const up = dirname(head)
      if (up === head) return resolve(path)
      rest.unshift(basename(head))
      head = up
    }
  }
}

const fold = (path: string) =>
  process.platform === "darwin" || process.platform === "win32" ? path.toLowerCase() : path

const isInside = (path: string, root: string) => {
  const rel = relative(fold(realPathOf(root)), fold(realPathOf(path)))
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/**
 * Checks the path of the output BEFORE anything is read or written. Throws an ItemsError that
 * names the option and never the path.
 */
export const checkOutPath = (
  out: string,
  db: string,
  force: boolean,
  roots: readonly string[] = repositoryRoots(),
) => {
  const file = resolve(out)
  if (roots.some((root) => isInside(file, root)))
    throw new ItemsError(
      "--out is inside this repository. The items hold conversations of the user: choose a place outside it.",
    )
  if (fold(realPathOf(file)) === fold(realPathOf(db)))
    throw new ItemsError("--out is the same file as --db.")
  let info: ReturnType<typeof lstatSync> | undefined
  try {
    info = lstatSync(file)
  } catch {
    info = undefined
  }
  if (info) {
    if (info.isDirectory()) throw new ItemsError("--out must be a file, not a folder.")
    if (!force) throw new ItemsError("The file of --out exists. Use --force to replace it.")
  } else {
    let folder: ReturnType<typeof statSync> | undefined
    try {
      folder = statSync(dirname(file))
    } catch {
      folder = undefined
    }
    if (!folder?.isDirectory()) throw new ItemsError("The folder of --out does not exist.")
  }
}

/**
 * Writes the items to a new file with mode 0600. With `force` an existing file is removed first,
 * so the new file never has the mode of the old one. Without it, an existing file is never
 * touched: the file is made with the flag "wx".
 */
export const writeItems = (out: string, text: string, force: boolean) => {
  const file = resolve(out)
  try {
    if (force) {
      try {
        lstatSync(file)
        unlinkSync(file)
      } catch {
        // There is nothing to remove.
      }
    }
    writeFileSync(file, text, { flag: "wx", mode: 0o600 })
    chmodSync(file, 0o600)
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    throw new ItemsError(
      code === "EEXIST"
        ? "The file of --out exists. Use --force to replace it."
        : "The file of --out cannot be written.",
    )
  }
}

// ----------------------------------------------------------------------------- the command

export interface Cli {
  readonly help: boolean
  readonly db: string
  readonly out: string
  readonly since: number | null
  readonly limit: number | null
  readonly force: boolean
}

export const USAGE = [
  "bun run judge-items -- --db <copy of the database> --out <file.jsonl> [--since <date>] [--limit N] [--force]",
  "",
  "Writes the finished parts of channel jobs that have a done test as items for the replay of the",
  'check of the lead (docs/judge-validation.md). A person adds the field "human" to each item',
  "(pass, fail or skip) before the replay runs. The items hold no verdict and no decision.",
  "",
  "--db     A COPY of the database of the app. Make the copy first, while ROBot is closed. If a",
  "         file with the ending -wal stands next to the database, copy it too, with the same name",
  "         and that ending. The command opens the copy read-only and never changes it. It reads",
  "         no other file of the data folder.",
  "--out    The new file. It must be outside this repository: the items hold the conversations of",
  "         the user. It is made with mode 0600. An existing file is not replaced unless --force.",
  "--since  Only parts made on this date or later (UTC), for example 2026-10-01.",
  "--limit  At most N parts: the newest ones.",
  "",
  "The command prints counts only, never the text of an item.",
].join("\n")

/** A date (UTC midnight), or a date with a time and a zone. */
const SINCE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/

const FLAGS = new Set(["force", "help"])
const VALUES = new Set(["db", "out", "since", "limit"])

/** Reads the arguments. Throws an ItemsError that names the option and no value. */
export const readCli = (args: readonly string[]): Cli => {
  const given = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string
    const name = arg.startsWith("--") ? arg.slice(2) : ""
    if (FLAGS.has(name)) flags.add(name)
    else if (VALUES.has(name)) {
      const value = args[++i]
      if (value === undefined || value.startsWith("--"))
        throw new ItemsError(`--${name} needs a value.`)
      given.set(name, value)
    } else
      throw new ItemsError(
        `Unknown argument: ${arg.startsWith("--") ? (arg.split("=")[0] as string) : "(a value)"}.`,
      )
  }
  const help = flags.has("help")
  const db = given.get("db")
  const out = given.get("out")
  if (!help && !db) throw new ItemsError("Give the copy of the database: --db <file>.")
  if (!help && !out) throw new ItemsError("Give the file for the items: --out <file.jsonl>.")
  let since: number | null = null
  const sinceText = given.get("since")
  if (sinceText !== undefined) {
    since = SINCE.test(sinceText) ? Date.parse(sinceText) : Number.NaN
    if (Number.isNaN(since)) throw new ItemsError("--since must be a date, for example 2026-10-01.")
  }
  let limit: number | null = null
  const limitText = given.get("limit")
  if (limitText !== undefined) {
    limit = /^\d+$/.test(limitText) ? Number(limitText) : 0
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new ItemsError("--limit must be a whole number of 1 or more.")
  }
  return { help, db: db ?? "", out: out ?? "", since, limit, force: flags.has("force") }
}
