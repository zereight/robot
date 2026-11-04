import { TOOL_TEXT_MAX } from "./toolConnections.ts"

// ---------------------------------------------------------------------------------------------
// Review of connection tools (spec 018, "Tool review"). A connection can change what a tool says
// after the user added it, and the model reads that text. So the app keeps the reviewed tools,
// compares what the connection offers with them at each start, and holds a tool that is new or
// that differs until the user accepts it. This file holds the rules that need no program, no
// network and no database: how a tool is read for the review, how two tools compare, and which
// tools are held. The window and the main process share it.
// ---------------------------------------------------------------------------------------------

/** A parameter of a tool: its name (a path for a parameter inside another) and its description. */
export interface ReviewedParam {
  readonly name: string
  readonly description: string
}

/** The parts of a tool that the user reviews: the name, the description, the parameters, the mark. */
export interface ReviewedTool {
  readonly name: string
  readonly description: string
  readonly params: readonly ReviewedParam[]
  /** The read-only mark that the connection gave. */
  readonly readOnly: boolean
}

/**
 * The model gets the shape of the parameters of a tool only when it is no longer than this many
 * characters (as JSON). A longer one reaches the model as an empty shape, so it holds nothing
 * that the model reads and the review keeps no parameter of it.
 */
export const TOOL_SCHEMA_MAX = 20_000
/** The most parameters that a tool keeps for the review. A shape of 20000 characters holds fewer. */
const PARAMS_MAX = 1_000
/** How deep the parameters inside parameters go. */
const PARAMS_DEPTH_MAX = 8

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/** A text as the review compares it: the spaces at both ends are gone, then 20000 characters at most. */
export const reviewText = (text: unknown): string => {
  if (typeof text !== "string") return ""
  const trimmed = text.trim()
  if (trimmed.length <= TOOL_TEXT_MAX) return trimmed
  return [...trimmed].slice(0, TOOL_TEXT_MAX).join("")
}

/** True when the shape of the parameters reaches the model as it is (see `TOOL_SCHEMA_MAX`). */
export const schemaReachesModel = (schema: unknown): boolean => {
  try {
    return JSON.stringify(schema).length <= TOOL_SCHEMA_MAX
  } catch {
    return false
  }
}

/**
 * The parameters of a tool, with a description for each: the properties of the shape, and the
 * properties inside them. A parameter inside another has a name with a path, like `filter.tag`.
 * A shape that does not reach the model gives none.
 */
export const reviewedParams = (schema: unknown): ReviewedParam[] => {
  const out: ReviewedParam[] = []
  if (!schemaReachesModel(schema)) return out
  const walk = (node: unknown, prefix: string, depth: number) => {
    if (!isRecord(node) || depth > PARAMS_DEPTH_MAX) return
    if (isRecord(node.properties))
      for (const [name, sub] of Object.entries(node.properties)) {
        if (out.length >= PARAMS_MAX) return
        const path = prefix ? `${prefix}.${name}` : name
        out.push({ name: path, description: isRecord(sub) ? reviewText(sub.description) : "" })
        walk(sub, path, depth + 1)
      }
    if (isRecord(node.items)) walk(node.items, `${prefix}[]`, depth + 1)
    for (const key of ["anyOf", "oneOf", "allOf"] as const) {
      const list = node[key]
      if (Array.isArray(list)) for (const sub of list) walk(sub, prefix, depth + 1)
    }
  }
  walk(schema, "", 0)
  return out
}

/** The tool as the review reads it. `tool` is what the connection gave. */
export const reviewedToolOf = (tool: {
  readonly name: string
  readonly description: string
  readonly readOnly: boolean
  readonly schema: unknown
}): ReviewedTool => ({
  name: tool.name,
  description: reviewText(tool.description),
  params: reviewedParams(tool.schema),
  readOnly: tool.readOnly === true,
})

/** A stored list of tools, read again. A line that is not a tool is left out. */
export const parseReviewedTools = (text: string | null | undefined): ReviewedTool[] => {
  let raw: unknown
  try {
    raw = JSON.parse(text ?? "[]")
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []
  const out: ReviewedTool[] = []
  for (const item of raw) {
    if (!isRecord(item) || typeof item.name !== "string" || item.name === "") continue
    const params: ReviewedParam[] = []
    if (Array.isArray(item.params))
      for (const p of item.params)
        if (isRecord(p) && typeof p.name === "string")
          params.push({ name: p.name, description: reviewText(p.description) })
    out.push({
      name: item.name,
      description: reviewText(item.description),
      params,
      readOnly: item.readOnly === true,
    })
  }
  return out
}

const paramLines = (params: readonly ReviewedParam[]): string[] =>
  params.map((p) => `${p.name}\u0000${p.description}`).sort()

/** True when two tools say the same: description, parameters (in any order) and the mark. */
export const sameTool = (a: ReviewedTool, b: ReviewedTool): boolean => {
  if (a.name !== b.name || a.description !== b.description || a.readOnly !== b.readOnly)
    return false
  const left = paramLines(a.params)
  const right = paramLines(b.params)
  return left.length === right.length && left.every((line, i) => line === right[i])
}

/** Which parts of a tool differ from the reviewed tool. */
export interface ToolChange {
  readonly description: boolean
  readonly params: boolean
  readonly readOnly: boolean
}

export const changeOf = (was: ReviewedTool, now: ReviewedTool): ToolChange => {
  const left = paramLines(was.params)
  const right = paramLines(now.params)
  return {
    description: was.description !== now.description,
    params: left.length !== right.length || left.some((line, i) => line !== right[i]),
    readOnly: was.readOnly !== now.readOnly,
  }
}

/** "New": the tool is not among the reviewed tools. "Changed": it is, and it differs. */
export type HeldTag = "new" | "changed"

export interface HeldTool {
  readonly name: string
  readonly tag: HeldTag
  /** The reviewed tool. Null for a new tool. */
  readonly was: ReviewedTool | null
  /** The tool as the connection offers it now. */
  readonly now: ReviewedTool
}

/**
 * The tools that wait for the user: each offered tool that is new, or that differs from its
 * reviewed tool in the description, a parameter or the mark. They come in the order they are offered.
 */
export const heldTools = (
  reviewed: readonly ReviewedTool[],
  offered: readonly ReviewedTool[],
): HeldTool[] => {
  const byName = new Map(reviewed.map((r) => [r.name, r]))
  const out: HeldTool[] = []
  for (const now of offered) {
    const was = byName.get(now.name)
    if (!was) out.push({ name: now.name, tag: "new", was: null, now })
    else if (!sameTool(was, now)) out.push({ name: now.name, tag: "changed", was, now })
  }
  return out
}

/** A held tool as the dialog "Review" shows it. `key` names the text that the user saw. */
export interface HeldToolView extends HeldTool {
  readonly key: string
}
