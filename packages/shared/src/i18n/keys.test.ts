import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { en } from "./en.ts"

// A key that no screen reads is dead weight: it is translated, reviewed and kept in step with the
// other language, and it shows nothing. `firstRun.agent.title` sat in both catalogues while the
// third step of the guide showed only its body, so that step read differently from the two before it.
//
// This check finds the keys that no source file can reach. It reads the literal keys and the
// templates, because a screen writes `t(\`agents.permission.line.${program}.${level}\`)` and the
// catalogue holds one key for each pair. A template becomes a pattern with one segment per hole.

const root = join(import.meta.dir, "../../../..")
// `packages/shared/src` builds a key too: starterText.ts reads `starter.${id}.${part}` for the
// window, so a scan without it would report the whole starter family as dead.
const SOURCE_ROOTS = [
  "apps/desktop/src",
  "apps/mobile/src",
  "packages/phone/src",
  "packages/shared/src",
] as const
const SOURCE_FILES = /\.(?:ts|tsx)$/
// The catalogue itself names every key, so a scan that includes it finds every key "used".
const CATALOGUE = /(?:^|\/)i18n\/(?:en|ko)\.ts$/

// Keys that no screen reads today. Each one is a choice, not an oversight to hide: the check fails
// when a new key joins this situation, and fails again when a key on the list starts being read,
// so the list can only shrink. Deleting the text is a separate decision, because a key that a
// screen will read next week is not dead yet.
const KNOWN_UNUSED: readonly string[] = [
  "agents.field.main.off",
  "backup.header",
  "chat.stepReason",
  "connections.review.failed",
  "devices.thisDevice",
  "firstRun.skip",
  "handover.card.open",
  "handover.line.open",
  "handover.line.thread",
  "link.noCache",
  "memory.check.now.off",
  "memory.check.started",
  "memory.history.undone",
  "memory.move.failed",
  "orgs.syncs",
  "providers.title",
  "settings.data.folder.hint",
  "settings.notify.server",
  "taskUsage.noReport",
  "teams.mark.from",
  "teams.state",
  "today.row.open",
  "usage.total",
  "workflows.enabled",
  "workflows.note.label",
  // `places.search.clear`, `connect.close`, `model.none` and `settings.workspaceRoot.hint` were on
  // this list before the check was written; they stay here while the text is still in both
  // catalogues.
  "connect.close",
  "model.none",
  "places.search.clear",
  "settings.workspaceRoot.hint",
]

function sources(dir: string): string[] {
  if (!existsSync(dir)) return []
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sources(path))
    // A test builds keys to check a service; it never shows one. The catalogue names every key, so
    // including it would make every key look used. Neither counts as a reader.
    else if (
      SOURCE_FILES.test(entry.name) &&
      !/\.test\.(?:ts|tsx)$/.test(entry.name) &&
      !CATALOGUE.test(path)
    )
      found.push(path)
  }
  return found
}

/** Every file that can read a key, joined into one text. */
function applicationSource(): string {
  return SOURCE_ROOTS.flatMap((dir) => sources(join(root, dir)))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n")
}

/** The keys that appear as an exact string literal, which is how a screen names a key it knows. */
function literalKeys(source: string): Set<string> {
  return new Set(source.match(/"([a-zA-Z][a-zA-Z0-9._]*)"/g)?.map((s) => s.slice(1, -1)) ?? [])
}

const forRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * The keys that the source builds at run time. Only a template whose text looks like a key counts:
 * a dotted lower-case path with at least one dot. Every other template literal is a file path, a
 * URL or a message for the user, and treating one of those as a key reports a hole that the
 * catalogue never had.
 */
function keyPatterns(source: string): RegExp[] {
  const patterns: RegExp[] = []
  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    const template = match[1] as string
    if (!template.includes("${")) continue
    // A key starts with a lower-case word and holds a dot before the first hole.
    if (!/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_$]+)*\.\$\{|\.[a-z][a-zA-Z0-9]*\.\$\{/.test(template))
      continue
    const body = template.replace(/\$\{[^}]*\}/g, "\u0000")
    // A path that starts with a slash, a dot-slash or a scheme is a file, not a key. A template
    // with an `=` in it builds an assignment, such as `X_TOKEN=${value}`.
    if (/^(?:\/|\.\/|[a-z]+:\/\/)/.test(body) || body.includes("=")) continue
    const parts = body.split("\u0000").map(forRegExp)
    patterns.push(new RegExp(`^${parts.join("[^.]+")}$`))
  }
  return patterns
}

describe("translation keys", () => {
  const source = applicationSource()
  const keys = Object.keys(en)
  const literals = literalKeys(source)
  const patterns = keyPatterns(source)

  // A key that `starterText` or `workflowStarterText` builds is read through two holes, so a
  // pattern cannot reach it. These families are read by construction and are not checked here.
  const TWO_HOLE_FAMILIES = ["starter.", "workflowStarter."]
  const inTwoHoleFamily = (key: string) =>
    TWO_HOLE_FAMILIES.some((family) => key.startsWith(family))

  const reaches = (key: string) =>
    literals.has(key) || patterns.some((pattern) => pattern.test(key))

  test("every key reaches a screen, or is on the list of known unused keys", () => {
    const missing = keys.filter(
      (key) => !reaches(key) && !inTwoHoleFamily(key) && !KNOWN_UNUSED.includes(key),
    )
    expect(missing).toEqual([])
  })

  // The list is a record of a choice, not a place to hide a key: it may hold only a key that no
  // screen reads. A key that a screen reads must leave the list, so the list can only shrink.
  test("a key on the list of known unused keys is not read by a screen", () => {
    const found = KNOWN_UNUSED.filter(reaches)
    expect(found).toEqual([])
  })

  // A template with a hole can be wrong in a way no screen shows until that value arrives. The
  // check is narrow on purpose: a pattern counts only when its prefix is a real key path.
  //
  // Some keys are reached through two holes: starterText.ts builds `starter.${id}.${part}` and
  // passes `part` = "routine.name", so a key with a dot in the value cannot be matched by a
  // pattern that gives each hole one segment. workflowStarterText.ts does the same.
  test("a template that builds a key reaches at least one of them", () => {
    const unreachable = patterns
      .filter((pattern) => {
        const [head] = pattern.source.replace(/^\^/, "").split("[^.]")
        if (head === undefined) return false
        if (TWO_HOLE_FAMILIES.some((family) => head.startsWith(family))) return false
        return keys.some((key) => key.startsWith(head))
      })
      .filter((pattern) => !keys.some((key) => pattern.test(key)))
      .map((pattern) => pattern.source)
    expect(unreachable).toEqual([])
  })
})
