import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ATTACH_BYTES, ATTACH_MAX, UPLOAD_PREFIX } from "@robot/shared"
import { safeName, type UploadError, Uploads } from "./uploads.ts"

const roots: string[] = []
const make = (now?: () => number) => {
  const root = mkdtempSync(join(tmpdir(), "robot-uploads-test-"))
  roots.push(root)
  return new Uploads(root, now)
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

const b64 = (text: string) => Buffer.from(text).toString("base64")
const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return (e as UploadError).code
  }
  return undefined
}

describe("files that a linked device uploads", () => {
  test("pieces in order give a token that only that device can use", () => {
    const uploads = make()
    const first = uploads.put("dev-a", {
      uploadId: "u1",
      name: "note.txt",
      offset: 0,
      data: b64("hello "),
      done: false,
    })
    expect(first).toEqual({ size: 6, token: null })
    const last = uploads.put("dev-a", {
      uploadId: "u1",
      name: "note.txt",
      offset: 6,
      data: b64("world"),
      done: true,
    })
    expect(last.size).toBe(11)
    expect(last.token).toBe(`${UPLOAD_PREFIX}dev-a:u1`)
    const path = uploads.resolve("dev-a", last.token as string)
    expect(path && readFileSync(path, "utf8")).toBe("hello world")
    // Another device that names the same token gets nothing.
    expect(uploads.resolve("dev-b", last.token as string)).toBeUndefined()
    expect(uploads.resolve("dev-b", `${UPLOAD_PREFIX}dev-a:u1`)).toBeUndefined()
  })

  test("a path is not a token, and a token that was not finished does not resolve", () => {
    const uploads = make()
    expect(uploads.resolve("dev-a", "/etc/passwd")).toBeUndefined()
    expect(uploads.resolve("dev-a", "../../etc/passwd")).toBeUndefined()
    uploads.put("dev-a", { uploadId: "u1", name: "a.txt", offset: 0, data: b64("x"), done: false })
    expect(uploads.resolve("dev-a", `${UPLOAD_PREFIX}dev-a:u1`)).toBeUndefined()
  })

  test("a piece must start where the last one ended", () => {
    const uploads = make()
    uploads.put("dev-a", {
      uploadId: "u1",
      name: "a.txt",
      offset: 0,
      data: b64("abc"),
      done: false,
    })
    expect(
      code(() =>
        uploads.put("dev-a", {
          uploadId: "u1",
          name: "a.txt",
          offset: 0,
          data: b64("abc"),
          done: false,
        }),
      ),
    ).toBe("invalid_input")
    expect(
      code(() =>
        uploads.put("dev-a", {
          uploadId: "u1",
          name: "a.txt",
          offset: 9,
          data: b64("abc"),
          done: false,
        }),
      ),
    ).toBe("invalid_input")
    // A first piece that does not start at 0 belongs to an upload that is gone.
    expect(
      code(() =>
        uploads.put("dev-a", {
          uploadId: "new",
          name: "a.txt",
          offset: 5,
          data: b64("abc"),
          done: false,
        }),
      ),
    ).toBe("upload_gone")
  })

  test("a file over the limit stops, and nothing stays", () => {
    const uploads = make()
    const big = Buffer.alloc(ATTACH_BYTES, 1).toString("base64")
    uploads.put("dev-a", { uploadId: "big", name: "big.bin", offset: 0, data: big, done: false })
    expect(
      code(() =>
        uploads.put("dev-a", {
          uploadId: "big",
          name: "big.bin",
          offset: ATTACH_BYTES,
          data: b64("x"),
          done: true,
        }),
      ),
    ).toBe("file_too_large")
    expect(uploads.count).toBe(0)
  })

  test("one device keeps at most as many open files as a message can hold", () => {
    const uploads = make()
    for (let i = 0; i < ATTACH_MAX; i++) {
      uploads.put("dev-a", {
        uploadId: `u${i}`,
        name: `f${i}`,
        offset: 0,
        data: b64("x"),
        done: true,
      })
    }
    expect(
      code(() =>
        uploads.put("dev-a", {
          uploadId: "more",
          name: "f",
          offset: 0,
          data: b64("x"),
          done: true,
        }),
      ),
    ).toBe("too_many_files")
    // Another device has its own room.
    expect(
      uploads.put("dev-b", { uploadId: "u0", name: "f", offset: 0, data: b64("x"), done: true })
        .token,
    ).not.toBeNull()
  })

  test("a used or dropped file is removed from the disk", () => {
    const uploads = make()
    const ack = uploads.put("dev-a", {
      uploadId: "u1",
      name: "a.txt",
      offset: 0,
      data: b64("x"),
      done: true,
    })
    const path = uploads.resolve("dev-a", ack.token as string) as string
    expect(existsSync(path)).toBe(true)
    uploads.discard(ack.token as string)
    expect(existsSync(path)).toBe(false)
    uploads.put("dev-a", { uploadId: "u2", name: "b.txt", offset: 0, data: b64("x"), done: true })
    uploads.put("dev-b", { uploadId: "u3", name: "c.txt", offset: 0, data: b64("x"), done: true })
    uploads.discardDevice("dev-a")
    expect(uploads.count).toBe(1)
  })

  test("a file that waits too long is dropped", () => {
    let now = 1_000
    const uploads = make(() => now)
    uploads.put("dev-a", { uploadId: "old", name: "a.txt", offset: 0, data: b64("x"), done: true })
    now += 16 * 60 * 1000
    uploads.put("dev-a", { uploadId: "new", name: "b.txt", offset: 0, data: b64("x"), done: true })
    expect(uploads.resolve("dev-a", `${UPLOAD_PREFIX}dev-a:old`)).toBeUndefined()
    expect(uploads.resolve("dev-a", `${UPLOAD_PREFIX}dev-a:new`)).toBeDefined()
  })

  test("a file name has no folder and no control character", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd")
    expect(safeName("C:\\Users\\me\\report.pdf")).toBe("report.pdf")
    expect(safeName("a\u0000b\u001fc.txt")).toBe("abc.txt")
    expect(safeName("..")).toBe("file")
    expect(safeName("")).toBe("file")
    expect(safeName("x".repeat(500)).length).toBe(200)
  })
})
