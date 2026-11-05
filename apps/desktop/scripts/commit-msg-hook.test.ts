import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

// AGENTS.md: "Never add AI co-author trailers to commits". A tool can add one to the message
// after the author writes it, so the hook cleans the message. These tests hold that.

const HOOK = resolve(import.meta.dirname, "../../../.githooks/commit-msg")

/** Writes a message file, runs the hook on it, and returns what the hook left. */
const afterHook = (message: string) => {
  const folder = mkdtempSync(join(tmpdir(), "commit-msg-"))
  const file = join(folder, "COMMIT_EDITMSG")
  writeFileSync(file, message)
  const run = Bun.spawnSync(["sh", HOOK, file])
  expect(run.exitCode).toBe(0)
  return readFileSync(file, "utf8")
}

describe("the commit-msg hook", () => {
  describe("with a trailer of a coding tool", () => {
    test("it takes the trailer out and keeps the text", () => {
      const message = afterHook(
        "fix(theme): title\n\nBody line one.\nBody line two.\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\n",
      )
      expect(message).toBe("fix(theme): title\n\nBody line one.\nBody line two.\n")
    })

    test("it finds the tool whatever the case of the trailer", () => {
      const message = afterHook(
        "feat: title\n\nco-authored-by: GitHub Copilot <noreply@github.com>\nCo-Authored-By: Claude <noreply@anthropic.com>\n",
      )
      expect(message).toBe("feat: title\n")
    })

    test("it drops the tool and keeps a trailer for a person", () => {
      const message = afterHook(
        "feat: title\n\nBody.\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\nCo-authored-by: Ada Lovelace <ada@example.com>\n",
      )
      expect(message).toBe(
        "feat: title\n\nBody.\n\nCo-authored-by: Ada Lovelace <ada@example.com>\n",
      )
    })

    test("it takes the trailer out of the middle of the text too", () => {
      const message = afterHook(
        "feat: title\n\nCo-authored-by: Cursor <cursoragent@cursor.com>\nmore text after\n",
      )
      expect(message).toBe("feat: title\n\nmore text after\n")
    })
  })

  describe("with a message that has no tool in it", () => {
    test("it leaves the message as it was", () => {
      const message = "feat: title\n\nBody.\n"
      expect(afterHook(message)).toBe(message)
    })

    test("it leaves a trailer for a person", () => {
      const message = "feat: title\n\nBody.\n\nCo-authored-by: Ada Lovelace <ada@example.com>\n"
      expect(afterHook(message)).toBe(message)
    })
  })

  describe("with nothing left after the tool trailer", () => {
    test("it leaves the message alone, so a commit still has a message", () => {
      const message = "Co-authored-by: Cursor <cursoragent@cursor.com>\n"
      expect(afterHook(message)).toBe(message)
    })
  })
})
