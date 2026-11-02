// The performance command of docs/performance.md.
//   bun run perf -- run --label before [--samples 5] [--app <path of the packaged app>]
//   bun run perf -- compare before after
// "run" measures a packaged build ("bun run dist" or "electron-builder --dir" first) and writes
// build/perf/<label>.json and build/perf/<label>.md. "compare" reads two reports, by label or by
// path, and shows each measure, the two values and the change in percent.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { compareMarkdown, isReport, type PerfReport, safeLabel } from "./perf-lib.ts"

const appDir = resolve(import.meta.dirname, "..")
const outDir = resolve(appDir, "../../build/perf")
const [command, ...args] = process.argv.slice(2)

const option = (name: string) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : undefined
}

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

const readReport = (labelOrPath: string): PerfReport => {
  const path = existsSync(labelOrPath)
    ? labelOrPath
    : resolve(outDir, `${safeLabel(labelOrPath)}.json`)
  if (!existsSync(path)) return fail(`No report at ${path}.`)
  const data: unknown = JSON.parse(readFileSync(path, "utf8"))
  return isReport(data) ? data : fail(`${path} is not a performance report.`)
}

if (command === "run") {
  const label = safeLabel(option("label") ?? fail("Give a label: --label <label>."))
  let app = option("app")
  if (!app) {
    const found = spawnSync("bun", [resolve(appDir, "scripts/packaged-path.ts")], {
      encoding: "utf8",
    })
    if (found.status !== 0) fail(found.stderr.trim())
    app = found.stdout.trim()
  }
  const result = spawnSync(
    "bunx",
    ["playwright", "test", "-c", resolve(appDir, "perf/playwright.config.ts")],
    {
      cwd: appDir,
      stdio: "inherit",
      env: {
        ...process.env,
        ROBOT_E2E_APP: app,
        ROBOT_PERF_LABEL: label,
        ROBOT_PERF_SAMPLES: option("samples") ?? "5",
        ROBOT_PERF_OUT: outDir,
      },
    },
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
  console.log(
    `\nReports: ${resolve(outDir, `${label}.json`)} and ${resolve(outDir, `${label}.md`)}`,
  )
} else if (command === "compare") {
  const [a, b] = args
  if (!a || !b) fail("Give two reports: compare <before> <after>.")
  console.log(compareMarkdown(readReport(a as string), readReport(b as string)))
} else {
  fail("Commands: run --label <label> [--samples <n>] [--app <path>], compare <before> <after>.")
}
