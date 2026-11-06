/** A JSON list of ids. A text that holds no list gives an empty one. */
export const idList = (text: string | null | undefined): string[] => {
  if (text === null || text === undefined) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []
  } catch {
    return []
  }
}

/**
 * Whether an agent may use the skill or the connection of a stored row (spec 017, 018): "All
 * agents" is on (no list), or the list holds the agent. The caller checks that the row is on.
 */
export const mayUseRow = (row: { readonly agents: string | null }, agentId: string): boolean =>
  row.agents === null || idList(row.agents).includes(agentId)
