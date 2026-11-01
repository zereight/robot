import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { collectLicenses } from "./licenses-lib.ts"

const appDir = resolve(import.meta.dirname, "..")
const out = resolve(appDir, "src/main/licenses.json")
writeFileSync(out, `${JSON.stringify(collectLicenses(appDir), null, 2)}\n`)
console.log(`wrote ${out}`)
