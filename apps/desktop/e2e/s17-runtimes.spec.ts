import { readFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { makeFakeRuntimes, sha256, tarGzOf } from "./fake-runtimes.ts"
import { createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"

// The stand-in programs are shell scripts, so these tests run where a shell does.
test.skip(process.platform === "win32", "the stand-in programs need a shell")

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })

const openAddForm = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-add").click()
}

test("subscription: Claude Code connects without a key, chats, and asks before a step", async () => {
  test.setTimeout(120_000)
  const fake = makeFakeRuntimes()
  fake.setClaude({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "tester@example.com",
    plan: "max",
  })
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_CLAUDE_BIN: fake.claude,
    ROBOT_CODEX_BIN: "none",
    // A key in the environment must not reach the program: the subscription pays.
    ANTHROPIC_API_KEY: "sk-must-not-be-used",
  })
  await resizeWindow(app, 1300, 900)

  // The form needs no key and no address: the program and the sign-in are enough.
  await openAddForm(page)
  await expect(page.getByTestId("provider-kind")).toHaveValue("claude_code")
  await expect(page.getByTestId("provider-api-key")).toHaveCount(0)
  await expect(page.getByTestId("provider-base-url")).toHaveCount(0)
  await expect(page.getByTestId("runtime-found")).toContainText("Found version 9.9.9")
  await expect(page.getByTestId("runtime-status")).toHaveText("Signed in as tester@example.com.")
  await expect(page.getByTestId("runtime-plan")).toHaveText("Plan: max")
  await shot(page, "s17-01-claude-signed-in")
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Connected")
  await page.getByTestId("settings-close").click()

  // A reply streams in from the program.
  await createAgent(page, "Ada")
  await expect(page.getByTestId("chat-header-model")).toHaveText("opus")
  await send(page, "hello")
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("Echo: hello")

  // Ask for everything: the step waits on a card, in the app, not in the program.
  await page.getByTestId("chat-header-agent").click()
  await page.getByTestId("agent-permission").getByText("Ask for everything").click()
  await page.getByTestId("agent-submit").click()
  await send(page, "RUN: touch a.txt")
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("ask-card")).toContainText("touch a.txt")
  await shot(page, "s17-02-approval")
  await page.getByTestId("ask-allow").click()
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("It ran.")

  await send(page, "RUN: touch b.txt")
  await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("ask-deny").click()
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("It was denied.")
  await expect(page.getByTestId("tool-card").last()).toContainText("Failed")

  // A usage limit fails the reply and says when it resets.
  await send(page, "LIMIT")
  await settled(page)
  await expect(page.getByTestId("failed-row")).toContainText(
    "The usage limit of this account is reached.",
  )
  await shot(page, "s17-03-limit")

  // No key reached the program in any call.
  const calls = fake.claudeCalls().filter((c) => "prompt" in c)
  expect(calls.length).toBeGreaterThanOrEqual(4)
  expect(calls.every((c) => c.hasApiKey === false)).toBe(true)

  // Settings show the plan and its windows. Disconnect only switches the account off.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await expect(page.getByTestId("runtime-plan")).toHaveText("Plan: max")
  // The last report wins: the turn that hit the limit reported the window as full.
  await expect(page.getByTestId("runtime-limit").first()).toContainText("5-hour usage: 100% used")
  await expect(page.getByTestId("runtime-limit").last()).toContainText("Weekly usage: 40% used")
  await shot(page, "s17-04-limits")
  await page.getByTestId("provider-disconnect").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Not connected")
  expect(JSON.parse(readFileSync(join(fake.dir, "claude-state.json"), "utf8")).loggedIn).toBe(true)
  await page.getByTestId("provider-reconnect").click()
  await expect(page.getByTestId("runtime-status")).toHaveText("Signed in as tester@example.com.")
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Connected")
  await app.close()
})

/** A stand-in for the release list of Codex and the file it points to. */
const mockCodexRelease = async (program: string) => {
  const archive = tarGzOf("codex-release", program)
  const server: Server = createServer((req, res) => {
    const port = (server.address() as AddressInfo).port
    if (req.url === "/repos/openai/codex/releases/latest") {
      const names = [
        "codex-aarch64-apple-darwin.tar.gz",
        "codex-x86_64-apple-darwin.tar.gz",
        "codex-aarch64-unknown-linux-musl.tar.gz",
        "codex-x86_64-unknown-linux-musl.tar.gz",
      ]
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          tag_name: "rust-v9.9.9",
          assets: names.map((name) => ({
            name,
            size: archive.length,
            digest: `sha256:${sha256(archive)}`,
            browser_download_url: `http://127.0.0.1:${port}/download/${name}`,
          })),
        }),
      )
    } else if (req.url?.startsWith("/download/")) {
      res.writeHead(200, { "content-length": archive.length })
      // Slowly, so that the progress bar can be seen.
      res.write(archive.subarray(0, archive.length / 2))
      setTimeout(() => res.end(archive.subarray(archive.length / 2)), 600)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server }
}

test("subscription: Codex is downloaded, checked, signed in from the app, and answers", async () => {
  test.setTimeout(120_000)
  const fake = makeFakeRuntimes()
  fake.setCodex({ loggedIn: false })
  const release = await mockCodexRelease(readFileSync(fake.codex, "utf8"))
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_CODEX_BIN: "none",
    ROBOT_CLAUDE_BIN: "none",
    ROBOT_CODEX_API: release.url,
    FAKE_LOGIN_MS: "1200",
  })
  await resizeWindow(app, 1300, 900)

  await openAddForm(page)
  await page.getByTestId("provider-kind").selectOption("codex")
  // The program is not on the computer: the app offers to download it.
  await expect(page.getByTestId("runtime-status")).toHaveText(
    "The program is not on this computer.",
  )
  await expect(page.getByTestId("provider-submit")).toBeDisabled()
  await shot(page, "s17-05-codex-missing")
  await page.getByTestId("runtime-install").click()
  await expect(page.getByTestId("runtime-progress")).toBeVisible()
  await expect(page.getByTestId("runtime-found")).toContainText(
    "Found version 9.9.9 (downloaded by ROBot)",
    {
      timeout: 20_000,
    },
  )

  // Not signed in: the sign-in opens in the browser and the app waits.
  await expect(page.getByTestId("runtime-status")).toHaveText("Not signed in.")
  await expect(page.getByTestId("provider-submit")).toBeDisabled()
  await page.getByTestId("runtime-sign-in").click()
  await expect(page.getByTestId("runtime-status")).toHaveText(
    "Waiting for the sign-in in your browser…",
  )
  await shot(page, "s17-06-codex-signing-in")
  await expect(page.getByTestId("runtime-status")).toHaveText("Signed in.", { timeout: 15_000 })
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Connected")
  await page.getByTestId("settings-close").click()

  await createAgent(page, "Cody")
  await send(page, "hello codex")
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("Echo: hello codex")
  // "Ask for risky steps" gives Codex a sandbox that can write in the workspace only.
  const call = fake.codexCalls().at(-1) as { args: string[] }
  expect(call.args[call.args.indexOf("-s") + 1]).toBe("workspace-write")
  await app.close()
  release.server.close()
})

test("subscription: the form speaks Korean", async () => {
  const fake = makeFakeRuntimes()
  fake.setClaude({ loggedIn: false })
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "ko-KR",
    ROBOT_CLAUDE_BIN: fake.claude,
    ROBOT_CODEX_BIN: "none",
  })
  await resizeWindow(app, 1200, 800)
  await openAddForm(page)
  await expect(page.getByTestId("runtime-status")).toHaveText("로그인하지 않았어요.")
  await expect(page.getByTestId("runtime-sign-in")).toHaveText("로그인")
  await expect(page.getByTestId("provider-kind").locator("option").first()).toHaveText(
    "Claude Code (Claude 구독)",
  )
  await shot(page, "s17-07-korean")
  await app.close()
})

test("subscription: Muse Code signs in from the app, shows the code, and answers", async () => {
  test.setTimeout(120_000)
  const fake = makeFakeRuntimes()
  fake.setMuse({ loggedIn: false })
  const openLog = join(fake.dir, "opened.log")
  const { app, page } = await launch(freshUserData(), {
    ROBOT_TEST_OPEN_LOG: openLog,
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_CLAUDE_BIN: "none",
    ROBOT_CODEX_BIN: "none",
    ROBOT_MUSE_BIN: fake.muse,
    ROBOT_PI_BIN: "none",
    FAKE_LOGIN_MS: "1500",
  })
  await resizeWindow(app, 1300, 900)

  await openAddForm(page)
  await page.getByTestId("provider-kind").selectOption("muse")
  await expect(page.getByTestId("runtime-status")).toHaveText("Not signed in.")
  await expect(page.getByTestId("provider-submit")).toBeDisabled()
  await page.getByTestId("runtime-sign-in").click({ timeout: 10_000 })
  // The page and the code of the program are shown, so the user can compare them.
  await expect(page.getByTestId("runtime-code")).toContainText("WXYZ-1234")
  await expect(page.getByTestId("runtime-url")).toHaveText("https://auth.meta.com/device")
  await shot(page, "s17-08-muse-signing-in")
  await expect(page.getByTestId("runtime-status")).toHaveText("Signed in.", { timeout: 15_000 })
  await expect(page.getByTestId("runtime-plan")).toContainText("Muse Test Plan")
  // The app opened the page of the sign-in for the user. A test run opens no browser.
  expect(readFileSync(openLog, "utf8").trim()).toBe("https://auth.meta.com/device")
  await page.getByTestId("provider-submit").click({ timeout: 10_000 })
  await expect(page.getByTestId("provider-status")).toHaveText("Connected")
  await page.getByTestId("settings-close").click({ timeout: 10_000 })

  await createAgent(page, "Mia")
  await send(page, "hello muse")
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("Echo: hello muse")
  const call = fake.museCalls().at(-1) as { args: string[]; autoUpdate: string | null }
  expect(call.args).toContain("--no-session-log")
  // The program must not update itself in the background while ROBot uses it.
  expect(call.autoUpdate).toBe("1")
  await app.close()
})

test("subscription: pi lists its own models and has no sign-in in the app", async () => {
  test.setTimeout(120_000)
  const fake = makeFakeRuntimes()
  fake.setPi({ ready: false })
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_CLAUDE_BIN: "none",
    ROBOT_CODEX_BIN: "none",
    ROBOT_MUSE_BIN: "none",
    ROBOT_PI_BIN: fake.pi,
  })
  await resizeWindow(app, 1300, 900)

  await openAddForm(page)
  await page.getByTestId("provider-kind").selectOption("pi")
  // No model is ready: the user signs in inside pi.
  await expect(page.getByTestId("runtime-status")).toHaveText("Not signed in.")
  await expect(page.getByTestId("runtime-sign-in")).toHaveCount(0)
  await expect(page.getByTestId("runtime-sign-in-hint")).toContainText("inside pi")
  await expect(page.getByTestId("provider-submit")).toBeDisabled()
  await shot(page, "s17-09-pi-not-ready")
  fake.setPi({ ready: true })
  await page.getByTestId("runtime-recheck").click()
  await expect(page.getByTestId("runtime-status")).toHaveText("Signed in.")
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Connected")
  await page.getByTestId("settings-close").click()

  await createAgent(page, "Pia")
  await send(page, "hello pi")
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("Echo: hello pi")
  const call = fake.piCalls().at(-1) as { args: string[] }
  // The model comes from the list of pi, as "provider/model".
  expect(call.args[call.args.indexOf("--model") + 1]).toMatch(/^[\w-]+\/fake-(small|large)$/)
  expect(call.args).toContain("--no-session")

  // The effort levels follow the model, as pi tells them: the small model does not think, and the
  // large one takes a level that the old fixed list did not have.
  await page.getByTestId("chat-header-model").click()
  await page.getByTestId("model-model").selectOption("claude-bridge/fake-small")
  await expect(page.getByTestId("model-effort")).toHaveCount(0)
  await page.getByTestId("model-model").selectOption("anthropic/fake-large")
  await expect(page.getByTestId("model-effort").locator("option")).toHaveText([
    "Default",
    "Low",
    "Medium",
    "High",
    "Extra high",
  ])
  await page.getByTestId("model-effort").selectOption("xhigh")
  await shot(page, "s17-10-pi-effort")
  await page.getByTestId("model-save").click()
  await send(page, "think hard")
  await settled(page)
  const thinking = fake.piCalls().at(-1) as { args: string[] }
  expect(thinking.args[thinking.args.indexOf("--model") + 1]).toBe("anthropic/fake-large")
  expect(thinking.args[thinking.args.indexOf("--thinking") + 1]).toBe("xhigh")
  await app.close()
})
