// The picture of a channel (spec 004, "Picture"). The window cuts the image the user picks to a
// square of 256 px and writes a PNG. These are the limits that every part checks again: the
// service that saves it, sync, and a linked device that sends it.

/** The side of the square, in pixels. A picture of a smaller side is allowed. */
export const CHANNEL_PICTURE_EDGE = 256
/** The most bytes of the PNG. */
export const CHANNEL_PICTURE_BYTES = 1024 * 1024

const PREFIX = "data:image/png;base64,"
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

export type ChannelPictureCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: "channel_picture_invalid" | "channel_picture_too_large" }

const invalid = { ok: false, code: "channel_picture_invalid" } as const

/**
 * Checks a picture as a data address of a PNG: the address, the signature of a PNG, a square
 * image of at most 256 px a side, and at most 1 MB. It reads the head of the image only, so it
 * costs nothing for a large picture.
 */
export const checkChannelPicture = (value: unknown): ChannelPictureCheck => {
  if (typeof value !== "string" || !value.startsWith(PREFIX)) return invalid
  const data = value.slice(PREFIX.length)
  if (data.length < 44 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    return invalid
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0
  const bytes = (data.length / 4) * 3 - padding
  if (bytes > CHANNEL_PICTURE_BYTES) return { ok: false, code: "channel_picture_too_large" }
  // 24 bytes: the signature, the length and name of the first chunk (IHDR), the width, the height.
  const head = Uint8Array.from(atob(data.slice(0, 32)), (c) => c.charCodeAt(0))
  if (!SIGNATURE.every((b, i) => head[i] === b)) return invalid
  if (String.fromCharCode(...head.slice(12, 16)) !== "IHDR") return invalid
  const word = (at: number) =>
    (head[at] ?? 0) * 0x1000000 +
    (((head[at + 1] ?? 0) << 16) | ((head[at + 2] ?? 0) << 8) | (head[at + 3] ?? 0))
  const width = word(16)
  const height = word(20)
  if (width !== height || width < 1 || width > CHANNEL_PICTURE_EDGE) return invalid
  return { ok: true }
}

/** True when `value` is a picture that `checkChannelPicture` accepts. */
export const isChannelPicture = (value: unknown): value is string => checkChannelPicture(value).ok
