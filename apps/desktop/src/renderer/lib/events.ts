/**
 * The server that a view shows: the id of a linked server, or undefined for this computer.
 * An event carries the same: the linked server that sent it, or undefined for this computer.
 */
export type ViewServer = string | undefined

/**
 * True when an event is for a view. A view shows one computer: this computer or one linked
 * server (spec 012). Two computers that sync hold copies with the same ids (spec 019), so
 * a view takes the events of its own computer only.
 */
export const isForView = (view: ViewServer, from: ViewServer): boolean => view === from
