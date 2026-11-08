/**
 * The server that a view shows: the id of a linked server, or undefined for this computer.
 * An event carries the same: the linked server that sent it, or undefined for this computer.
 */
export type ViewServer = string | undefined

/**
 * True when an event is for a view. A view shows one computer: this computer or one linked
 * server (spec 012). An event belongs to the computer that made it, so a view takes the events
 * of its own computer only (spec 038).
 */
export const isForView = (view: ViewServer, from: ViewServer): boolean => view === from
