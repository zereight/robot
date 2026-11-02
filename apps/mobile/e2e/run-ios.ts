import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { join, resolve } from "node:path"

// The end-to-end run of the phone app on the iOS Simulator (spec 011, Acceptance). It is not part
// of CI. It needs Xcode with a simulator, Expo Go (the Expo CLI installs it), and Maestro, which
// lives outside the repository: set MAESTRO to its program, or have `maestro` on the PATH.
//
//   bun apps/mobile/e2e/run-ios.ts [flow names…]
//
// It starts the desktop with its own data folder on 127.0.0.1 (apps/desktop/e2e/phone), starts
// Metro, opens the app in Expo Go, and runs the flows in e2e/flows. Screenshots go to build/e2e.

const mobile = resolve(import.meta.dirname, "..")
const desktop = resolve(mobile, "../desktop")
const out = resolve(mobile, "../../build/e2e/phone")
const maestro = process.env.MAESTRO ?? "maestro"
const metroPort = Number(process.env.METRO_PORT ?? 8081)
const flows = process.argv.slice(2)
const children: ChildProcess[] = []

const waitFor = async (check: () => boolean | Promise<boolean>, ms: number, what: string) => {
  const end = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`)
    await Bun.sleep(500)
  }
}

const metroUp = () =>
  fetch(`http://127.0.0.1:${metroPort}/status`).then(
    (r) => r.ok,
    () => false,
  )

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
let failed = false
try {
  spawnSync("bunx", ["electron-vite", "build"], { cwd: desktop, stdio: "inherit" })
  const host = spawn("bunx", ["playwright", "test", "-c", "e2e/phone/playwright.phone.config.ts"], {
    cwd: desktop,
    stdio: "inherit",
    detached: true,
    env: { ...process.env, PHONE_E2E_DIR: out },
  })
  children.push(host)
  const hostDone = new Promise<number>((r) => host.on("exit", (code) => r(code ?? 1)))
  await waitFor(() => existsSync(join(out, "host.json")), 180_000, "the desktop pairing code")
  const { address, code } = JSON.parse(readFileSync(join(out, "host.json"), "utf8"))

  if (!(await metroUp())) {
    const metro = spawn("bunx", ["expo", "start", "--port", String(metroPort)], {
      cwd: mobile,
      stdio: ["ignore", "inherit", "inherit"],
      detached: true,
      env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
    })
    children.push(metro)
    await waitFor(metroUp, 120_000, "Metro")
  }
  // The flags stop the first-time menu and the tools button of Expo Go (the Expo CLI sets them too).
  const url = `exp://127.0.0.1:${metroPort}?__expo_disable_onboarding=1&__expo_disable_fab=1`
  const names = flows.length > 0 ? flows : ["01-pair", "02-conversation", "03-approval"]
  const steps: Record<string, boolean> = {}
  for (const name of names) {
    const flow = join(mobile, "e2e/flows", `${name}.yaml`)
    if (!existsSync(flow)) continue
    const run = spawnSync(
      maestro,
      [
        "test",
        "--test-output-dir",
        out,
        "--flatten-debug-output",
        "--debug-output",
        join(out, "maestro", name),
        "-e",
        `URL=${url}`,
        "-e",
        `ADDRESS=${address}`,
        "-e",
        `CODE=${code}`,
        flow,
      ],
      { stdio: "inherit", env: { ...process.env, MAESTRO_CLI_NO_ANALYTICS: "1" } },
    )
    steps[name] = run.status === 0
    // Maestro keeps the screenshots of a flow in its own folder; a copy goes next to the others.
    const shots = join(out, "maestro", name, name, "takeScreenshot")
    if (existsSync(shots)) {
      for (const file of readdirSync(shots)) copyFileSync(join(shots, file), join(out, file))
    }
    console.log(`${name}: ${run.status === 0 ? "passed" : "FAILED"}`)
    if (run.status !== 0) {
      failed = true
      break
    }
  }
  writeFileSync(join(out, "done"), JSON.stringify({ chat: steps["02-conversation"] === true }))
  // After a failed flow the desktop may still wait for the phone; it is stopped below.
  if (!failed && (await hostDone) !== 0) failed = true
  writeFileSync(join(out, "result.json"), JSON.stringify({ steps, failed }, null, 2))
} finally {
  // Each child leads its own process group, so Electron and Metro stop with their wrappers.
  for (const child of children) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM")
    } catch {}
  }
}
process.exit(failed ? 1 : 0)
