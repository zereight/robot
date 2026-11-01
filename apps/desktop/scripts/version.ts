// Sets the app version: `bun run version 0.2.0`. The release tag must be `v` plus this version.
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

const next = process.argv[2] ?? ""
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error(
    "Usage: bun run version <major.minor.patch[-pre]>, for example 0.2.0 or 0.2.0-beta.1",
  )
  process.exit(1)
}
const file = resolve(import.meta.dirname, "../package.json")
const pkg = JSON.parse(readFileSync(file, "utf8"))
const previous = pkg.version
pkg.version = next
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
console.log(
  `${previous} -> ${next}. After the merge, tag it: git tag v${next} && git push origin v${next}`,
)
