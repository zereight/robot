import { createInterface } from "node:readline/promises"
import { openProfile } from "./browser.ts"
import { type Config, loadConfig } from "./config.ts"
import { keyOf, Outbox, RateLimiter, SeenKeys } from "./core.ts"
import { describePage } from "./inspect.ts"
import { processNew } from "./loop.ts"
import { GUESSED } from "./selectors.ts"
import { TeamsPage } from "./teams.ts"

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitForEnter(prompt: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  await rl.question(prompt)
  rl.close()
}

/** Step 1. Sign in by hand. The session stays in the profile folder. */
async function login(cfg: Config): Promise<void> {
  const { context, page } = await openProfile(cfg)
  await page.goto(cfg.teamsUrl)
  console.log("Sign in to Teams in the window (SSO and MFA as usual).")
  await waitForEnter("When the chat list shows, press Enter here to close the window. ")
  await context.close()
  console.log(`Session kept in ${cfg.profileDir}`)
}

/**
 * Step 2. Print the shape of the page so selectors.ts can be fixed.
 * It prints attribute values and counts only. It prints no message text.
 */
async function inspect(cfg: Config): Promise<void> {
  const { context, page } = await openProfile(cfg)
  await page.goto(cfg.teamsUrl)
  await waitForEnter("Open the chat you want to use, then press Enter here. ")
  const report = await describePage(page)
  console.log(JSON.stringify(report, null, 2))
  await context.close()
}

/** Step 3 and 4. Poll the open chat. `echo` also answers; `watch` only reads. */
async function run(cfg: Config, mode: "watch" | "echo"): Promise<void> {
  if (mode === "echo" && cfg.expectTitle === "") {
    throw new Error(
      'echo needs EXPECT_TITLE, for example EXPECT_TITLE="(You)". It sends only to a chat with that title.',
    )
  }
  if (mode === "echo" && cfg.allow.length === 0) {
    throw new Error(
      'echo needs ALLOW, for example ALLOW="Your Name". It answers only the senders on that list.',
    )
  }
  const { context, page } = await openProfile(cfg)
  let closed = false
  context.on("close", () => (closed = true))
  await page.goto(cfg.teamsUrl)
  await waitForEnter("Open the chat you want to use, then press Enter here to start. ")

  const teams = new TeamsPage(page, GUESSED)
  const seen = new SeenKeys()
  const baseline = await teams.readMessages()
  for (const m of baseline) seen.add(keyOf(m))
  console.log(`Chat: ${(await teams.chatTitle()) ?? "(title not found)"}`)
  console.log(
    `Ignoring ${baseline.length} message(s) that are already there. Mode: ${mode}. Ctrl+C to stop.`,
  )
  if (baseline.length === 0) {
    console.warn(
      "No message found. If the chat is not empty, the selectors in src/selectors.ts are wrong. Run: bun run inspect",
    )
  }

  if (mode === "echo") {
    console.log(
      `Answers: ${cfg.allow.join(", ")}. ${cfg.call === "" ? "Every message calls the bridge (direct chat)." : `A message must contain "${cfg.call}".`}`,
    )
  }
  const limiter = new RateLimiter(20, 60_000)
  const outbox = new Outbox()
  while (!closed && !page.isClosed()) {
    await sleep(cfg.pollMs)
    try {
      await processNew({
        teams,
        seen,
        limiter,
        outbox,
        admission: { allow: cfg.allow, bots: cfg.bots, call: cfg.call },
        mode,
        marker: cfg.marker,
        chunkMax: cfg.chunkMax,
        expectTitle: cfg.expectTitle,
        log: (line) => console.log(line),
      })
    } catch (err) {
      if (closed || page.isClosed()) break
      console.warn(`read failed: ${(err as Error).message}`)
    }
  }
  await context.close().catch(() => {})
}

async function main(): Promise<void> {
  const cmd = process.argv[2]
  const cfg = loadConfig()
  switch (cmd) {
    case "login":
      return login(cfg)
    case "inspect":
      return inspect(cfg)
    case "watch":
      return run(cfg, "watch")
    case "echo":
      return run(cfg, "echo")
    default:
      console.log("Usage: bun run <login|inspect|watch|echo>")
      process.exitCode = cmd === undefined ? 0 : 1
  }
}

main().catch((err: unknown) => {
  console.error((err as Error).message)
  process.exitCode = 1
})
