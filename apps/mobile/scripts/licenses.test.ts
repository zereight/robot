import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import shipped from "../licenses.json"
import { ALLOWED, installedLicense } from "./licenses-lib.ts"

const root = resolve(import.meta.dirname, "..")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
}

test("every package in the bundle of the app has an MIT-compatible licence", () => {
  expect(shipped.length).toBeGreaterThan(10)
  for (const entry of shipped)
    expect({ ...entry, ok: ALLOWED.test(entry.license) }).toMatchObject({ ok: true })
})

test("every direct dependency of the app has an MIT-compatible licence", () => {
  for (const name of [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]) {
    if (pkg.dependencies[name]?.startsWith("workspace:")) continue
    const license = installedLicense(root, name)
    expect({ name, ok: license !== null && ALLOWED.test(license) }).toEqual({ name, ok: true })
  }
})

test("every package the app imports is a dependency (run `bun run licenses` after a change)", () => {
  const deps = new Set(Object.keys(pkg.dependencies))
  const imported = new Set<string>()
  for (const file of new Bun.Glob("{app,src}/**/*.{ts,tsx}").scanSync(root)) {
    if (file.includes(".test.")) continue
    const source = readFileSync(join(root, file), "utf8")
    // Lines that start an import, end a multi-line import, or re-export; and import("…") calls.
    const statements =
      /^\s*(?:import\b[^"\n]*|export\b[^"\n]*\bfrom\s*|\}\s*from\s*)"([^".][^"]*)"/gm
    const calls = /\bimport\(\s*"([^".][^"]*)"\s*\)/g
    for (const [, spec] of [...source.matchAll(statements), ...source.matchAll(calls)]) {
      if (!spec || spec.startsWith("node:")) continue
      const parts = spec.split("/")
      imported.add(spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? spec))
    }
  }
  expect([...imported].filter((name) => !deps.has(name))).toEqual([])
})
