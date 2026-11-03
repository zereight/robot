// The replay command of docs/judge-validation.md.
//   bun run judge-replay -- run --items <file.jsonl> --out <folder> [--runs 3] [--sets dev] ...
//   bun run judge-replay -- counts --items <file.jsonl>
// "run" sends the items to a model, reads the verdicts and writes <folder>/<label>.json and
// <folder>/<label>.md. "counts" shows the counts and the split and calls no model. The fields of
// the items are at the top of judge-replay-lib.ts. The service comes from JUDGE_BASE_URL,
// JUDGE_MODEL and JUDGE_API_KEY. The script reads no data of the app and no keychain. It writes
// nothing unless --out is given, and a report never holds the text of an item.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import {
  countItems,
  parseItems,
  readCli,
  reportMarkdown,
  runReplay,
  splitItems,
} from "./judge-replay-lib.ts"

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

let cli: ReturnType<typeof readCli>
try {
  cli = readCli(process.argv.slice(2), process.env)
} catch (error) {
  fail(error instanceof Error ? error.message : "Not a usable command.")
  process.exit(1)
}

const source = ((): string => {
  try {
    return readFileSync(resolve(cli.items), "utf8")
  } catch {
    return fail("The file of the items cannot be read.")
  }
})()
const parsed = parseItems(source)
if (parsed.problems.length > 0) {
  for (const problem of parsed.problems.slice(0, 20)) console.error(problem)
  if (parsed.problems.length > 20) console.error(`... and ${parsed.problems.length - 20} more.`)
  fail("The file of the items has faults.")
}
if (parsed.items.length === 0) fail("The file has no items.")

if (cli.command === "counts") {
  const sets = splitItems(parsed.items, cli.options.seed)
  const counts = countItems(parsed.items, sets)
  console.log(JSON.stringify(counts, null, 2))
  process.exit(0)
}

const endpoint = cli.endpoint ?? fail("No service is set.")
const out = cli.out ?? fail("Give the folder for the reports: --out <folder>.")
const real = parsed.items.filter((item) => item.tag === "real" && item.human !== "skip").length
let host = "the service"
try {
  host = new URL(endpoint.baseUrl).host
} catch {
  // The base URL is not a URL: the service call will fail by itself.
}
console.error(
  `Sending the text of ${parsed.items.length} items (${real} real) to ${host}, model ${endpoint.model}. Sets: ${cli.options.sets.join(", ")}.`,
)
const report = await runReplay(parsed.items, endpoint, {
  ...cli.options,
  progress: (version, done, total) => {
    if (done === total) console.error(`${version.toUpperCase()}: ${total} calls done.`)
  },
})
const folder = resolve(out)
mkdirSync(folder, { recursive: true })
writeFileSync(join(folder, `${cli.label}.json`), `${JSON.stringify(report, null, 2)}\n`)
writeFileSync(join(folder, `${cli.label}.md`), reportMarkdown(report))
console.log(`Reports: ${join(folder, `${cli.label}.json`)} and ${join(folder, `${cli.label}.md`)}`)
