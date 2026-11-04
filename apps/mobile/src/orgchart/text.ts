import type { AgentState } from "@robot/shared"
import type { MessageKey, MessageParams } from "../i18n/index.ts"
import type { OrgAgentRow, OrgBlock, OrgCount, OrgHandoffRow } from "./list.ts"

// The words of the screen "Org chart" (spec 029, "Phone"). They come from the catalogue of the
// phone, in English and Korean. Names, role lines and task labels are text of the user and are
// not translated.

export type Translate = (key: MessageKey, params?: MessageParams) => string

const STATE: Record<AgentState, MessageKey> = {
  working: "org.state.working",
  waiting: "org.state.waiting",
  idle: "org.state.idle",
  offline: "org.state.offline",
}
const COUNT: Record<AgentState, MessageKey> = {
  working: "org.counts.working",
  waiting: "org.counts.waiting",
  idle: "org.counts.idle",
  offline: "org.counts.offline",
}

/** The state of an agent as a word. */
export const agentStateText = (t: Translate, state: AgentState) => t(STATE[state])

/** "1 member", "5 members". */
export const membersText = (t: Translate, count: number) =>
  count === 1 ? t("org.members.one") : t("org.members", { count })

/** The counts by state: "2 working · 3 idle". Empty when no member counts. */
export const countsText = (t: Translate, counts: readonly OrgCount[]) =>
  counts.map((c) => t(COUNT[c.state], { count: c.count })).join(" · ")

/** The name that a block shows. The block "No channel" takes its name from the catalogue. */
export const blockName = (t: Translate, block: Pick<OrgBlock, "channelId" | "name">) =>
  block.channelId === null ? t("org.noChannel") : block.name

/** The line under the name of a block: the number of members and the counts by state. */
export const blockLine = (t: Translate, block: OrgBlock) =>
  [membersText(t, block.memberCount), countsText(t, block.counts)].filter(Boolean).join(" · ")

/** The accessible name of a block header. */
export const blockLabel = (t: Translate, block: OrgBlock) =>
  [blockName(t, block), blockLine(t, block)].join(", ")

/** The accessible name of an agent row: the name, the role line, the state, the mark, the task. */
export const agentLabel = (t: Translate, row: OrgAgentRow, mark?: "main") =>
  [
    row.name,
    row.role,
    agentStateText(t, row.state),
    mark === "main" ? t("org.main") : null,
    row.isLead ? t("org.lead") : null,
    row.label,
  ]
    .filter(Boolean)
    .join(", ")

/** The accessible name of the row "+<n> more". */
export const moreLabel = (t: Translate, block: OrgBlock) =>
  t("org.more.label", { count: block.more.length, channel: blockName(t, block) })

/** The accessible name of a hand-off row. */
export const handoffLabel = (t: Translate, row: OrgHandoffRow) =>
  t(row.count === 1 ? "org.handoff.label.one" : "org.handoff.label", {
    from: row.from,
    to: row.to,
    count: row.count,
  })
