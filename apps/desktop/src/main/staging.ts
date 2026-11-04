import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { extname, join } from "node:path"
import { ATTACH_BYTES } from "@robot/shared"
import { AppError } from "./services/errors.ts"

// A picture or a video from the clipboard has no file on disk, and a picture that the user drags
// out of a web page has none either. The message box attaches a file by its path, so the app
// saves the bytes here first (spec 003, flow 4). The send copies the file into the workspace of
// the agent, as it does for any other file. This folder is only a waiting place.

/** The folder where files without a path wait until the user sends them. */
export const STAGE_ROOT = join(tmpdir(), "robot-staged")

/** A staged file is removed when it is older than this. */
const KEEP_MS = 24 * 60 * 60 * 1000
const NAME_MAX = 120
const EXTENSION_MAX = 16

/** A name that is safe for a file: no folders, no control characters, not empty, not too long. */
export const stageName = (name: string): string => {
  const last = name.split(/[\\/]/).pop() ?? ""
  const clean = [...last]
    .map((c) => {
      const code = c.codePointAt(0) ?? 0
      return code < 32 || code === 127 || '<>:"|?*'.includes(c) ? "_" : c
    })
    .join("")
    .replace(/^\.+/, "")
    .trim()
  if (!clean) return "pasted"
  if (clean.length <= NAME_MAX) return clean
  const ext = extname(clean).slice(0, EXTENSION_MAX)
  return clean.slice(0, NAME_MAX - ext.length) + ext
}

/** Removes the staged files that are older than a day. A failure here never stops a paste. */
const sweep = (root: string, now: number) => {
  try {
    for (const entry of readdirSync(root)) {
      const path = join(root, entry)
      if (now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { recursive: true, force: true })
    }
  } catch {
    // The folder may be in use by another start of the app. The next paste tries again.
  }
}

/**
 * Saves the bytes of a file in a folder of its own under `root` and returns the full path. The
 * name is kept, so the chip and the copy in the workspace show what the user pasted.
 */
export const stageFile = (
  root: string,
  name: string,
  data: Uint8Array,
  now: number = Date.now(),
): string => {
  const clean = stageName(name)
  if (data.byteLength > ATTACH_BYTES) throw new AppError({ code: "file_too_large", detail: clean })
  mkdirSync(root, { recursive: true, mode: 0o700 })
  sweep(root, now)
  const path = join(mkdtempSync(join(root, "f-")), clean)
  writeFileSync(path, data, { mode: 0o600 })
  return path
}
