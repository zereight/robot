/**
 * The server that a view shows: the id of a linked server, or undefined for this computer.
 * An event carries the same: the linked server that sent it, or undefined for this computer.
 */
export type ViewServer = string | undefined

/**
 * True when an event is for a view. Agents and channels that two computers sync have the same id
 * on both, so a view of this computer must not take the event of the other computer's copy, and
 * a view of the linked server must not take the event of the copy here (spec 012, 019).
 */
export const isForView = (view: ViewServer, from: ViewServer): boolean => view === from
