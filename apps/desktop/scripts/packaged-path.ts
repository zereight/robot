// Prints the path of the packaged app executable (macOS, Apple silicon).
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const path = resolve(
  import.meta.dirname,
  "../../../dist/desktop/mac-arm64/ROBot.app/Contents/MacOS/ROBot",
)
if (!existsSync(path)) {
  console.error(`No packaged app at ${path}. Run "bun run dist" first.`)
  process.exit(1)
}
console.log(path)
