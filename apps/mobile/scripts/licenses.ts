import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { licensesFromSources } from "./licenses-lib.ts"

// Writes licenses.json: every package whose code ships in the bundle of the phone app. It builds
// the bundle for iPhone and Android with source maps in a temporary folder and reads the maps.

const appDir = resolve(import.meta.dirname, "..")
const repoRoot = resolve(appDir, "../..")
const out = mkdtempSync(join(tmpdir(), "robot-mobile-licences-"))
try {
  const sources = new Set<string>()
  for (const platform of ["ios", "android"]) {
    const dir = join(out, platform)
    const run = spawnSync(
      "bunx",
      ["expo", "export", "--platform", platform, "--source-maps", "--output-dir", dir],
      { cwd: appDir, stdio: "inherit", env: { ...process.env, EXPO_NO_TELEMETRY: "1" } },
    )
    if (run.status !== 0) throw new Error(`expo export --platform ${platform} failed`)
    const maps = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) =>
      f.endsWith(".map"),
    )
    for (const map of maps) {
      for (const s of JSON.parse(readFileSync(join(dir, map), "utf8")).sources) sources.add(s)
    }
  }
  const file = join(appDir, "licenses.json")
  writeFileSync(file, `${JSON.stringify(licensesFromSources(repoRoot, [...sources]), null, 2)}\n`)
  console.log(`wrote ${file}`)
} finally {
  rmSync(out, { recursive: true, force: true })
}
