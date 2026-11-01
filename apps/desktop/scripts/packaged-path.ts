// Prints the path of the packaged app executable for this platform and architecture.
import { existsSync } from "node:fs"
import { resolve } from "node:path"

const dist = resolve(import.meta.dirname, "../../../dist/desktop")
const arch = process.argv[2] ?? process.arch
const candidates: Record<string, string> = {
  darwin: `${arch === "arm64" ? "mac-arm64" : "mac"}/ROBot.app/Contents/MacOS/ROBot`,
  win32: "win-unpacked/ROBot.exe",
  linux: "linux-unpacked/robot",
}
const path = resolve(dist, candidates[process.platform] ?? "")
if (!existsSync(path)) {
  console.error(`No packaged app at ${path}. Run "bun run dist" first.`)
  process.exit(1)
}
console.log(path)
