/**
 * Puts a message into a list that is in order of creation, as the history is. A changed message
 * keeps its place. A new message goes after every message that was made at the same time or
 * before it. Messages of a computer that syncs can arrive in any order (spec 019), so the end of
 * the list is not always the right place.
 */
export const placeMessage = <M extends { readonly id: string; readonly createdAt: number }>(
  list: M[],
  message: M,
): void => {
  const index = list.findIndex((m) => m.id === message.id)
  if (index >= 0) {
    list[index] = message
    return
  }
  let at = list.length
  while (at > 0 && (list[at - 1] as M).createdAt > message.createdAt) at--
  list.splice(at, 0, message)
}
