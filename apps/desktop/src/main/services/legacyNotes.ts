/**
 * A SQL test on `parts` that is true for every message that is not an old muted line of a repaired
 * channel tree. A version before the organizations (spec 030) posted that line in a channel when it
 * cleared a parent channel. No version posts it now, but the line stays in the history, and a
 * computer that was not updated can still send one. It is not a message of an agent: it adds no
 * unread count and does not replace the preview of the place. The text of the parts is the JSON
 * that this app writes; text of a user or an agent has its quotes escaped, so it cannot match.
 */
export const NOT_REPAIR_LINE = `parts NOT LIKE '%"note":"tree_repaired"%'`
