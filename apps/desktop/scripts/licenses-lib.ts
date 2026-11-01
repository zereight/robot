import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

export interface License {
  name: string
  version: string
  license: string
}

interface Manifest {
  name: string
  version: string
  license?: string | { type: string }
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  os?: string[]
  cpu?: string[]
}

const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))

/** Finds the folder of `name` as Node would, starting at `from`. */
const locate = (name: string, from: string): string | undefined => {
  let dir = from
  for (;;) {
    const candidate = join(dir, "node_modules", name)
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate)
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Lists every package that ships with the app: the runtime dependencies of `appDir`,
 * their dependencies, and the Electron runtime. Workspace packages are walked but not listed.
 */
export const collectLicenses = (appDir: string): License[] => {
  const seen = new Map<string, License>()
  const visit = (dir: string, listed: boolean, walk = true) => {
    const manifest = readManifest(dir)
    // Native builds for one platform carry the license of their parent package, which is listed.
    // Leaving them out keeps the list the same on every platform.
    if (manifest.os || manifest.cpu) return
    const key = `${manifest.name}@${manifest.version}`
    if (seen.has(key)) return
    const license =
      typeof manifest.license === "string"
        ? manifest.license
        : (manifest.license?.type ?? "UNKNOWN")
    if (listed) seen.set(key, { name: manifest.name, version: manifest.version, license })
    if (!walk) return
    const deps = { ...manifest.dependencies, ...manifest.optionalDependencies }
    for (const [name, range] of Object.entries(deps)) {
      const found = locate(name, dir)
      if (found) visit(found, !range.startsWith("workspace:"))
    }
  }
  const root = resolve(appDir)
  visit(root, false)
  const electron = locate("electron", root)
  // The npm package of Electron only downloads the runtime; its own dependencies do not ship.
  if (electron) visit(electron, true, false)
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}
