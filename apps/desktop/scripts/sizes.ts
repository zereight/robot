// Checks the sizes of the built files against the baseline in the repository (docs/performance.md).
//   bun scripts/sizes.ts            check; fails when a size grows by more than 10 percent
//   bun scripts/sizes.ts --update   write the sizes of this build as the new baseline
// Run "bun run build" first. A pull request that grows a size on purpose updates the baseline
// and says why.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { checkSizes, MAX_GROWTH, measureSizes, sizesTable } from "./perf-lib.ts"

const outDir = resolve(import.meta.dirname, "../out")
const baselineFile = resolve(import.meta.dirname, "../perf/size-baseline.json")

if (!existsSync(outDir)) {
  console.error(`No build at ${outDir}. Run "bun run build" first.`)
  process.exit(1)
}
const current = measureSizes(outDir)

if (process.argv.includes("--update")) {
  writeFileSync(baselineFile, `${JSON.stringify(current, null, 2)}\n`)
  console.log(`Wrote ${baselineFile}`)
  console.log(sizesTable(checkSizes(current, current).rows))
  process.exit(0)
}

const baseline = JSON.parse(readFileSync(baselineFile, "utf8")) as Record<string, number>
const result = checkSizes(current, baseline)
console.log(sizesTable(result.rows))
if (!result.ok) {
  const message = `A built file group grew by more than ${MAX_GROWTH * 100} percent, or has no baseline. If the growth is on purpose, run "bun run sizes -- --update" and say why in the pull request.`
  console.error(process.env.GITHUB_ACTIONS ? `::error::${message}` : message)
  process.exit(1)
}
