import { describe, expect, test } from "bun:test"
import { type Dirent, readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

// Rules for temporary folders.
//
// One computer collected over a million temporary folders from tests and from the app, and a
// program that starts in a working folder inside the temporary folder then took 5 to 13 seconds.
// The cure has three parts, and this test keeps each one from coming back:
// - The unit tests have their own temporary folder per process (`test-preload.ts`).
// - The end-to-end runs make one folder for the whole run and remove it (`e2e/global-setup.ts`).
//   A folder that a test makes with `tmpdir()` lands in it. A folder at a fixed place such as /tmp
//   does not, so it stays for ever.
// - The app makes its folders through `stale-temp.ts`, so that a start after a kill can remove
//   what the killed app left.
//
// A rule has a list of known exceptions, each with its reason. A new use that is not on the list
// fails the test. A listed exception that is gone must leave the list.

const repo = join(import.meta.dir, "../../../..")

const SKIP = new Set(["node_modules", ".git", "out", "build", "dist", ".expo", "ios", "android"])

const files = (dir: string, take: (path: string) => boolean): string[] => {
  const found: string[] = []
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...files(path, take))
    else if (take(path)) found.push(path)
  }
  return found.sort()
}

const isSource = (path: string) => /\.(?:ts|tsx|mts|mjs|js)$/.test(path)

/**
 * The text without its comments, with the same length and the same lines, so that a line number
 * stays right. A `//` after a colon (an address) is not a comment.
 */
export const withoutComments = (text: string) =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(
      /(^|[^:\w"'`])\/\/.*$/gm,
      (c, before: string) => before + " ".repeat(c.length - before.length),
    )

/** The text of the first argument of the call whose `(` is at `open`. */
export const firstArgument = (text: string, open: number) => {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "(" || c === "[" || c === "{") depth++
    else if (c === ")" || c === "]" || c === "}") {
      depth--
      if (depth === 0) return text.slice(open + 1, i)
    } else if (c === "," && depth === 1) return text.slice(open + 1, i)
  }
  return text.slice(open + 1)
}

/** The calls of `mkdtemp` and `mkdtempSync` whose first argument is not built from `tmpdir()`. */
export const mkdtempOutsideTmpdir = (source: string) => {
  const text = withoutComments(source)
  const found: { line: number; argument: string }[] = []
  for (const m of text.matchAll(/\bmkdtemp(?:Sync)?\s*\(/g)) {
    const open = (m.index ?? 0) + m[0].length - 1
    const argument = firstArgument(text, open).replace(/\s+/g, " ").trim()
    if (!/\btmpdir\s*\(/.test(argument))
      found.push({ line: text.slice(0, m.index).split("\n").length, argument })
  }
  return found
}

/** The string literals that start at /tmp or /var, and at their forms on macOS under /private. */
export const fixedTempPlaces = (source: string) => {
  const text = withoutComments(source)
  const found: { line: number; literal: string }[] = []
  for (const m of text.matchAll(/(["'`])(\/(?:private\/)?(?:tmp|var)(?:\/[^"'`]*)?)\1/g))
    found.push({ line: text.slice(0, m.index).split("\n").length, literal: m[2] as string })
  return found
}

/** The places in the code where a temporary folder of the computer is read or made. */
export const tmpdirUses = (source: string) => {
  const text = withoutComments(source)
  const found: number[] = []
  for (const m of text.matchAll(/\b(?:tmpdir|mkdtemp|mkdtempSync)\s*\(/g))
    found.push(text.slice(0, m.index).split("\n").length)
  return found
}

// ---- the checks themselves, on small texts -----------------------------------------------

describe("the checks find what they should", () => {
  test("mkdtemp without tmpdir() in its first argument", () => {
    expect(mkdtempOutsideTmpdir(`mkdtempSync(join(tmpdir(), "a-"))`)).toEqual([])
    expect(mkdtempOutsideTmpdir(`fs.mkdtemp(path.join(os.tmpdir(), "a-"))`)).toEqual([])
    expect(mkdtempOutsideTmpdir(`mkdtempSync(join(place.parent ?? tmpdir(), P), "x")`)).toEqual([])
    expect(mkdtempOutsideTmpdir(`mkdtempSync("/tmp/a-")`)).toEqual([
      { line: 1, argument: `"/tmp/a-"` },
    ])
    expect(mkdtempOutsideTmpdir(`const x = 1\nmkdtempSync(join(base, "a-"), tmpdir())`)).toEqual([
      { line: 2, argument: `join(base, "a-")` },
    ])
    // A word in a comment is not a call.
    expect(mkdtempOutsideTmpdir(`// mkdtempSync("/tmp/a-")\n/* mkdtemp("x") */`)).toEqual([])
  })

  test("a fixed place in /tmp or /var", () => {
    expect(fixedTempPlaces(`mkdtempSync("/tmp/s33-")`)).toEqual([{ line: 1, literal: "/tmp/s33-" }])
    expect(fixedTempPlaces(`x = '/var/folders/ab'; y = \`/private/tmp\``)).toEqual([
      { line: 1, literal: "/var/folders/ab" },
      { line: 1, literal: "/private/tmp" },
    ])
    expect(fixedTempPlaces(`x = "/tmp"`)).toEqual([{ line: 1, literal: "/tmp" }])
    // Other paths, an address and a comment are not fixed places.
    expect(
      fixedTempPlaces(`a = "/tmpfile"; b = "/variable"; c = "http://tmp/x"; // "/tmp/a"`),
    ).toEqual([])
  })

  test("a use of the temporary folder in code", () => {
    expect(tmpdirUses(`const a = tmpdir()\n// tmpdir()\nmkdtempSync(x)`)).toEqual([1, 3])
  })
})

// ---- the rules ---------------------------------------------------------------------------

/** The folders with code that runs the end-to-end tests, the performance run and the scripts. */
const outside = [
  "apps/desktop/e2e",
  "apps/desktop/perf",
  "apps/desktop/scripts",
  "apps/mobile/e2e",
  "apps/mobile/scripts",
]
const outsideFiles = outside.flatMap((dir) => files(join(repo, dir), isSource))

const rel = (path: string) => relative(repo, path)

describe("end-to-end tests, performance run and scripts", () => {
  test("a folder from mkdtemp starts from tmpdir(), so that it follows TMPDIR and the run folder", () => {
    const bad = outsideFiles.flatMap((path) =>
      mkdtempOutsideTmpdir(readFileSync(path, "utf8")).map(
        (b) => `${rel(path)}:${b.line} mkdtemp(${b.argument})`,
      ),
    )
    expect(bad).toEqual([])
  })

  // A literal place in /tmp or /var is outside the run folder: a folder made there stays for
  // ever. Each exception says why it is not a folder that the test makes, or why it must be there.
  const fixedPlaces: Record<string, string> = {}

  describe("no fixed place in /tmp or /var", () => {
    const allowed = new Set(Object.keys(fixedPlaces))
    const used = new Set<string>()
    const fresh: string[] = []
    for (const path of outsideFiles) {
      for (const f of fixedTempPlaces(readFileSync(path, "utf8"))) {
        const key = `${rel(path)} | ${f.literal}`
        if (allowed.has(key)) used.add(key)
        else fresh.push(`${rel(path)}:${f.line} "${f.literal}"`)
      }
    }
    test("no new place. Use tmpdir(), which follows the run folder", () => {
      expect(fresh).toEqual([])
    })
    test("every listed exception is still in use. Remove one that is gone", () => {
      expect([...allowed].filter((key) => !used.has(key))).toEqual([])
    })
    test("every exception has a reason", () => {
      for (const reason of Object.values(fixedPlaces)) expect(reason.length).toBeGreaterThan(20)
    })
  })
})

describe("each Playwright run makes the run folder", () => {
  const configs = files(join(repo, "apps/desktop"), (path) =>
    /playwright[\w.-]*\.config\.ts$/.test(path),
  )
  test("there is a config to check", () => {
    expect(configs.map(rel)).toContain("apps/desktop/playwright.config.ts")
  })
  for (const config of configs) {
    test(`${rel(config)} has the global setup and teardown of the run folder`, () => {
      const text = withoutComments(readFileSync(config, "utf8"))
      expect(text).toMatch(/globalSetup:\s*"[^"]*global-setup\.ts"/)
      expect(text).toMatch(/globalTeardown:\s*"[^"]*global-teardown\.ts"/)
    })
  }
})

describe("the app", () => {
  // The app makes its temporary folders through `makeOwnedFolder`, which names them so that a
  // start after a kill can remove them. Code that reads or makes the temporary folder by itself
  // brings the leak back: a fixed folder never goes, and a mkdtemp folder goes only when the code
  // that removes it runs.
  const exceptions: Record<string, string> = {
    "apps/desktop/src/main/stale-temp.ts": "It is the one place that makes the folders of the app.",
    "apps/desktop/src/main/test-preload.ts":
      "It gives each process of the unit tests a temporary folder of its own and removes it.",
    "apps/desktop/src/main/staging.ts":
      "A pasted file waits there until the user sends it, also across a restart. The code removes each staged file that is older than a day.",
    "apps/desktop/src/main/services/testing.ts":
      "Support code of the unit tests. Its folders stand in the folder of the test process, which the preload removes.",
  }
  const sources = files(
    join(repo, "apps/desktop/src"),
    (path) => isSource(path) && !/\.test\.tsx?$/.test(path),
  )

  test("no code reads or makes the temporary folder, except the exceptions. Use makeOwnedFolder", () => {
    const fresh = sources.flatMap((path) =>
      rel(path) in exceptions
        ? []
        : tmpdirUses(readFileSync(path, "utf8")).map((line) => `${rel(path)}:${line}`),
    )
    expect(fresh).toEqual([])
  })
  test("every listed exception is still in use. Remove one that is gone", () => {
    const gone = Object.keys(exceptions).filter(
      (file) => tmpdirUses(readFileSync(join(repo, file), "utf8")).length === 0,
    )
    expect(gone).toEqual([])
  })
})
