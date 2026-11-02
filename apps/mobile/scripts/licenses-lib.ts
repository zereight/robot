import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

export interface License {
  name: string
  version: string
  license: string
}

/** The licences that a package of the phone app may have (as on the desktop). */
export const ALLOWED =
  /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|MIT OR Apache-2\.0|\(MIT OR Apache-2\.0\))$/

const licenseOf = (manifest: { license?: string | { type: string } }) =>
  typeof manifest.license === "string" ? manifest.license : (manifest.license?.type ?? "UNKNOWN")

/**
 * The packages whose code is in the bundle of the app, from the `sources` of its source map.
 * Paths in the map are relative to the root of the repository. Workspace packages are not listed.
 */
export const licensesFromSources = (repoRoot: string, sources: readonly string[]): License[] => {
  const seen = new Map<string, License>()
  for (const source of sources) {
    const at = source.lastIndexOf("node_modules/")
    if (at < 0) continue
    const rest = source.slice(at + "node_modules/".length).split("/")
    const name = rest[0]?.startsWith("@") ? rest.slice(0, 2).join("/") : (rest[0] ?? "")
    const dir = join(repoRoot, source.slice(0, at), "node_modules", name)
    const file = join(dir, "package.json")
    if (!name || !existsSync(file)) continue
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    const key = `${manifest.name}@${manifest.version}`
    if (!seen.has(key)) {
      seen.set(key, {
        name: manifest.name,
        version: manifest.version,
        license: licenseOf(manifest),
      })
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The licence of an installed package, as Node would find it from `from`. */
export const installedLicense = (from: string, name: string): string | null => {
  let dir = from
  for (;;) {
    const file = join(dir, "node_modules", name, "package.json")
    if (existsSync(file)) return licenseOf(JSON.parse(readFileSync(file, "utf8")))
    const parent = join(dir, "..")
    if (parent === dir) return null
    dir = parent
  }
}
