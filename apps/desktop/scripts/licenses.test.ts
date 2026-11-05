import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import shipped from "../src/main/licenses.json"
import { collectLicenses } from "./licenses-lib.ts"

const allowed =
  /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|MIT OR Apache-2\.0|\(MIT OR Apache-2\.0\))$/

test("the shipped license list is up to date (run `bun run licenses`)", () => {
  expect(shipped).toEqual(collectLicenses(resolve(import.meta.dirname, "..")))
})

test("every shipped dependency has an MIT-compatible license", () => {
  for (const entry of shipped) expect(entry.license).toMatch(allowed)
})

test("every package the app imports ships: it is a dependency or listed as bundled", () => {
  const root = resolve(import.meta.dirname, "..")
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
  const shipping = new Set([...Object.keys(pkg.dependencies), ...pkg.bundled, "electron"])
  const imported = new Set<string>()
  for (const file of new Bun.Glob("src/**/*.{ts,tsx}").scanSync(root)) {
    // The files of the tests are not in the app. The runner of the tests loads `test-preload.ts`
    // from `bunfig.toml`, and no file of the app imports it.
    if (file.includes(".test.") || file === "src/main/test-preload.ts") continue
    const source = readFileSync(join(root, file), "utf8")
    // "from" and "import" must start a word. A test id such as "card-from" and a key such as
    // "card.from" end in "from" and are not imports. A value such as `"import"` is a string, not
    // an import, so a quote before the word does not count either.
    for (const [, spec] of source.matchAll(/(?<![\w."-])(?:from|import)\s*\(?\s*"([^".][^"]*)"/g)) {
      if (!spec || spec.startsWith("node:")) continue
      const parts = spec.split("/")
      imported.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec))
    }
  }
  expect([...imported].filter((name) => !shipping.has(name))).toEqual([])
})
