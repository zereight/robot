import { describe, expect, test } from "bun:test"
import {
  CHANNEL_PICTURE_BYTES,
  CHANNEL_PICTURE_EDGE,
  checkChannelPicture,
  isChannelPicture,
} from "./channelPicture.ts"

/** The head of a PNG with a side, and a body of zero bytes up to `total` bytes. */
const png = (width: number, height: number, total = 100) => {
  const bytes = new Uint8Array(Math.max(total, 33))
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
}

describe("checkChannelPicture", () => {
  test("a square PNG of 256 px is accepted, and so is a smaller one", () => {
    expect(checkChannelPicture(png(256, 256))).toEqual({ ok: true })
    expect(checkChannelPicture(png(64, 64))).toEqual({ ok: true })
    expect(isChannelPicture(png(256, 256))).toBe(true)
  })

  test("a side over 256 px, or an image that is not square, is refused", () => {
    expect(checkChannelPicture(png(CHANNEL_PICTURE_EDGE + 1, CHANNEL_PICTURE_EDGE + 1))).toEqual({
      ok: false,
      code: "channel_picture_invalid",
    })
    expect(checkChannelPicture(png(256, 200)).ok).toBe(false)
    expect(checkChannelPicture(png(0, 0)).ok).toBe(false)
  })

  test("more than 1 MB is refused as too large", () => {
    expect(checkChannelPicture(png(256, 256, CHANNEL_PICTURE_BYTES))).toEqual({ ok: true })
    expect(checkChannelPicture(png(256, 256, CHANNEL_PICTURE_BYTES + 1))).toEqual({
      ok: false,
      code: "channel_picture_too_large",
    })
  })

  test("anything that is not the data address of a PNG is refused", () => {
    expect(checkChannelPicture("data:image/jpeg;base64,AAAA").ok).toBe(false)
    expect(checkChannelPicture("https://example.com/a.png").ok).toBe(false)
    expect(checkChannelPicture(`data:image/png;base64,${"!".repeat(60)}`).ok).toBe(false)
    expect(checkChannelPicture(null).ok).toBe(false)
    expect(checkChannelPicture(42).ok).toBe(false)
    // The right type, but the bytes are not a PNG.
    const text = Buffer.from("this is not a png at all, it is a line of text.").toString("base64")
    expect(checkChannelPicture(`data:image/png;base64,${text}`).ok).toBe(false)
  })
})
