import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { PUSHED_EVENTS } from "@robot/link"

/** The source of the main process, without the tests. */
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sources(path)
    return /\.tsx?$/.test(name) && !/\.test\./.test(name) && !/\.testing\./.test(name)
      ? [readFileSync(path, "utf8")]
      : []
  })

describe("the events that a server pushes to linked devices (spec 012)", () => {
  test("each pushed event has an emitter in the server", () => {
    const code = sources(join(import.meta.dirname, ".."))
    for (const event of PUSHED_EVENTS) {
      const emitted = code.some((text) =>
        new RegExp(`emit\\(\\s*"${event.replace(".", "\\.")}"`).test(text),
      )
      expect({ event, emitted }).toEqual({ event, emitted: true })
    }
  })

  test("the list holds no event that nothing emits (no stale entry)", () => {
    expect([...PUSHED_EVENTS].sort()).toEqual([
      "chat.message",
      "chat.state",
      "memory.changed",
      "runs.changed",
      "workflows.changed",
    ])
  })
})
