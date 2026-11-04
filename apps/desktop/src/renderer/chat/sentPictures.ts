import { pictureType } from "@robot/shared"
import { call } from "../lib/rpc.ts"
import { fitEdge } from "./thumbnail.ts"

// The small pictures above a sent message (spec 003, flow 4). The window asks for the bytes of a
// picture of a message, cuts it down to a small picture, and keeps only that. A large photo must
// not stay in memory for each message of a long chat.

/**
 * The longer side of a saved small picture, in pixels. The picture shows at half of that, so it is
 * sharp on a dense screen. The style sheet sets the size on the screen (`sentPicture`).
 */
export const THUMBNAIL_EDGE = 256

export interface SentPictureAsk {
  readonly agentId: string
  readonly path: string
  readonly size: number
  readonly messageId: string
}

/** Cuts the bytes down to a small picture. Undefined when the window cannot read them as a picture. */
const cutDown = async (bytes: Uint8Array, type: string): Promise<string | undefined> => {
  const blob = new Blob([bytes as BlobPart], { type })
  try {
    const bitmap = await createImageBitmap(blob)
    const size = fitEdge(bitmap.width, bitmap.height, THUMBNAIL_EDGE)
    // A picture that is already small is shown as it is.
    if (!size) {
      bitmap.close()
      return URL.createObjectURL(blob)
    }
    const canvas = document.createElement("canvas")
    canvas.width = size.width
    canvas.height = size.height
    const context = canvas.getContext("2d")
    if (!context) {
      bitmap.close()
      return undefined
    }
    context.imageSmoothingQuality = "high"
    context.drawImage(bitmap, 0, 0, size.width, size.height)
    bitmap.close()
    const small = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"))
    return small ? URL.createObjectURL(small) : undefined
  } catch {
    return undefined
  }
}

const fetchSmall = async (ask: SentPictureAsk): Promise<string | undefined> => {
  const type = pictureType(ask.path)
  if (!type) return undefined
  try {
    const bytes = await call("attachments.picture", ask)
    return bytes ? await cutDown(bytes, type) : undefined
  } catch {
    // The file is gone, or a linked server does not answer. The message shows its file chip only.
    return undefined
  }
}

// The small pictures of this run of the app, by message and file. Each one is some kilobytes.
const held = new Map<string, Promise<string | undefined>>()

/**
 * The address of the small picture of a file of a message, or undefined when there is none. A
 * second ask for the same file gets the same picture, so a message that leaves the screen and
 * comes back does not load again. A failed ask is not kept, so the next one tries again.
 */
export const loadSentPicture = (ask: SentPictureAsk): Promise<string | undefined> => {
  const key = `${ask.messageId}|${ask.path}|${ask.size}`
  let found = held.get(key)
  if (!found) {
    found = fetchSmall(ask)
    held.set(key, found)
    void found.then((url) => {
      if (!url && held.get(key) === found) held.delete(key)
    })
  }
  return found
}
