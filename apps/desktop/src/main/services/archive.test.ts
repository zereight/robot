import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unzipSync } from "fflate"
import { isPacked, writeZip } from "./archive.ts"

let dir = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "robot-archive-test-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Words that repeat, like the text of a database: they pack well. */
const words = (bytes: number) =>
  Buffer.from("A reply of the agent, with some words in it. ".repeat(Math.ceil(bytes / 45)))

/** Bytes with no pattern: they do not pack. */
const noise = (bytes: number) => {
  const out = Buffer.alloc(bytes)
  let seed = 12345
  for (let i = 0; i < bytes; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    out[i] = seed >> 16
  }
  return out
}

test("files from the disk and from memory come out of the archive as they went in", async () => {
  const text = words(3_000_000)
  const photo = noise(500_000)
  writeFileSync(join(dir, "big.txt"), text)
  writeFileSync(join(dir, "photo.png"), photo)
  writeFileSync(join(dir, "empty.txt"), "")
  const target = join(dir, "out.zip")

  await writeZip(target, [
    { name: "README.txt", data: new TextEncoder().encode("Hello") },
    { name: "robot.db", path: join(dir, "big.txt") },
    { name: "attachments/a1/photo.png", path: join(dir, "photo.png") },
    { name: "attachments/a1/empty.txt", path: join(dir, "empty.txt") },
    { name: "knowledge/a1/Sähkö ja häiriö.md", data: new TextEncoder().encode("# Title") },
    { name: "none.bin", data: new Uint8Array(0) },
  ])

  const entries = unzipSync(readFileSync(target))
  expect(Object.keys(entries).sort()).toEqual(
    [
      "README.txt",
      "robot.db",
      "attachments/a1/photo.png",
      "attachments/a1/empty.txt",
      "knowledge/a1/Sähkö ja häiriö.md",
      "none.bin",
    ].sort(),
  )
  expect(Buffer.from(entries["README.txt"] as Uint8Array).toString()).toBe("Hello")
  expect(Buffer.from(entries["robot.db"] as Uint8Array).equals(text)).toBe(true)
  expect(Buffer.from(entries["attachments/a1/photo.png"] as Uint8Array).equals(photo)).toBe(true)
  expect(entries["attachments/a1/empty.txt"]?.length).toBe(0)
  expect(Buffer.from(entries["knowledge/a1/Sähkö ja häiriö.md"] as Uint8Array).toString()).toBe(
    "# Title",
  )
  expect(entries["none.bin"]?.length).toBe(0)
})

test("text is deflated and a picture is only stored", async () => {
  const same = words(1_000_000)
  writeFileSync(join(dir, "same.bin"), same)
  const sizes: Record<string, number> = {}
  for (const name of ["as-text.txt", "as-photo.png"]) {
    const target = join(dir, `${name}.zip`)
    await writeZip(target, [{ name, path: join(dir, "same.bin") }])
    sizes[name] = statSync(target).size
  }
  // Packed: a small part of the text. Stored: the whole text plus a little for the headers.
  expect(sizes["as-text.txt"]).toBeLessThan(100_000)
  expect(sizes["as-photo.png"]).toBeGreaterThan(same.length)
  expect(sizes["as-photo.png"]).toBeLessThan(same.length + 1000)
})

test("the system unzip accepts the archive", async () => {
  const unzip = Bun.which("unzip")
  if (!unzip) return // A computer without the program cannot check this.
  writeFileSync(join(dir, "big.txt"), words(2_000_000))
  writeFileSync(join(dir, "photo.jpg"), noise(300_000))
  const target = join(dir, "out.zip")
  await writeZip(target, [
    { name: "a/big.txt", path: join(dir, "big.txt") },
    { name: "a/photo.jpg", path: join(dir, "photo.jpg") },
    { name: "b.txt", data: new TextEncoder().encode("x") },
  ])
  const run = Bun.spawnSync([unzip, "-t", target])
  expect(run.stdout.toString()).toContain("No errors detected")
  expect(run.exitCode).toBe(0)
})

test("a file that cannot be read stops the archive and leaves no half-written file", async () => {
  const target = join(dir, "out.zip")
  writeFileSync(join(dir, "ok.txt"), "fine")
  await expect(
    writeZip(target, [
      { name: "ok.txt", path: join(dir, "ok.txt") },
      { name: "gone.txt", path: join(dir, "missing.txt") },
    ]),
  ).rejects.toThrow()
  expect(existsSync(target)).toBe(false)

  await expect(
    writeZip(target, [{ name: "gone.png", path: join(dir, "missing.png") }]),
  ).rejects.toThrow()
  expect(existsSync(target)).toBe(false)
})

test("an archive of no files is a valid archive", async () => {
  const target = join(dir, "none.zip")
  await writeZip(target, [])
  expect(Object.keys(unzipSync(readFileSync(target)))).toEqual([])
})

test("formats that are packed already are told by the name", () => {
  for (const name of ["a.PNG", "b.jpeg", "c.mp4", "d.zip", "e.docx", "f.M4A"])
    expect(isPacked(name)).toBe(true)
  for (const name of ["a.txt", "b.md", "c.json", "d.pdf", "robot.db", "e", "f.wav", "g.csv"])
    expect(isPacked(name)).toBe(false)
})
