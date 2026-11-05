import type { MessageKey, OrgBlock } from "@robot/shared"

// The words of the list view of the org chart (spec 029, "Search and the list"). The phone has its
// own catalogue and its own words; this file serves the page of the desktop app.

export type Translate = (
  key: MessageKey,
  params?: Readonly<Record<string, string | number>>,
) => string

/** The name of a block. The block "No organization" takes its name from the catalogue. */
export const blockName = (t: Translate, block: Pick<OrgBlock, "orgId" | "name">) =>
  block.orgId === null
    ? t("orgchart.noOrganization")
    : block.name !== ""
      ? block.name
      : t("orgchart.noOrganization")

/** The line of a block header: the number of members and the counts by state. */
export const blockLine = (t: Translate, block: OrgBlock) => {
  const members =
    block.memberCount === 1
      ? t("orgchart.members.one")
      : t("orgchart.members", { count: block.memberCount })
  const states = block.counts
    .map((c) => t(`orgchart.counts.${c.state}` as MessageKey, { count: c.count }))
    .join(" · ")
  return [members, states].filter((part) => part !== "").join(" · ")
}

/** The outcome line of a block: "12 done · 2 blocked", or "" when every count is 0. */
export const outcomeLineOf = (t: Translate, block: OrgBlock) =>
  block.outcome
    .map((c) => t(`orgchart.outcome.${c.word}` as MessageKey, { count: c.count }))
    .join(" · ")
