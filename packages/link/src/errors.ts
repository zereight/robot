/**
 * The error codes of the link that a client shows as plain lines (spec 012, "States" and the
 * pairing errors). A server can also answer a request with the code of the request, for example
 * `file_too_large`; those pass through as they are.
 */
export const LINK_ERROR_CODES = [
  /** The code was not right. */
  "wrong_code",
  /** The code ended: it was used, it timed out, or 5 wrong tries ended it. */
  "code_ended",
  /** No address answered. The text asks the user to check the network or the VPN. */
  "unreachable",
  /** The computer answered, but "Let other devices connect" is off there. */
  "not_accepting",
  /** The device would pair with itself. */
  "same_device",
  /** The user of the computer said Deny, or did not answer in time. */
  "denied",
  /** The computer has 10 linked devices, or this device opens 10 servers. */
  "limit",
  /** The server removed this device. */
  "not_allowed",
  /** One side has another protocol version. The detail says which side must update. */
  "update_app",
  /** The text is not a link text of ROBot. */
  "invalid_link",
  /** The text is not an address. */
  "invalid_address",
  /** The connection is not open. */
  "offline",
  /** The server did not answer in time. */
  "timeout",
] as const
export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number]

/** Why a connection or a request did not work. `code` is one of the codes above, or of a request. */
export class LinkError extends Error {
  readonly code: string
  readonly detail: string | undefined
  constructor(code: string, detail?: string) {
    super(code)
    this.code = code
    this.detail = detail
  }
}

/** Which side must update the app, from the version that the other side sent. */
export const updateSide = (otherVersion: number, ownVersion: number): "this" | "server" =>
  otherVersion > ownVersion ? "this" : "server"
