import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { realOf } from "./realPath.ts"

// Spec 025: the app resolves links, also a link that points at nothing yet.

const base = () => realpathSync(mkdtempSync(join(tmpdir(), "robot-realpath-")))

describe("realOf", () => {
  test("a file that exists, and a file that is not there yet", () => {
    const d = base()
    writeFileSync(join(d, "a.md"), "x")
    expect(realOf(join(d, "a.md"))).toBe(join(d, "a.md"))
    expect(realOf(join(d, "new", "deep", "b.md"))).toBe(join(d, "new", "deep", "b.md"))
  })
  test("a link to a file", () => {
    const d = base()
    writeFileSync(join(d, "a.md"), "x")
    symlinkSync("a.md", join(d, "l.md"))
    expect(realOf(join(d, "l.md"))).toBe(join(d, "a.md"))
  })
  test("a dangling link counts at its target, relative or absolute", () => {
    const d = base()
    symlinkSync("target.md", join(d, "rel.md"))
    symlinkSync(join(d, "abs.md"), join(d, "absl.md"))
    expect(realOf(join(d, "rel.md"))).toBe(join(d, "target.md"))
    expect(realOf(join(d, "target.md"))).toBe(join(d, "target.md"))
    expect(realOf(join(d, "absl.md"))).toBe(join(d, "abs.md"))
  })
  test("a dangling link into a folder that is not there yet", () => {
    const d = base()
    symlinkSync("sub/target.md", join(d, "l.md"))
    expect(realOf(join(d, "l.md"))).toBe(join(d, "sub", "target.md"))
  })
  test("a dangling link in a folder that is a link", () => {
    const d = base()
    mkdirSync(join(d, "real"))
    symlinkSync("real", join(d, "dir"))
    symlinkSync("../gone.md", join(d, "real", "l.md"))
    expect(realOf(join(d, "dir", "l.md"))).toBe(join(d, "gone.md"))
  })
  test("a chain of links to a file that is not there", () => {
    const d = base()
    symlinkSync("two.md", join(d, "one.md"))
    symlinkSync("three.md", join(d, "two.md"))
    symlinkSync("end.md", join(d, "three.md"))
    expect(realOf(join(d, "one.md"))).toBe(join(d, "end.md"))
  })
  test("a loop of links ends and keeps the name of the link", () => {
    const d = base()
    symlinkSync("b.md", join(d, "a.md"))
    symlinkSync("a.md", join(d, "b.md"))
    symlinkSync("self.md", join(d, "self.md"))
    expect(realOf(join(d, "a.md"))).toBe(join(d, "a.md"))
    expect(realOf(join(d, "self.md"))).toBe(join(d, "self.md"))
  })
  test("a very long chain ends", () => {
    const d = base()
    for (let i = 0; i < 100; i++) symlinkSync(`l${i + 1}.md`, join(d, `l${i}.md`))
    expect(typeof realOf(join(d, "l0.md"))).toBe("string")
  })
})
