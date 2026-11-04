import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { ATTACH_BYTES } from "@robot/shared"
import { AppError } from "./services/errors.ts"
import { stageFile, stageName } from "./staging.ts"

const roots: string[] = []
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "robot-staging-test-"))
  roots.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("stageName", () => {
  test("keeps a plain name", () => {
    expect(stageName("image.png")).toBe("image.png")
    expect(stageName("Screen Shot 한글.mov")).toBe("Screen Shot 한글.mov")
  })

  test("cuts folders, so a name cannot leave the staging folder", () => {
    expect(stageName("../../etc/passwd")).toBe("passwd")
    expect(stageName("C:\\Users\\a\\clip.mp4")).toBe("clip.mp4")
    expect(stageName("..")).toBe("pasted")
  })

  test("replaces control characters and characters that a disk refuses", () => {
    expect(stageName("a\nb\u0000c.png")).toBe("a_b_c.png")
    expect(stageName('a:b"c.png')).toBe("a_b_c.png")
  })

  test("falls back to a name when nothing is left", () => {
    expect(stageName("")).toBe("pasted")
    expect(stageName("   ")).toBe("pasted")
    expect(stageName(".hidden")).toBe("hidden")
  })

  test("cuts a long name and keeps its extension", () => {
    const name = stageName(`${"a".repeat(300)}.png`)
    expect(name.length).toBe(120)
    expect(name.endsWith(".png")).toBe(true)
  })
})

describe("stageFile", () => {
  test("saves the bytes under the name, in a folder of its own", () => {
    const dir = root()
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const path = stageFile(dir, "image.png", bytes)
    expect(basename(path)).toBe("image.png")
    expect(dirname(dirname(path))).toBe(dir)
    expect([...readFileSync(path)]).toEqual([...bytes])
  })

  test("two pastes of one name do not overwrite each other", () => {
    const dir = root()
    const a = stageFile(dir, "image.png", new Uint8Array([1]))
    const b = stageFile(dir, "image.png", new Uint8Array([2]))
    expect(a).not.toBe(b)
    expect([...readFileSync(a)]).toEqual([1])
    expect([...readFileSync(b)]).toEqual([2])
  })

  test("a file is private to the user", () => {
    if (process.platform === "win32") return
    const path = stageFile(root(), "clip.mp4", new Uint8Array([1]))
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  test("refuses a file over the limit of an attachment, and writes nothing", () => {
    const dir = root()
    let caught: unknown
    try {
      stageFile(dir, "big.mov", new Uint8Array(ATTACH_BYTES + 1))
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(AppError)
    expect(caught).toMatchObject({ code: "file_too_large", detail: "big.mov" })
    expect(readdirSync(dir)).toEqual([])
  })

  test("takes a file of exactly the limit", () => {
    const path = stageFile(root(), "edge.bin", new Uint8Array(ATTACH_BYTES))
    expect(statSync(path).size).toBe(ATTACH_BYTES)
  })

  test("removes what is older than a day and keeps what is newer", () => {
    const dir = root()
    const old = stageFile(dir, "old.png", new Uint8Array([1]))
    const recent = stageFile(dir, "recent.png", new Uint8Array([2]))
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(dirname(old), twoDaysAgo, twoDaysAgo)
    stageFile(dir, "new.png", new Uint8Array([3]))
    expect(existsSync(old)).toBe(false)
    expect(existsSync(recent)).toBe(true)
  })
})
