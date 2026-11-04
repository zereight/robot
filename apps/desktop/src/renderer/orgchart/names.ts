import {
  type AgentState,
  type ChartAgent,
  type ChartChannel,
  type ChartLine,
  countList,
  type MessageKey,
  type StateCounts,
} from "@robot/shared"

// The words of the org chart (spec 029): the state words, the counts of a channel node and the
// accessible names of the nodes. They take the function `t`, so a test can check them in English
// and in Korean. Names, role lines and task labels are text of the user and are not translated.

export type Translate = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string

export const stateWord = (t: Translate, state: AgentState) =>
  t(`orgchart.state.${state}` as MessageKey)

/** "2 working", "1 waiting for you", and so on. */
export const countWord = (t: Translate, state: AgentState, count: number) =>
  t(`orgchart.counts.${state}` as MessageKey, { count })

/** "2 working · 3 idle": a count for each state that a member has, in the order of the spec. */
export const countsLine = (t: Translate, counts: StateCounts) =>
  countList(counts)
    .map(({ state, count }) => countWord(t, state, count))
    .join(" · ")

export const membersWord = (t: Translate, count: number) =>
  count === 1 ? t("orgchart.members.one") : t("orgchart.members", { count })

/** The name of a channel node. The node "No channel" has none of its own, so it takes its words. */
export const channelTitle = (t: Translate, channel: ChartChannel) =>
  channel.channelId === null ? t("orgchart.noChannel") : channel.name

export const moreWord = (t: Translate, count: number) => t("orgchart.more", { count })

/** The accessible name of a channel node: the name, the number of members and the counts. */
export const channelLabel = (t: Translate, channel: ChartChannel) =>
  [
    channelTitle(t, channel),
    membersWord(t, channel.memberCount),
    countsLine(t, channel.counts).replaceAll(" · ", ", "),
  ]
    .filter((part) => part !== "")
    .join(". ")

/** The accessible name of the tile "+<n> more". */
export const moreLabel = (t: Translate, channel: ChartChannel) =>
  t("orgchart.more.label", { count: channel.more.length, channel: channelTitle(t, channel) })

/**
 * The accessible name of an agent node: the name, the role line, the state, the mark "Lead", the
 * label of the task, the words "Also in <channel>" for each other copy, and the hand-offs.
 */
export const agentLabel = (t: Translate, node: ChartAgent) =>
  [
    node.name,
    node.role,
    stateWord(t, node.state),
    node.isLead ? t("orgchart.lead") : "",
    node.label ?? "",
    ...node.alsoIn.map((channel) => t("orgchart.alsoIn", { channel })),
    node.handedTo > 0
      ? node.handedTo === 1
        ? t("orgchart.handedTo.one")
        : t("orgchart.handedTo", { count: node.handedTo })
      : "",
    node.gotFrom > 0
      ? node.gotFrom === 1
        ? t("orgchart.gotFrom.one")
        : t("orgchart.gotFrom", { count: node.gotFrom })
      : "",
  ]
    .filter((part) => part.trim() !== "")
    .join(". ")

/** The text that a hand-off line shows when the user points at it. */
export const handoffTip = (t: Translate, line: ChartLine) => {
  const params = { from: line.fromName ?? "", to: line.toName ?? "", count: line.count ?? 0 }
  return line.count === 1
    ? t("orgchart.handoff.tip.one", params)
    : t("orgchart.handoff.tip", params)
}
