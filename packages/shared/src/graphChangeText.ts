import type { MessageKey, MessageParams } from "./i18n/index.ts"
import {
  type GraphChange,
  type GraphConnectionChange,
  type GraphNodeChange,
  type GraphNodeValues,
  graphChangeSize,
} from "./proposals.ts"

type Translate = (key: MessageKey, params?: MessageParams) => string

export const GRAPH_FIELD_KEYS = {
  name: "improve.graph.field.name",
  prompt: "improve.graph.field.prompt",
  account: "improve.graph.field.account",
  model: "improve.graph.field.model",
  effort: "improve.graph.field.effort",
  continueOnFailure: "improve.graph.field.continueOnFailure",
  question: "improve.graph.field.question",
  threshold: "improve.graph.field.threshold",
  options: "improve.graph.field.options",
  number: "improve.graph.field.number",
} as const satisfies Record<string, MessageKey>

/** One value of a node that the card shows. A changed field has the old value and the new value. */
export interface NodeDetail {
  readonly field: keyof typeof GRAPH_FIELD_KEYS
  /** The value before the change, for a changed field; null for an added or a removed node. */
  readonly old: string | null
  readonly now: string
  /** True for a text that the card shows in its own block: a prompt, a question, options. */
  readonly long: boolean
}

type Shown = Exclude<keyof typeof GRAPH_FIELD_KEYS, "number">

const SHOWN: readonly Shown[] = [
  "name",
  "prompt",
  "question",
  "options",
  "account",
  "model",
  "effort",
  "continueOnFailure",
  "threshold",
]

const LONG: ReadonlySet<string> = new Set(["prompt", "question", "options"])

const fieldValue = (t: Translate, v: GraphNodeValues, field: Shown): string => {
  switch (field) {
    case "name":
      return v.name
    case "prompt":
      return v.prompt
    case "question":
      return v.question
    case "options":
      return v.options.join("\n")
    case "account":
      return v.account ?? ""
    case "model":
      return v.model ?? ""
    case "effort":
      return v.effort ?? ""
    case "continueOnFailure":
      return t(v.continueOnFailure ? "improve.graph.yes" : "improve.graph.no")
    case "threshold":
      return String(v.threshold)
  }
}

/**
 * The values that the card of a graph change shows for a node (spec 002, "Card"): for an added or a
 * removed node, every value that is set; for a changed node, each changed field with the old value
 * and the new value. The card shows these as text, so the user reads the new text before "Accept".
 */
export const nodeDetails = (t: Translate, n: GraphNodeChange): NodeDetail[] => {
  const none = t("improve.graph.value.none")
  const out: NodeDetail[] = []
  if (n.was) {
    for (const field of SHOWN) {
      if (!n.fields.includes(field)) continue
      out.push({
        field,
        old: fieldValue(t, n.was, field) || none,
        now: fieldValue(t, n.now, field) || none,
        long: LONG.has(field),
      })
    }
    return out
  }
  for (const field of SHOWN) {
    if (field === "continueOnFailure" || field === "threshold") {
      // The flag "go on after a failure" works for both kinds of node; the threshold only for a decision.
      if (field === "continueOnFailure" || n.kind === "decision")
        out.push({ field, old: null, now: fieldValue(t, n.now, field), long: false })
      continue
    }
    const value = fieldValue(t, n.now, field)
    if (value !== "") out.push({ field, old: null, now: value, long: LONG.has(field) })
  }
  return out
}

/** One line for a node of a graph change: its number, its name and the fields that changed. */
export const graphNodeLine = (t: Translate, n: GraphNodeChange): string =>
  n.fields.length > 0
    ? t("improve.graph.node.fields", {
        number: n.number,
        name: n.name,
        fields: n.fields
          .map((f) => t(GRAPH_FIELD_KEYS[f as keyof typeof GRAPH_FIELD_KEYS] as MessageKey))
          .join(", "),
      })
    : t("improve.graph.node", { number: n.number, name: n.name })

/** One line for a connection of a graph change. */
export const graphConnectionLine = (t: Translate, c: GraphConnectionChange): string => {
  const from = t("improve.graph.node", { number: c.from.number, name: c.from.name })
  const to = t("improve.graph.node", { number: c.to.number, name: c.to.name })
  return c.option === null
    ? t("improve.graph.connection", { from, to })
    : t("improve.graph.connection.option", { from, to, option: c.option })
}

/**
 * A graph change as plain text, with every value in full: the same nodes, fields and connections
 * as the card of a graph proposal (spec 002, "Card"). The approval card of the chat shows this
 * text when a turn that holds outside content asks before it changes the graph (spec 007). The
 * caller refuses a change above `GRAPH_PROPOSAL_TEXT_MAX` before it builds the text: this function
 * never cuts a value.
 */
export const graphChangeCardText = (t: Translate, change: GraphChange, max: number): string => {
  const out: string[] = [t("improve.graph.size", { n: graphChangeSize(change), max })]
  const nodes = [
    ["improve.graph.added", change.addedNodes],
    ["improve.graph.changed", change.changedNodes],
    ["improve.graph.removed", change.removedNodes],
  ] as const
  for (const [title, list] of nodes) {
    if (list.length === 0) continue
    out.push("", t(title))
    for (const n of list) {
      out.push(`- ${graphNodeLine(t, n)}`)
      for (const d of nodeDetails(t, n)) {
        const label = t(GRAPH_FIELD_KEYS[d.field])
        if (d.old === null) out.push(`    ${label}: ${d.long ? `\n${indent(d.now)}` : d.now}`)
        else if (d.long)
          out.push(
            `    ${label}:`,
            `      ${t("improve.text.old")}:`,
            indent(d.old, 8),
            `      ${t("improve.text.new")}:`,
            indent(d.now, 8),
          )
        else
          out.push(`    ${label}: ${t("improve.graph.value.change", { old: d.old, now: d.now })}`)
      }
    }
  }
  const links = [
    ["improve.graph.connectionsAdded", change.addedConnections],
    ["improve.graph.connectionsRemoved", change.removedConnections],
  ] as const
  for (const [title, list] of links) {
    if (list.length === 0) continue
    out.push("", t(title))
    for (const c of list) out.push(`- ${graphConnectionLine(t, c)}`)
  }
  return out.join("\n")
}

const indent = (text: string, by = 8) =>
  text
    .split("\n")
    .map((line) => `${" ".repeat(by)}${line}`)
    .join("\n")

/** The tools of the chat that read and change the workflow and its runs (spec 007, "Tool cards"). */
export const ASSISTANT_STEP_NAMES: ReadonlySet<string> = new Set([
  "list_workflows",
  "read_workflow",
  "create_workflow",
  "add_node",
  "edit_node",
  "remove_node",
  "add_connection",
  "remove_connection",
  "add_option",
  "rename_option",
  "remove_option",
  "start_run",
  "stop_run",
  "read_run",
  "read_run_result",
])

/**
 * The line for a step of such a tool, in the words of the interface. Plain text, never markup.
 * `deed` says what happened ("Removed node 2"); `wanted` says what the step asks for ("Remove node
 * 2"). A card uses `deed` only for a step that happened, so it never claims a change that the
 * graph does not have. The action log uses `wanted`. Null for a tool that is not one of these.
 */
export const assistantStepText = (
  t: Translate,
  name: string,
  input: string,
  form: "deed" | "wanted",
): string | null => {
  if (!ASSISTANT_STEP_NAMES.has(name)) return null
  let args: Record<string, unknown> = {}
  try {
    const v: unknown = JSON.parse(input || "{}")
    if (typeof v === "object" && v !== null && !Array.isArray(v))
      args = v as Record<string, unknown>
  } catch {
    // Arguments that are not JSON show with the number "?".
  }
  const n = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : "?")
  const key = form === "deed" ? `chat.tool.${name}` : `chat.tool.wanted.${name}`
  const named = typeof args.name === "string" && args.name.trim() !== "" ? args.name.trim() : "?"
  return t(key as MessageKey, {
    node: n(args.node),
    from: n(args.from),
    to: n(args.to),
    name: named,
  })
}
