import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { makeFakeRuntimes } from "./fake-runtimes.ts"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Runtime states with "Check again" and "Repair" (spec 006), and the permission level "Read only"
// with the confirm for "Full access" (spec 007). The stand-in programs are shell scripts, so these
// tests run where a shell does.
test.skip(process.platform === "win32", "the stand-in programs need a shell")

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })

const openProviders = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
}

/** Connects the account of a stand-in program in settings and closes settings. */
const addRuntime = async (page: Page, kind: "claude_code" | "codex", name: string) => {
  await openProviders(page)
  await page.getByTestId("provider-add").click()
  await page.getByTestId("provider-kind").selectOption(kind)
  await page.getByTestId("provider-name").fill(name)
  await expect(page.getByTestId("runtime-state")).toHaveText("Ready")
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status").last()).toHaveText("Connected")
  await page.getByTestId("settings-close").click()
}

/** The calls that a program got after the first `from` calls. */
const newAsks = (asks: () => string[][], from: number) => asks().slice(from)

test("runtime states: Ready, a removed program needs repair, Repair brings it back, Not installed", async () => {
  test.setTimeout(180_000)
  const fake = makeFakeRuntimes()
  fake.setCodex({ loggedIn: true, method: "chatgpt" })
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_CODEX_BIN: fake.codex,
    // A program that was never found.
    ROBOT_CLAUDE_BIN: "none",
    // A check that gets no answer ends after 3 seconds here. The app never lets it pass 15.
    ROBOT_CHECK_MS: "3000",
  })
  await resizeWindow(app, 1300, 900)

  // A program that was never found is Not installed, and the form shows the download as before.
  await openProviders(page)
  await page.getByTestId("provider-add").click()
  await expect(page.getByTestId("provider-kind")).toHaveValue("claude_code")
  await expect(page.getByTestId("runtime-state")).toHaveText("Not installed")
  await expect(page.getByTestId("runtime-install")).toBeVisible()
  await shot(page, "runtime-readiness-01-not-installed")

  // A stand-in program that answers: Ready. The tag has text, not only a colour.
  await page.getByTestId("provider-kind").selectOption("codex")
  await expect(page.getByTestId("runtime-state")).toHaveText("Ready")
  await page.getByTestId("provider-name").fill("Codex")
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Connected")
  await expect(page.getByTestId("provider-runtime-state")).toHaveText("Ready")
  await expect(page.getByTestId("provider-runtime-checked")).toContainText("Checked at")
  await page.getByTestId("settings-close").click()

  await createAgent(page, "Ada")
  await send(page, "hello")
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("Echo: hello")

  // "Check again" asks only for the version or the sign-in state. It makes no model turn.
  await openProviders(page)
  const before = fake.asks("codex").length
  await page.getByTestId("provider-recheck").click()
  await expect.poll(() => fake.asks("codex").length).toBeGreaterThan(before)
  await expect(page.getByTestId("provider-runtime-state")).toHaveText("Ready")
  const turns = fake.codexCalls().length
  const asked = newAsks(() => fake.asks("codex"), before)
  for (const ask of asked) expect([["--version"], ["login", "status"]]).toContainEqual(ask)
  expect(fake.codexCalls().length).toBe(turns)
  await shot(page, "runtime-readiness-02-ready")

  // Remove the program. "Check again" finds a program that was there and is gone.
  const script = readFileSync(fake.codex)
  rmSync(fake.codex)
  await page.getByTestId("provider-recheck").click()
  await expect(page.getByTestId("provider-runtime-state")).toHaveText("Needs repair")
  await expect(page.getByTestId("provider-runtime-reason")).toHaveText(
    "The file of the program is gone or was moved.",
  )
  await expect(page.getByTestId("provider-repair")).toBeVisible()
  await shot(page, "runtime-readiness-03-needs-repair")

  // The message box of the agent is off, with the state in words and a "Repair" button.
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("composer-runtime")).toContainText(
    "The program of this agent needs repair.",
  )
  await expect(page.getByTestId("composer-input")).toHaveCount(0)
  await expect(page.getByTestId("composer-repair")).toBeVisible()
  await shot(page, "runtime-readiness-04-composer-off")

  // Put the program back and choose "Repair": the row is Ready, and the message box works.
  // Repair never signs in, signs out or removes a sign-in.
  writeFileSync(fake.codex, script)
  chmodSync(fake.codex, 0o755)
  await page.getByTestId("composer-repair").click()
  await expect(page.getByTestId("composer-input")).toBeVisible({ timeout: 15_000 })
  expect(fake.asks("codex").filter((ask) => ask.length === 1 && ask[0] === "login")).toEqual([])
  await send(page, "hello again")
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("Echo: hello again")

  // A stand-in program that exits at start gives Needs repair, with a reason about the start.
  fake.setCodex({ loggedIn: true, method: "chatgpt", exitAtStart: true })
  await openProviders(page)
  await page.getByTestId("provider-recheck").click()
  await expect(page.getByTestId("provider-runtime-state")).toHaveText("Needs repair")
  await expect(page.getByTestId("provider-runtime-reason")).toHaveText(
    "The program does not start.",
  )

  // An answer that the app cannot read is told apart from a program that does not start.
  fake.setCodex({ loggedIn: true, method: "chatgpt", garbage: true })
  await page.getByTestId("provider-recheck").click()
  await expect(page.getByTestId("provider-runtime-reason")).toHaveText(
    "The app cannot read the answer of the program.",
  )

  // A program that does not answer: the row shows Checking, then a state, never Checking for good.
  fake.setCodex({ loggedIn: true, method: "chatgpt", hang: 6_000 })
  await page.getByTestId("provider-recheck").click()
  await expect(page.getByTestId("provider-runtime-state")).toHaveText("Checking")
  await expect(page.getByTestId("provider-runtime-state")).toHaveText("Needs repair", {
    timeout: 10_000,
  })
  await expect(page.getByTestId("provider-runtime-reason")).toHaveText(
    "The program does not answer.",
  )

  // The program is well again. "Repair" looks again and checks. The agent works.
  fake.setCodex({ loggedIn: true, method: "chatgpt" })
  await page.getByTestId("provider-repair").click()
  await expect(page.getByTestId("provider-runtime-state")).toHaveText("Ready", { timeout: 15_000 })
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("composer-input")).toBeVisible()
  await app.close()
})

test("the level Read only: an agent that uses the tools of the app is refused, and Full access asks first", async () => {
  test.setTimeout(150_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // Set the level in the profile. A line under the level tells how the level applies here.
  await page.getByTestId("chat-header-agent").click()
  await expect(page.locator("[data-testid=agent-permission] label")).toHaveText([
    "Read only",
    "Ask for everything",
    "Ask for risky steps",
    "Full access",
  ])
  await expect(page.getByTestId("agent-permission-line")).toContainText(
    "It asks before risky steps",
  )
  // The workspace of the agent: the folder where a file read needs no question.
  const workspace =
    (await page
      .locator("[data-testid=agent-profile] [data-user-data][title]")
      .first()
      .getAttribute("title")) ?? ""
  expect(workspace).toContain("workspaces")
  await page.locator("[data-testid=agent-permission] label[data-value=read_only]").click()
  await expect(page.getByTestId("agent-permission-line")).toContainText(
    "The app decides each step. It refuses",
  )
  // No confirm for any level but Full access.
  await expect(page.getByTestId("full-access-confirm")).toHaveCount(0)
  await shot(page, "runtime-readiness-05-read-only-profile")
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()

  // A file read works.
  const note = join(workspace, "note.txt")
  writeFileSync(note, "hello from a file")
  await send(page, `TOOL read_file ${JSON.stringify({ path: note })}`)
  await settled(page)
  await expect(page.getByTestId("tool-card").last()).toContainText("Done")
  await expect(page.getByTestId("ask-card")).toHaveCount(0)

  // A file write, a shell command and a browser step each show "Refused: read only", change
  // nothing, and the turn goes on.
  const wrote = join(workspace, "written.txt")
  await send(page, `TOOL write_file ${JSON.stringify({ path: wrote, content: "x" })}`)
  await settled(page)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Refused: read only")
  expect(existsSync(wrote)).toBe(false)
  await expect(page.getByTestId("message").last()).toContainText("Tool said: Refused")

  const touched = join(workspace, "touched.txt")
  await send(page, `TOOL run_command ${JSON.stringify({ command: `touch "${touched}"` })}`)
  await settled(page)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Refused: read only")
  expect(existsSync(touched)).toBe(false)

  await send(page, `TOOL browser_open ${JSON.stringify({ url: "https://example.com" })}`)
  await settled(page)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Refused: read only")
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await shot(page, "runtime-readiness-06-refused")

  // The full access confirm. "Back" keeps the old level.
  await page.getByTestId("chat-header-agent").click()
  await page.locator("[data-testid=agent-permission] label[data-value=full]").click()
  await expect(page.getByTestId("full-access-confirm")).toBeVisible()
  await expect(page.getByTestId("full-access-confirm")).toContainText(
    "changes files and runs commands without asking",
  )
  await expect(page.getByTestId("full-access-confirm")).toContainText("Deny rules still apply")
  await shot(page, "runtime-readiness-07-full-access-confirm")
  await page.getByTestId("full-access-back").click()
  await expect(page.getByTestId("full-access-confirm")).toHaveCount(0)
  await expect(page.locator("[data-testid=agent-permission] input[value=read_only]")).toBeChecked()

  // "Use Full access" sets it.
  await page.locator("[data-testid=agent-permission] label[data-value=full]").click()
  await page.getByTestId("full-access-use").click()
  await expect(page.getByTestId("full-access-confirm")).toHaveCount(0)
  await expect(page.locator("[data-testid=agent-permission] input[value=full]")).toBeChecked()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
  await send(page, `TOOL write_file ${JSON.stringify({ path: wrote, content: "now it works" })}`)
  await settled(page)
  await expect.poll(() => existsSync(wrote)).toBe(true)
  expect(readFileSync(wrote, "utf8")).toBe("now it works")

  // "Ask for everything" asks for no confirm.
  await page.getByTestId("chat-header-agent").click()
  await page.locator("[data-testid=agent-permission] label[data-value=ask_all]").click()
  await expect(page.getByTestId("full-access-confirm")).toHaveCount(0)
  await page.getByTestId("agent-submit").click()
  await app.close()
})

test("Read only for a vendor program: off when the program has no read-only mode, set when it has", async () => {
  test.setTimeout(180_000)
  const fake = makeFakeRuntimes()
  // Claude Code has no read-only mode in this stand-in. Codex has one.
  fake.setClaude({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "tester@example.com",
    plan: "max",
    noReadOnly: true,
  })
  fake.setCodex({ loggedIn: true, method: "chatgpt" })
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_CLAUDE_BIN: fake.claude,
    ROBOT_CODEX_BIN: fake.codex,
  })
  await resizeWindow(app, 1300, 900)
  await addRuntime(page, "claude_code", "Claude")
  await addRuntime(page, "codex", "Codex")

  // An agent on the program with no read-only mode: the option is off, and the line says why.
  await page.getByTestId("new-agent").click()
  await page.getByTestId("agent-name").fill("Cora")
  await page.getByTestId("model-model").waitFor()
  await page.getByTestId("model-account").selectOption({ label: "Claude" })
  await expect(page.getByTestId("agent-permission-off")).toHaveText(
    "Claude Code (Claude subscription) has no read-only mode.",
  )
  await expect(
    page.locator("[data-testid=agent-permission] label[data-value=read_only] input"),
  ).toBeDisabled()
  await expect(
    page.locator("[data-testid=agent-permission] label[data-value=ask_all] input"),
  ).toBeEnabled()
  await expect(page.getByTestId("agent-permission-line")).toContainText(
    "Claude Code starts as usual",
  )
  await shot(page, "runtime-readiness-08-read-only-off")

  // The same form on the program that has a mode: the option works, and the line names the mode.
  await page.getByTestId("model-account").selectOption({ label: "Codex" })
  await expect(page.getByTestId("agent-permission-off")).toHaveCount(0)
  await page.locator("[data-testid=agent-permission] label[data-value=read_only]").click()
  await expect(page.getByTestId("agent-permission-line")).toContainText(
    "Codex starts in its read-only sandbox",
  )
  await page.getByTestId("agent-name").fill("Rhea")
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("chat-start").filter({ hasText: "Rhea" }).waitFor()
  // The form box is gone before the profile opens, so there is one profile on the page.
  await expect(page.getByTestId("new-agent-dialog")).toHaveCount(0)

  // The app starts the program in its read-only mode. At the default level it does not.
  await send(page, "hello")
  await settled(page)
  const turn = fake.codexCalls().at(-1)
  const args = (turn?.args ?? []) as string[]
  expect(args[args.indexOf("-s") + 1]).toBe("read-only")
  await page.getByTestId("chat-header-agent").click()
  await expect(page.locator("[data-testid=agent-permission] input[value=read_only]")).toBeChecked()
  await app.close()
})
