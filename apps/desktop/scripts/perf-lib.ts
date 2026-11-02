// Pure parts of the performance report and of the size check (docs/performance.md).
import { readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { median } from "@robot/shared"

export type Unit = "ms" | "%" | "MB" | "bytes" | "count"

/** One number of a report. */
export interface Measure {
  readonly id: string
  readonly name: string
  readonly unit: Unit
  readonly value: number | null
}

export interface PerfReport {
  readonly format: 1
  readonly label: string
  readonly createdAt: string
  readonly app: { readonly version: string; readonly path: string }
  readonly system: {
    readonly platform: string
    readonly arch: string
    readonly release: string
    readonly cpu: string
    readonly cpus: number
    readonly memoryGb: number
  }
  readonly notes: readonly string[]
  readonly measures: readonly Measure[]
  /** The raw samples of each measure group, for a closer look. */
  readonly samples: Readonly<Record<string, readonly number[]>>
}

// ------------------------------------------------------------------------------ numbers

/** The value at a percentile (0 to 100), by the nearest rank. */
export const percentile = (values: readonly number[], p: number) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)))
  return sorted[rank - 1] as number
}

export const worst = (values: readonly number[]) =>
  values.length === 0 ? null : Math.max(...values)

const round = (value: number | null, digits = 1) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits

/** The median and the worst sample of a group, as two measures. */
export const medianAndWorst = (
  id: string,
  name: string,
  unit: Unit,
  values: readonly number[],
): Measure[] => [
  { id: `${id}.median`, name: `${name}, median`, unit, value: round(median(values)) },
  { id: `${id}.worst`, name: `${name}, worst`, unit, value: round(worst(values)) },
]

/** Frame times from the time stamps of frames: the gaps between two frames that follow. */
export const frameGaps = (stamps: readonly number[]) =>
  stamps.slice(1).map((at, i) => at - (stamps[i] as number))

/**
 * Parts drawn late: a part is late when it shows more than `lateMs` after the fake provider sent
 * it. A part that never showed is late too.
 */
export const lateParts = (
  sent: readonly { readonly index: number; readonly at: number }[],
  drawn: ReadonlyMap<number, number>,
  lateMs: number,
) =>
  sent.filter((s) => {
    const at = drawn.get(s.index)
    return at === undefined || at - s.at > lateMs
  }).length

// ------------------------------------------------------------------------------ report

const cell = (m: Measure) =>
  m.value === null ? "—" : `${m.value.toLocaleString("en-US")} ${m.unit === "count" ? "" : m.unit}`

/** The Markdown form of a report. */
export const reportMarkdown = (r: PerfReport) =>
  [
    `# Performance report: ${r.label}`,
    "",
    `- Made: ${r.createdAt}`,
    `- App: ${r.app.version} (${r.app.path})`,
    `- System: ${r.system.platform} ${r.system.release}, ${r.system.arch}, ${r.system.cpu} ×${r.system.cpus}, ${r.system.memoryGb} GB`,
    "",
    "| Measure | Value |",
    "| --- | ---: |",
    ...r.measures.map((m) => `| ${m.name} | ${cell(m).trim()} |`),
    "",
    "## Notes",
    "",
    ...r.notes.map((n) => `- ${n}`),
    "",
  ].join("\n")

export interface CompareRow {
  readonly id: string
  readonly name: string
  readonly unit: Unit
  readonly before: number | null
  readonly after: number | null
  /** The change in percent. Null when a value is missing or the old value is 0. */
  readonly change: number | null
}

/** Each measure of two reports, with the two values and the change in percent. */
export const compareReports = (before: PerfReport, after: PerfReport): CompareRow[] => {
  const ids = [...new Set([...before.measures, ...after.measures].map((m) => m.id))]
  return ids.map((id) => {
    const a = before.measures.find((m) => m.id === id)
    const b = after.measures.find((m) => m.id === id)
    const old = a?.value ?? null
    const now = b?.value ?? null
    return {
      id,
      name: (b ?? a)?.name ?? id,
      unit: (b ?? a)?.unit ?? "count",
      before: old,
      after: now,
      change: old === null || now === null || old === 0 ? null : round(((now - old) / old) * 100),
    }
  })
}

const signed = (n: number | null) => (n === null ? "—" : `${n > 0 ? "+" : ""}${n}%`)
const plain = (n: number | null, unit: Unit) =>
  n === null ? "—" : `${n.toLocaleString("en-US")}${unit === "count" ? "" : ` ${unit}`}`

export const compareMarkdown = (before: PerfReport, after: PerfReport) =>
  [
    `| Measure | ${before.label} | ${after.label} | Change |`,
    "| --- | ---: | ---: | ---: |",
    ...compareReports(before, after).map(
      (r) =>
        `| ${r.name} | ${plain(r.before, r.unit)} | ${plain(r.after, r.unit)} | ${signed(r.change)} |`,
    ),
  ].join("\n")

/** True when a value read from a file has the shape of a report. */
export const isReport = (v: unknown): v is PerfReport =>
  typeof v === "object" &&
  v !== null &&
  (v as PerfReport).format === 1 &&
  typeof (v as PerfReport).label === "string" &&
  Array.isArray((v as PerfReport).measures)

/** A label is part of a file name: letters, digits, dot, dash and underscore. */
export const safeLabel = (label: string) => {
  const clean = label.trim().replace(/[^\w.-]+/g, "-")
  if (!clean || clean.startsWith(".")) throw new Error(`Not a usable label: "${label}"`)
  return clean
}

// ------------------------------------------------------------------------------ sizes

/** The groups of the built files. The window is the renderer; the main process has its own. */
export const sizeGroup = (path: string) => {
  const [top, ...rest] = path.split(sep).join("/").split("/")
  if (rest.length === 0) return null
  if (top === "main") return "main"
  if (top === "preload") return "preload"
  if (top !== "renderer") return null
  const file = rest.at(-1) ?? ""
  if (file.endsWith(".js")) return "window.js"
  if (file.endsWith(".css")) return "window.css"
  return "window.other"
}

/** The size in bytes of each group of built files under `outDir`. Source maps do not count. */
export const measureSizes = (outDir: string) => {
  const sizes: Record<string, number> = {}
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const stat = statSync(path)
      if (stat.isDirectory()) walk(path)
      else if (!name.endsWith(".map")) {
        const group = sizeGroup(relative(outDir, path))
        if (group) sizes[group] = (sizes[group] ?? 0) + stat.size
      }
    }
  }
  walk(outDir)
  return Object.fromEntries(Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b)))
}

export interface SizeRow {
  readonly group: string
  readonly baseline: number | null
  readonly current: number | null
  /** The change in percent, when both are known. */
  readonly change: number | null
  readonly ok: boolean
}

/** The largest growth over the baseline that passes: 10 percent. */
export const MAX_GROWTH = 0.1

/**
 * Compares sizes with the baseline. A group fails when it grows more than 10 percent, or when it
 * has no baseline. A group that went away passes.
 */
export const checkSizes = (
  current: Readonly<Record<string, number>>,
  baseline: Readonly<Record<string, number>>,
  maxGrowth = MAX_GROWTH,
) => {
  const groups = [...new Set([...Object.keys(baseline), ...Object.keys(current)])].sort()
  const rows: SizeRow[] = groups.map((group) => {
    const was = baseline[group] ?? null
    const now = current[group] ?? null
    const change = was === null || now === null || was === 0 ? null : (now - was) / was
    const ok = now === null || (was !== null && now <= was * (1 + maxGrowth))
    return { group, baseline: was, current: now, change: round(change && change * 100), ok }
  })
  return { ok: rows.every((r) => r.ok), rows }
}

export const sizesTable = (rows: readonly SizeRow[]) =>
  [
    "| Files | Baseline | Now | Change | |",
    "| --- | ---: | ---: | ---: | --- |",
    ...rows.map(
      (r) =>
        `| ${r.group} | ${plain(r.baseline, "bytes")} | ${plain(r.current, "bytes")} | ${signed(r.change)} | ${r.ok ? "ok" : "too large"} |`,
    ),
  ].join("\n")
