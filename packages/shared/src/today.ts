import type { PlaceTarget } from "./notifications.ts"
import type { TaskSource } from "./task.ts"

// The Today page (spec 021). This file holds the rules of the four groups as plain functions of
// facts, so the main process reads the facts and the tests can run the rules with a fake clock.

export const TODAY_GROUPS = ["needs", "wrong", "done", "next"] as const
export type TodayGroupId = (typeof TODAY_GROUPS)[number]

/** A group shows this many rows, and "Show more" adds this many. */
export const TODAY_PAGE_SIZE = 20
/** A row line has at most this many characters. A longer line ends with "…". */
export const TODAY_LINE_MAX = 90
/** The badge reads "99+" above this count. */
export const TODAY_BADGE_MAX = 99
/** "Next 24 hours" looks this far ahead. */
export const TODAY_AHEAD_MS = 24 * 60 * 60 * 1000
/** A routine that fails this many runs in a row pauses (spec 009). */
export const ROUTINE_PAUSE_FAILS = 3

export type TodayKind =
  | "approval"
  | "question"
  | "part_failed"
  | "part_review"
  | "task_failed"
  | "task_blocked"
  | "routine_failed"
  | "routine_paused"
  | "account_signin"
  | "account_limit"
  | "routine_done"
  | "workflow_done"
  | "routine_next"
  | "workflow_next"

/** What a click on a row opens. */
export type TodayOpen =
  | { readonly kind: "place"; readonly target: PlaceTarget }
  | { readonly kind: "task"; readonly id: string }
  | { readonly kind: "routine"; readonly id: string }
  | { readonly kind: "workflow"; readonly id: string }
  | { readonly kind: "account"; readonly id: string }

/** Where the work of a row happened. The name is the channel, routine or workflow. */
export interface TodayWhere {
  readonly kind: "direct" | "channel" | "routine" | "workflow"
  readonly name: string
}

export interface TodayReason {
  readonly code: string
  readonly detail: string
}

export interface TodayRow {
  /** Stable while the item stays, so the list keeps its rows when it changes. */
  readonly id: string
  readonly kind: TodayKind
  /** The agent whose face shows on the row, or null. */
  readonly agentId: string | null
  /**
   * The text of the card, the label of the task, or the name of the routine, workflow or account.
   * It is text of the user or of an agent, so it is not translated.
   */
  readonly text: string
  readonly where: TodayWhere | null
  /** The name of the other computer that the request came from (spec 019), or null. */
  readonly computer: string | null
  readonly reason: TodayReason | null
  /** Runs done (done rows) or failed runs (routine rows). */
  readonly count: number
  /** The time of the row: asked, failed, last run ended, or due. */
  readonly at: number
  /** When a plan limit resets, for the row of an account. */
  readonly resetsAt: number | null
  readonly open: TodayOpen
}

export interface TodayGroup {
  readonly id: TodayGroupId
  readonly rows: readonly TodayRow[]
  /** True when the app could not read the source. The page shows a line in place of rows. */
  readonly unreadable: boolean
}

export interface TodaySnapshot {
  /** The groups, in the order of the page. */
  readonly groups: readonly TodayGroup[]
  /** The count of all items in "Needs you", also those that do not show. */
  readonly badge: number
  /** Midnight at the start of the day, in the time zone of this computer. */
  readonly dayStart: number
}

// ---------------------------------------------------------------------------------------------
// The day
// ---------------------------------------------------------------------------------------------

const offsetFormats = new Map<string, Intl.DateTimeFormat>()

/** The offset of a time zone from UTC at a time, in ms. */
const zoneOffset = (at: number, zone: string): number => {
  let format = offsetFormats.get(zone)
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
    offsetFormats.set(zone, format)
  }
  const part = (type: string, parts: Intl.DateTimeFormatPart[]) =>
    Number(parts.find((p) => p.type === type)?.value)
  const parts = format.formatToParts(new Date(at))
  const local = Date.UTC(
    part("year", parts),
    part("month", parts) - 1,
    part("day", parts),
    part("hour", parts),
    part("minute", parts),
    part("second", parts),
  )
  return local - Math.floor(at / 1000) * 1000
}

/** The moment when a calendar day starts in a zone. `day` may run past the month. */
const midnightOf = (year: number, month: number, day: number, zone: string) => {
  const naive = Date.UTC(year, month, day)
  const first = naive - zoneOffset(naive, zone)
  // The offset at the start can differ from the one at the naive time (a clock change).
  return naive - zoneOffset(first, zone)
}

/** The zone of this computer. */
export const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

const knownZone = (zone: string) => {
  try {
    zoneOffset(0, zone)
    return zone
  } catch {
    return "UTC"
  }
}

/**
 * The day that holds `now`: from midnight to the next midnight in the zone. A day with a clock
 * change is shorter or longer than 24 hours.
 */
export const dayBounds = (now: number, zone: string = localZone()) => {
  const z = knownZone(zone)
  const local = new Date(now + zoneOffset(now, z))
  const [year, month, day] = [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()]
  return {
    start: midnightOf(year, month, day, z),
    end: midnightOf(year, month, day + 1, z),
  }
}

/** Changes when the day or the time zone changes. */
export const dayKey = (now: number, zone: string = localZone()) =>
  `${zone}|${dayBounds(now, zone).start}`

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/** One line of at most 90 characters. A longer line ends with "…". */
export const todayLine = (text: string, max = TODAY_LINE_MAX) => {
  const line = text.replace(/\s+/g, " ").trim()
  const chars = [...line]
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : line
}

/** The text of the badge: nothing at 0, the count up to 99, and "99+" above. */
export const badgeText = (count: number): string | null =>
  count <= 0 ? null : count > TODAY_BADGE_MAX ? `${TODAY_BADGE_MAX}+` : String(count)

// ---------------------------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------------------------

/** An approval or a question that waits. */
export interface CardFacts {
  readonly agentId: string
  readonly callId: string
  readonly kind: "approval" | "question"
  readonly text: string
  /** The channel name, or null for a direct chat. */
  readonly channel: string | null
  readonly target: PlaceTarget
  readonly askedAt: number
  /** The name of the other computer when the task runs there (spec 019). */
  readonly computer: string | null
}

/** A failed part of a channel job, or a part that waits for review (spec 004). */
export interface PartFacts {
  readonly taskId: string
  readonly agentId: string
  readonly label: string
  readonly state: "failed" | "blocked" | "review"
  readonly channel: string
  readonly target: PlaceTarget
  readonly at: number
  readonly reason: TodayReason | null
}

export interface TaskFacts {
  readonly id: string
  readonly agentId: string
  readonly label: string
  readonly state: "failed" | "blocked"
  readonly source: TaskSource
  readonly where: TodayWhere | null
  readonly at: number
  readonly reason: TodayReason | null
}

/** A run of a routine or a workflow. */
export interface RunFacts {
  /** `done`, `failed`, `blocked` or `cancelled`. Runs that still go are not given. */
  readonly state: string
  readonly createdAt: number
  readonly finishedAt: number | null
  readonly reason: TodayReason | null
}

export interface RoutineFacts {
  readonly id: string
  readonly name: string
  readonly agentId: string
  readonly enabled: boolean
  /**
   * The time of the last resume or edit (spec 009). A resume or an edit sets the count of failed
   * runs to 0, so runs from before it do not count.
   */
  readonly resetAt: number
  readonly runs: readonly RunFacts[]
  /** The next run time, or null when it has none. */
  readonly nextRun: number | null
}

export interface WorkflowFacts {
  readonly id: string
  readonly name: string
  readonly enabled: boolean
  readonly runs: readonly RunFacts[]
  /** The next scheduled run time, or null when the trigger is not a schedule. */
  readonly nextRun: number | null
}

export interface AccountFacts {
  readonly id: string
  readonly name: string
  /** False when the user disconnected the account. */
  readonly connected: boolean
  /** The newest turn that ended as done or failed with a model of this account. */
  readonly last: {
    readonly failed: boolean
    readonly code: string
    readonly resetsAt: number | null
    readonly at: number
    readonly agentId: string
  } | null
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

const isFailure = (state: string) => state === "failed" || state === "blocked"
const within = (at: number | null, start: number, end: number) =>
  at !== null && at >= start && at < end

/**
 * The runs that count for a routine. A routine that is on counts the runs that started after its
 * last resume or edit, because both set the count of failed runs to 0 (spec 009). A routine that
 * is paused counts all runs: a pause is not an edit, so it keeps the count.
 */
const countedRuns = (routine: Pick<RoutineFacts, "enabled" | "resetAt" | "runs">) =>
  routine.enabled ? routine.runs.filter((r) => r.createdAt >= routine.resetAt) : routine.runs

/**
 * The failed runs in a row, going back from the newest run. A run that ends as done sets the count
 * to 0. A blocked run counts as a failed one. A cancelled run changes nothing (spec 009).
 */
export const failedInARow = (runs: readonly RunFacts[], resetAt = 0) => {
  const mine = runs.filter((r) => r.createdAt >= resetAt).sort((a, b) => b.createdAt - a.createdAt)
  let count = 0
  for (const run of mine) {
    if (run.state === "done") break
    if (isFailure(run.state)) count++
  }
  return count
}

/** The row of a routine for "Went wrong", or null. */
export const routineProblem = (
  routine: RoutineFacts,
  day: { start: number; end: number },
): TodayRow | null => {
  const counted = countedRuns(routine)
  const mine = counted
    .filter((r) => isFailure(r.state))
    .sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt))
  const last = mine[0]
  if (!last) return null
  const streak = failedInARow(counted)
  const paused = !routine.enabled && streak >= ROUTINE_PAUSE_FAILS
  const today = mine.filter((r) => within(r.finishedAt, day.start, day.end))
  if (!paused && today.length === 0) return null
  return {
    id: `routine:${routine.id}`,
    kind: paused ? "routine_paused" : "routine_failed",
    agentId: routine.agentId,
    text: routine.name,
    where: null,
    computer: null,
    reason: last.reason,
    count: paused ? streak : today.length,
    at: last.finishedAt ?? last.createdAt,
    resetsAt: null,
    open: { kind: "routine", id: routine.id },
  }
}

/** The codes of a turn that failed because the sign-in or the key is not valid (spec 006). */
export const SIGN_IN_CODES = ["provider_auth", "runtime_signed_out", "runtime_not_signed_in"]
export const LIMIT_CODE = "provider_limit"

/** The row of a model account that has a problem, or null (spec 021, "Model account problem"). */
export const accountProblem = (account: AccountFacts, now: number): TodayRow | null => {
  const last = account.last
  if (!account.connected || !last?.failed) return null
  const signIn = SIGN_IN_CODES.includes(last.code)
  if (!signIn && last.code !== LIMIT_CODE) return null
  // A plan limit also ends when its reset time has passed.
  if (!signIn && last.resetsAt !== null && last.resetsAt <= now) return null
  return {
    id: `account:${account.id}`,
    kind: signIn ? "account_signin" : "account_limit",
    agentId: last.agentId,
    text: account.name,
    where: null,
    computer: null,
    reason: { code: last.code, detail: "" },
    count: 0,
    at: last.at,
    resetsAt: signIn ? null : last.resetsAt,
    open: { kind: "account", id: account.id },
  }
}

const byTime = (rows: TodayRow[], newestFirst: boolean) =>
  rows.sort((a, b) => (newestFirst ? b.at - a.at : a.at - b.at) || a.id.localeCompare(b.id))

/** "Needs you": the oldest first. */
export const needsRows = (cards: readonly CardFacts[], parts: readonly PartFacts[]) =>
  byTime(
    [
      ...cards.map(
        (c): TodayRow => ({
          id: `${c.kind}:${c.agentId}:${c.callId}`,
          kind: c.kind,
          agentId: c.agentId,
          text: c.text,
          where:
            c.channel === null
              ? { kind: "direct", name: "" }
              : { kind: "channel", name: c.channel },
          computer: c.computer,
          reason: null,
          count: 0,
          at: c.askedAt,
          resetsAt: null,
          open: { kind: "place", target: c.target },
        }),
      ),
      ...parts.map(
        (p): TodayRow => ({
          id: `part:${p.taskId}`,
          kind: p.state === "review" ? "part_review" : "part_failed",
          agentId: p.agentId,
          text: p.label,
          where: { kind: "channel", name: p.channel },
          computer: null,
          reason: p.reason,
          count: 0,
          at: p.at,
          resetsAt: null,
          open: { kind: "place", target: p.target },
        }),
      ),
    ],
    false,
  )

/** "Went wrong": the newest first. */
export const wrongRows = (
  tasks: readonly TaskFacts[],
  routines: readonly RoutineFacts[],
  accounts: readonly AccountFacts[],
  day: { start: number; end: number },
  now: number,
) =>
  byTime(
    [
      ...tasks
        .filter((t) => within(t.at, day.start, day.end))
        .map(
          (t): TodayRow => ({
            id: `task:${t.id}`,
            kind: t.state === "blocked" ? "task_blocked" : "task_failed",
            agentId: t.agentId,
            text: t.label,
            where: t.where,
            computer: null,
            reason: t.reason,
            count: 0,
            at: t.at,
            resetsAt: null,
            open: { kind: "task", id: t.id },
          }),
        ),
      ...routines.flatMap((r) => routineProblem(r, day) ?? []),
      ...accounts.flatMap((a) => accountProblem(a, now) ?? []),
    ],
    true,
  )

/** What ran today: the number of runs that ended as done, and when the last one ended. */
export interface DoneFacts {
  readonly kind: "routine" | "workflow"
  readonly id: string
  readonly name: string
  readonly agentId: string | null
  readonly count: number
  readonly last: number
}

/** "Done today": one row for each routine and workflow with a run that ended as done today. */
export const doneRows = (done: readonly DoneFacts[]) =>
  byTime(
    done
      .filter((d) => d.count > 0)
      .map(
        (d): TodayRow => ({
          id: `done:${d.kind}:${d.id}`,
          kind: d.kind === "routine" ? "routine_done" : "workflow_done",
          agentId: d.agentId,
          text: d.name,
          where: null,
          computer: null,
          reason: null,
          count: d.count,
          at: d.last,
          resetsAt: null,
          open: { kind: d.kind, id: d.id },
        }),
      ),
    true,
  )

/**
 * "Next 24 hours": a routine or a workflow that is on and has a run due within 24 hours, soonest
 * first. A routine or a workflow that is paused or off does not show.
 */
export const nextRows = (
  routines: readonly Pick<RoutineFacts, "id" | "name" | "agentId" | "enabled" | "nextRun">[],
  workflows: readonly Pick<WorkflowFacts, "id" | "name" | "enabled" | "nextRun">[],
  now: number,
) => {
  const due = (enabled: boolean, at: number | null): at is number =>
    enabled && at !== null && at > now && at <= now + TODAY_AHEAD_MS
  return byTime(
    [
      ...routines.flatMap((r): TodayRow[] =>
        due(r.enabled, r.nextRun)
          ? [
              {
                id: `next:routine:${r.id}`,
                kind: "routine_next",
                agentId: r.agentId,
                text: r.name,
                where: null,
                computer: null,
                reason: null,
                count: 0,
                at: r.nextRun as number,
                resetsAt: null,
                open: { kind: "routine", id: r.id },
              },
            ]
          : [],
      ),
      ...workflows.flatMap((w): TodayRow[] =>
        due(w.enabled, w.nextRun)
          ? [
              {
                id: `next:workflow:${w.id}`,
                kind: "workflow_next",
                agentId: null,
                text: w.name,
                where: null,
                computer: null,
                reason: null,
                count: 0,
                at: w.nextRun as number,
                resetsAt: null,
                open: { kind: "workflow", id: w.id },
              },
            ]
          : [],
      ),
    ],
    false,
  )
}

/**
 * Puts the groups together in the order of the page. A group that is `null` could not be read.
 * The badge counts every item of "Needs you".
 */
export const todaySnapshot = (
  dayStart: number,
  rows: Readonly<Record<TodayGroupId, readonly TodayRow[] | null>>,
): TodaySnapshot => ({
  dayStart,
  groups: TODAY_GROUPS.map((id) => ({
    id,
    rows: rows[id] ?? [],
    unreadable: rows[id] === null,
  })),
  badge: rows.needs?.length ?? 0,
})

/**
 * The groups that show on the page, with their rows cut to the number the user asked for. A group
 * with no rows is hidden, except "Needs you" (it shows its empty line) and a group that could not
 * be read (it shows its own line).
 */
export const visibleGroups = (
  snapshot: TodaySnapshot,
  shown: Readonly<Partial<Record<TodayGroupId, number>>>,
) =>
  snapshot.groups
    .filter((g) => g.id === "needs" || g.unreadable || g.rows.length > 0)
    .map((g) => {
      const limit = shown[g.id] ?? TODAY_PAGE_SIZE
      return {
        group: g,
        rows: g.rows.slice(0, limit),
        more: Math.max(0, g.rows.length - limit),
      }
    })
