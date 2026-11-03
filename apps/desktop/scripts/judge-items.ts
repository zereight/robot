// The export command of docs/judge-validation.md ("Data").
//   bun run judge-items -- --db <copy of the database> --out <file.jsonl> [--since <date>] [--limit N]
//                          [--gap-seconds <n>]
// It reads a COPY of the database of the app, read-only, and writes the finished parts of channel
// jobs that have a done test as the items that judge-replay.ts reads. The fields of an item are at
// the top of judge-items-lib.ts. The items have no verdict, no decision and no "human": a person
// adds "human" to each one. The command prints counts only, never the text of an item. It writes
// only the file of --out, and only to a place outside this repository.
import {
  checkOutPath,
  exportItems,
  ItemsError,
  itemsToJsonl,
  readCli,
  summaryText,
  USAGE,
  writeItems,
} from "./judge-items-lib.ts"

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

try {
  const cli = readCli(process.argv.slice(2))
  if (cli.help) {
    console.log(USAGE)
    process.exit(0)
  }
  // The paths are checked first: a refused path leaves nothing behind.
  checkOutPath(cli.out, cli.db, cli.force)
  const { items, summary } = exportItems(cli.db, {
    since: cli.since,
    limit: cli.limit,
    gapSeconds: cli.gapSeconds,
  })
  console.log(summaryText(summary))
  if (items.length === 0) fail("No part qualifies. Nothing was written.")
  writeItems(cli.out, itemsToJsonl(items), cli.force)
  console.log(
    'The items have no "human" yet. A person adds it to each item: pass, fail or skip. Keep the file outside the repository.',
  )
} catch (error) {
  if (error instanceof ItemsError) fail(error.message)
  // A fault that nobody expected. Only its kind is shown: its text could hold a value.
  fail(`The export failed (${error instanceof Error ? error.name : "unknown fault"}).`)
}
