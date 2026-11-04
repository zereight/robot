import { type ChildProcess, spawn } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { unzipSync } from "fflate"
import {
  connectMock,
  createAgent,
  freshUserData,
  type Launched,
  launch,
  resizeWindow,
  shot,
  shotsDir,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// S32: connections (spec 018). The test program is the small MCP server in fakes/mcp-server.mjs.
// The model is a stand-in. Every test works in a data folder and a work area of its own.

const SERVER = resolve(import.meta.dirname, "fakes/mcp-server.mjs")
const CHAT = "/v1/chat/completions"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 20_000,
  })
const tool = (name: string, args: unknown) => `TOOL ${name} ${JSON.stringify(args)}`
const area = () => mkdtempSync(join(tmpdir(), "robot-e2e-conn-"))
const reports = resolve(shotsDir, "..", "reports")
const writeReport = (name: string, lines: string[]) => {
  mkdirSync(reports, { recursive: true })
  writeFileSync(join(reports, `${name}.md`), `${lines.join("\n")}\n`)
}

/** The names of the tools in the newest request of a chat to the stand-in model. */
const toolsOfLastRequest = (mock: Awaited<ReturnType<typeof startMockProvider>>) => {
  const chats = mock.requests.filter((r) => r.path === CHAT)
  const body = chats.at(-1)?.body as { tools?: { function?: { name?: string } }[] } | undefined
  return (body?.tools ?? []).map((t) => t.function?.name ?? "")
}
/** The text of the newest message with the role "tool" in the newest chat request. */
const lastToolResult = (mock: Awaited<ReturnType<typeof startMockProvider>>) => {
  const chats = mock.requests.filter((r) => r.path === CHAT)
  const body = chats.at(-1)?.body as { messages?: { role: string; content: string }[] } | undefined
  return String([...(body?.messages ?? [])].reverse().find((m) => m.role === "tool")?.content ?? "")
}
const callsIn = (file: string): { tool: string; args: unknown }[] =>
  existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : []

const openConnections = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-connections").click()
  await expect(page.getByTestId("connections-section")).toBeVisible()
}
const openPermissions = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  await expect(page.getByTestId("rules")).toBeVisible()
}
const closeSettings = async (page: Page) => {
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings")).toBeHidden()
}
const rowOf = (page: Page, name: string) =>
  page.locator(`[data-testid=connection-row][data-connection="${name}"]`)

interface Line {
  name: string
  value: string
  secret?: boolean
}
interface ProgramForm {
  name: string
  command?: string
  args?: string[]
  folder?: string
  env?: Line[]
}

/** Fills the lines of environment values or of headers in the open form. */
const fillLines = async (page: Page, id: "env" | "header", lines: Line[]) => {
  for (const [index, line] of lines.entries()) {
    await page.getByTestId(`connection-${id}-add`).click()
    const at = page.getByTestId(`connection-${id}-line`).nth(index)
    await at.getByTestId(`connection-${id}-name`).fill(line.name)
    await at.getByTestId(`connection-${id}-value`).fill(line.value)
    if (line.secret) await at.getByTestId(`connection-${id}-secret`).click()
  }
}

/** Opens the form of a program on this computer and fills it. The test program is the default. */
const fillProgram = async (page: Page, form: ProgramForm) => {
  await page.getByTestId("connection-add").click()
  await expect(page.getByTestId("connection-form")).toBeVisible()
  await page.getByTestId("connection-name").fill(form.name)
  await page.getByTestId("connection-command").fill(form.command ?? process.execPath)
  await page.getByTestId("connection-args").fill((form.args ?? [SERVER]).join("\n"))
  if (form.folder) await page.getByTestId("connection-folder").fill(form.folder)
  await fillLines(page, "env", form.env ?? [])
}

/** Fills the form of a program, confirms the command line, tests it and saves it. */
const addProgram = async (page: Page, form: ProgramForm, tools?: number) => {
  await fillProgram(page, form)
  await page.getByTestId("connection-test").click()
  if (tools !== undefined)
    await expect(page.getByTestId("connection-test-result")).toContainText(`Tools: ${tools}`)
  await page.getByTestId("connection-confirm").check()
  await page.getByTestId("connection-save").click()
  await expect(page.getByTestId("connection-form-dialog")).toBeHidden()
  await expect(rowOf(page, form.name)).toBeVisible()
}

const setFullAccess = async (page: Page) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page.getByTestId("agent-permission").getByText("Full access").click()
  await page.getByTestId("full-access-use").click()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
}

/** Everything a test needs: the stand-in model, an app with an agent, and a file for the calls. */
const start = async (
  options: {
    env?: Record<string, string>
    locale?: "en-US" | "ko-KR"
    size?: [number, number]
    userData?: string
    agent?: string
    work?: string
  } = {},
) => {
  const mock = await startMockProvider()
  const work = options.work ?? area()
  const home = join(work, "home")
  mkdirSync(home)
  const calls = join(work, "calls.jsonl")
  const userData = options.userData ?? freshUserData()
  const launched: Launched = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: options.locale ?? "en-US",
    ROBOT_TEST_HOME: home,
    ...options.env,
  })
  const [width, height] = options.size ?? [1100, 800]
  await resizeWindow(launched.app, width, height)
  await connectMock(launched.page, mock.openaiUrl, GOOD_KEY)
  await createAgent(launched.page, options.agent ?? "Ada")
  // The main process writes to its output. A test reads it for secret values.
  const output: string[] = []
  launched.app.process().stdout?.on("data", (d) => output.push(String(d)))
  launched.app.process().stderr?.on("data", (d) => output.push(String(d)))
  return { mock, work, calls, output, ...launched }
}

test("add, test, tools, a tool off, the card, Always allow, the log and a Deny rule (spec 018)", async () => {
  test.setTimeout(180_000)
  const { mock, calls, page, app } = await start()
  const report = ["# S32 add a connection, test, use it, rules and the log", ""]

  // (i) No connections: one muted line and the button.
  await openConnections(page)
  await expect(page.getByTestId("connections-empty")).toContainText("No connections yet")
  await expect(page.getByTestId("connection-add")).toHaveText("Add connection")
  await shot(page, "s32-01-empty")
  report.push("1. With no connections the page shows one muted line and the button Add connection.")

  // (ii) The form for a program shows the full command line and asks for a confirm.
  await fillProgram(page, {
    name: "Notes",
    env: [{ name: "MCP_TEST_CALLS", value: calls }],
  })
  await expect(page.getByTestId("connection-line")).toContainText(`${process.execPath} ${SERVER}`)
  await expect(page.getByTestId("connection-program-warning")).toContainText(
    "runs on this computer with your rights",
  )
  await page.getByTestId("connection-save").click()
  // The user has not confirmed: the form refuses to save.
  await expect(page.getByTestId("connection-error-confirm")).toHaveText(
    "Confirm the command line to save.",
  )
  await shot(page, "s32-02-form-confirm")
  report.push("2. The form shows the full command line and the warning. Save needs the confirm.")

  // (iii) Test shows the tools with name and description.
  await page.getByTestId("connection-test").click()
  const tested = page.getByTestId("connection-test-result")
  await expect(tested).toContainText("Connected. Tools: 8.")
  for (const name of ["echo", "lookup", "slow", "big", "broken", "show_env", "weather_now"])
    await expect(
      tested.locator(`[data-testid=connection-test-tool][data-tool="${name}"]`),
    ).toHaveCount(1)
  await expect(tested.locator('[data-tool="echo"]')).toContainText("Gives the text back.")
  await shot(page, "s32-03-form-tested")
  report.push("3. Test shows eight tools with their names and descriptions.")
  await page.getByTestId("connection-confirm").check()
  await page.getByTestId("connection-save").click()
  await expect(page.getByTestId("connection-form-dialog")).toBeHidden()

  // (iv) The saved form keeps the tools that Test showed: the row says Connected at once.
  const row = rowOf(page, "Notes")
  await expect(row).toHaveAttribute("data-state", "connected")
  await expect(row.getByTestId("connection-row-state")).toHaveText("Connected · tools: 8")
  await expect(row.getByTestId("connection-row-agents")).toHaveText("All agents")
  await expect(page.getByTestId("connections-empty")).toHaveCount(0)
  await shot(page, "s32-04-row-connected")
  report.push("4. The saved row says: Connected · tools: 8.")

  // (v) A tool that is off is not given to any agent.
  await row.getByTestId("connection-tools-summary").click()
  const lookup = row.locator('[data-testid=connection-tool][data-tool="lookup"]')
  await expect(lookup).toContainText("Looks a word up")
  await lookup.getByTestId("connection-tool-switch").click()
  await expect(lookup.getByTestId("connection-tool-switch")).toHaveAttribute(
    "aria-checked",
    "false",
  )
  await shot(page, "s32-05-tool-off")
  await closeSettings(page)
  await send(page, "hello")
  await settled(page)
  const names = toolsOfLastRequest(mock)
  expect(names).toContain("mcp__notes__echo")
  expect(names).toContain("mcp__notes__weather_now")
  expect(names).not.toContain("mcp__notes__lookup")
  report.push("5. A tool that was turned off is missing in the next request. The others are there.")

  // (vi) At "Ask for risky steps" a call shows a card with the connection, the tool, the arguments.
  await send(page, tool("mcp__notes__echo", { text: "hi" }))
  const ask = page.getByTestId("ask-card")
  await expect(ask).toBeVisible({ timeout: 15_000 })
  await expect(ask).toContainText("Notes · echo")
  await expect(ask).toContainText('"text": "hi"')
  await expect(page.getByTestId("ask-always")).toContainText("Always allow for this agent")
  expect(callsIn(calls)).toHaveLength(0)
  await shot(page, "s32-06-approval-card")
  report.push(
    "6. The card names the connection and the tool, and shows the arguments of the agent.",
  )
  await page.getByTestId("ask-always").click()
  await settled(page)
  expect(callsIn(calls)).toEqual([{ tool: "echo", args: { text: "hi" } }])
  expect(lastToolResult(mock)).toContain("Echo: hi")
  await expect(page.getByTestId("tool-card").last()).toContainText("Notes · echo")

  // (vii) One Allow rule on the rules page.
  await openPermissions(page)
  await expect(page.getByTestId("rule-row")).toHaveCount(1)
  const rule = page.getByTestId("rule-row").first()
  await expect(rule.getByTestId("rule-tag")).toHaveText("Allow")
  await expect(rule).toContainText("Tool of a connection")
  await expect(rule).toContainText("Notes")
  await expect(rule).toContainText("echo")
  await shot(page, "s32-07-allow-rule")
  report.push("7. Always allow made one Allow rule for that one tool of the connection.")
  await closeSettings(page)

  // (viii) A second call runs with no question, and the log has two entries without arguments.
  await send(page, tool("mcp__notes__echo", { text: "secret-argument-77" }))
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await expect(page.getByTestId("tool-rule-allowed")).toHaveCount(1)
  expect(callsIn(calls)).toHaveLength(2)
  await openPermissions(page)
  const entries = page.getByTestId("action-log-entry")
  await expect(entries).toHaveCount(2)
  for (const entry of await entries.all()) {
    await expect(entry).toContainText("Notes · echo")
    await expect(entry).not.toContainText("secret-argument-77")
    await expect(entry).not.toContainText('"hi"')
    await expect(entry).not.toContainText("text")
  }
  await shot(page, "s32-08-log-two-entries")
  report.push(
    "8. The second call ran with no card. The log has two entries: Notes · echo, no arguments.",
  )
  await closeSettings(page)

  // (ix) A Deny rule for any tool of the connection wins at Full access.
  await setFullAccess(page)
  await openPermissions(page)
  await page.getByTestId("rule-add").click()
  const dialog = page.getByTestId("rule-dialog")
  await dialog.getByTestId("rule-form-agent").selectOption({ label: "Ada" })
  await dialog.getByTestId("rule-form-kind").selectOption({ label: "Tool of a connection" })
  await dialog.getByTestId("rule-form-text").fill("notes")
  await dialog.getByTestId("rule-form-decision").getByText("Deny", { exact: true }).click()
  await expect(dialog.getByTestId("rule-form-any")).toBeChecked()
  await dialog.getByTestId("rule-form-save").click()
  await expect(page.getByTestId("rule-row")).toHaveCount(2)
  await closeSettings(page)
  await send(page, tool("mcp__notes__weather_now", { city: "Oslo" }))
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Denied by a rule")
  expect(callsIn(calls)).toHaveLength(2)
  await shot(page, "s32-09-denied-by-a-rule")
  report.push(
    "9. A Deny rule for any tool wins at Full access. The card: Denied by a rule. No call went out.",
  )

  // Turn the connection off: its tools leave the next request.
  await openConnections(page)
  await row.getByTestId("connection-switch").click()
  await expect(row).toHaveAttribute("data-state", "off")
  await expect(row.getByTestId("connection-row-state")).toHaveText("Off")
  await closeSettings(page)
  await send(page, "hello again")
  await settled(page)
  expect(toolsOfLastRequest(mock).some((n) => n.startsWith("mcp__"))).toBe(false)
  report.push("10. A connection that is turned off gives no tool in the next request.")
  writeReport("s32-connections-flow", report)
  await app.close()
  await mock.close()
})

test("a tool that never answers fails with timed out; Stop ends a call within 2 seconds; a long result is cut", async () => {
  test.setTimeout(180_000)
  // The limit of a call is 60 seconds. The test run shortens it; the product value stays.
  const { mock, calls, page, app } = await start({ env: { ROBOT_TEST_CONNECTION_CALL_MS: "4000" } })
  const report = ["# S32 limits of a call", ""]
  await openConnections(page)
  await addProgram(page, { name: "Notes", env: [{ name: "MCP_TEST_CALLS", value: calls }] }, 8)
  await closeSettings(page)
  await setFullAccess(page)

  // The tool "slow" never answers: the step fails with the reason "Timed out".
  const began = Date.now()
  await send(page, tool("mcp__notes__slow", {}))
  await expect(page.getByTestId("tool-state").last()).toHaveText("Failed", { timeout: 20_000 })
  const took = Date.now() - began
  await expect(page.getByTestId("tool-reason").last()).toHaveAttribute(
    "data-code",
    "connection_timed_out",
  )
  await expect(page.getByTestId("tool-reason").last()).toHaveText("Timed out")
  expect(took).toBeGreaterThan(3_500)
  await settled(page)
  await shot(page, "s32-10-timed-out")
  report.push(
    `1. A tool that never answers failed after ${took} ms with: Timed out (limit set to 4 s).`,
  )

  // A result of 200000 characters: the agent gets 100000 and a note.
  await send(page, tool("mcp__notes__big", {}))
  await settled(page)
  const result = lastToolResult(mock)
  expect(result.match(/x/g)?.length ?? 0).toBeGreaterThanOrEqual(100_000)
  expect(result).toContain("[The result was longer than 100000 characters and was cut.]")
  expect(result.length).toBeLessThan(110_000)
  report.push(
    `2. A result of 200000 characters reached the agent as ${result.length} characters with the note.`,
  )
  writeReport("s32-connections-limits", report)
  await app.close()
  await mock.close()
})

test("Stop ends a running call within 2 seconds, and the step shows as Stopped", async () => {
  test.setTimeout(120_000)
  const { mock, calls, page, app } = await start()
  await openConnections(page)
  await addProgram(page, { name: "Notes", env: [{ name: "MCP_TEST_CALLS", value: calls }] }, 8)
  await closeSettings(page)
  await setFullAccess(page)
  await send(page, tool("mcp__notes__slow", {}))
  await expect.poll(() => callsIn(calls).length, { timeout: 15_000 }).toBe(1)
  await expect(page.getByTestId("tool-state").last()).toHaveText("Running")
  const began = Date.now()
  await page.getByTestId("composer-stop").click()
  // The reply shows the mark Stopped, and the step is no longer running.
  await expect(page.getByTestId("stopped-mark")).toBeVisible({ timeout: 2_000 })
  const took = Date.now() - began
  expect(took).toBeLessThan(2_000)
  await settled(page)
  await expect(page.getByTestId("tool-state").last()).not.toHaveText("Running")
  await shot(page, "s32-11-stopped")
  // The log has one entry for the call, with the result Stopped.
  await openPermissions(page)
  const entry = page.getByTestId("action-log-entry")
  await expect(entry).toHaveCount(1)
  await expect(entry).toContainText("Notes · slow")
  await expect(entry).toContainText("Stopped")
  writeReport("s32-connections-stop", [
    "# S32 Stop during a call",
    "",
    `Stop was pressed during a call that never answers. The step showed Stopped after ${took} ms.`,
  ])
  await app.close()
  await mock.close()
})

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64")
/** The first file under a folder that holds the text, as it is or as base64. */
const anyFileHolds = (dir: string, text: string): string | null => {
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath, entry.name)
    const data = readFileSync(path)
    if (data.includes(text) || data.includes(b64(text))) return path
  }
  return null
}

test("a secret environment value shows as saved, and the database, the logs and an export hold none of it; an import brings the connection back off, with the value missing", async () => {
  test.setTimeout(180_000)
  const SECRET = "tok-conn-Zq8Wm4Lp7Xv2-secret"
  const work = area()
  const archive = join(work, "export.zip")
  const { mock, calls, page, app, userData, output } = await start({
    work,
    env: { ROBOT_TEST_SAVE_PATH: archive },
  })
  const report = ["# S32 a secret value of a connection", ""]
  await openConnections(page)
  await fillProgram(page, {
    name: "Vault",
    env: [
      { name: "MCP_TEST_CALLS", value: calls },
      { name: "TEST_SECRET", value: SECRET, secret: true },
      { name: "TEST_PLAIN", value: "plain-ok" },
    ],
  })
  // A secret value is a password field: the box does not show it.
  await expect(page.getByTestId("connection-env-value").nth(1)).toHaveAttribute("type", "password")
  await page.getByTestId("connection-test").click()
  await expect(page.getByTestId("connection-test-result")).toContainText("Connected. Tools: 8.")
  await page.getByTestId("connection-confirm").check()
  await page.getByTestId("connection-save").click()
  await expect(rowOf(page, "Vault")).toBeVisible()

  // Reload the page: the row and the form say "saved", and no text of the page holds the value.
  await page.reload()
  await openConnections(page)
  const row = rowOf(page, "Vault")
  await expect(row).toBeVisible()
  await expect(page.locator("body")).not.toContainText(SECRET)
  await row.getByTestId("connection-edit").click()
  const secretLine = page.getByTestId("connection-env-line").nth(1)
  await expect(secretLine).toHaveAttribute("data-saved", "true")
  await expect(secretLine.getByTestId("connection-env-saved")).toHaveText(
    "Saved. Type a new value to replace it.",
  )
  await expect(secretLine.getByTestId("connection-env-value")).toHaveValue("")
  await expect(secretLine.getByTestId("connection-env-value")).toHaveAttribute(
    "placeholder",
    "Saved",
  )
  const inputValues = await page
    .locator("input")
    .evaluateAll((all) => all.map((el) => (el as HTMLInputElement).value))
  expect(inputValues.join("\n")).not.toContain(SECRET)
  await shot(page, "s32-12-secret-saved")
  report.push(
    "1. After a reload the form shows Saved for the secret. The field is empty. No text holds the value.",
  )
  // Save with no new text: the saved value stays (the form needs the confirm again).
  await page.getByTestId("connection-confirm").check()
  await page.getByTestId("connection-save").click()
  await expect(page.getByTestId("connection-form-dialog")).toBeHidden()
  await closeSettings(page)

  // The program got the values of the user and none of the settings of the app.
  await setFullAccess(page)
  await send(page, tool("mcp__vault__env_names", {}))
  await settled(page)
  const seen = lastToolResult(mock)
  expect(seen).toContain(`TEST_SECRET has ${SECRET.length} characters`)
  expect(seen).toContain("TEST_PLAIN has 8 characters")
  expect(seen).toContain("Settings of the app seen: none")
  expect(seen).not.toContain(SECRET)
  report.push(
    "2. The program got TEST_SECRET and TEST_PLAIN, and saw no setting of the app (ROBOT_, ELECTRON_).",
  )

  // Export through the page.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-data").click()
  await page.getByTestId("data-export").click()
  await expect(page.getByTestId("data-note")).toContainText(archive)
  await app.close()

  // The data folder (the database file and the rest), the output of the app and the export
  // hold no clear text of the value. The keychain stand-in next to the folder holds it.
  expect(anyFileHolds(userData, SECRET)).toBeNull()
  expect(output.join("")).not.toContain(SECRET)
  expect(readFileSync(`${userData}-secrets.json`, "utf8")).toContain(SECRET)
  const entries = unzipSync(readFileSync(archive))
  for (const data of Object.values(entries)) {
    expect(Buffer.from(data).includes(SECRET)).toBe(false)
    expect(Buffer.from(data).includes(b64(SECRET))).toBe(false)
  }
  report.push(
    "3. The data folder, the output of the app and the export hold no clear text of the value.",
  )

  // Import into an empty app: the connection is there, it is Off, and its secret value is missing.
  const second = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_OPEN_PATH: archive,
  })
  await resizeWindow(second.app, 1100, 800)
  await second.page.getByTestId("open-settings").click()
  await second.page.getByTestId("settings-nav-data").click()
  await second.page.getByTestId("data-restore").click()
  await expect(second.page.getByTestId("data-note")).toContainText("Restored")
  await second.page.getByTestId("settings-nav-connections").click()
  const back = rowOf(second.page, "Vault")
  await expect(back).toBeVisible()
  await expect(back).toHaveAttribute("data-state", "off")
  await expect(back.getByTestId("connection-row-state")).toHaveText("Off")
  await expect(back.getByTestId("connection-switch")).toHaveAttribute("aria-checked", "false")
  await expect(back.getByTestId("connection-value-missing")).toContainText(
    "A secret value is missing on this computer",
  )
  await shot(second.page, "s32-13-imported-off")
  await back.getByTestId("connection-edit").click()
  await expect(second.page.getByTestId("connection-env-line").nth(1)).toHaveAttribute(
    "data-saved",
    "false",
  )
  report.push(
    "4. An import into an empty app brings the connection back Off, with the secret value missing.",
  )
  writeReport("s32-connections-secret", report)
  await second.app.close()
  await mock.close()
})

test("a program that was removed from the disk: the chat says the connection is not available and the turn goes on", async () => {
  test.setTimeout(120_000)
  const work = area()
  const program = join(work, "notes-server")
  writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${SERVER}"\n`)
  chmodSync(program, 0o755)
  const { mock, page, app } = await start({ work })
  await openConnections(page)
  await addProgram(page, { name: "Notes", command: program, args: [] }, 8)
  await closeSettings(page)
  rmSync(program)
  await send(page, "hello")
  await settled(page)
  await expect(page.getByTestId("connection-down")).toHaveText(
    "The connection Notes is not available.",
  )
  // The turn went on: the agent answered, with its other tools.
  await expect(page.getByTestId("message").last()).toContainText("You said: hello")
  const names = toolsOfLastRequest(mock)
  expect(names).toContain("read_file")
  expect(names.some((n) => n.startsWith("mcp__"))).toBe(false)
  await shot(page, "s32-14-connection-not-available")
  // The row says why.
  await openConnections(page)
  const row = rowOf(page, "Notes")
  await expect(row).toHaveAttribute("data-state", "error")
  await expect(row.getByTestId("connection-row-state")).toHaveText(
    "Error: The program was not found.",
  )
  await shot(page, "s32-15-row-error")
  await app.close()
  await mock.close()
})

/** The test program as a web server on 127.0.0.1. Resolves when it listens. */
const startWebProgram = async (token: string) => {
  const probe = createServer()
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((done) => probe.close(() => done()))
  const child: ChildProcess = spawn(process.execPath, [SERVER], {
    env: { ...process.env, MCP_TEST_HTTP_PORT: String(port), MCP_TEST_TOKEN: token },
    stdio: "ignore",
  })
  for (let tries = 0; tries < 200; tries++) {
    try {
      await fetch(`http://127.0.0.1:${port}/`, { method: "DELETE" })
      break
    } catch {
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  return { port, url: `http://127.0.0.1:${port}/mcp`, stop: () => child.kill() }
}

const pickWeb = async (page: Page) => {
  await page.getByTestId("connection-add").click()
  await expect(page.getByTestId("connection-form")).toBeVisible()
  await page.getByTestId("connection-kind").getByText("Web address", { exact: true }).click()
  await expect(page.getByTestId("connection-form")).toHaveAttribute("data-kind", "web")
}

test("a web address: http is refused except on this computer; Test says why it failed; a header with a token works", async () => {
  test.setTimeout(180_000)
  const web = await startWebProgram("tok-web-123456")
  // A server that answers, and that is not an MCP server.
  const wrong = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" })
    res.end("hello")
  })
  await new Promise<void>((done) => wrong.listen(0, "127.0.0.1", done))
  const wrongPort = (wrong.address() as AddressInfo).port
  // The test run shortens the 20 seconds of a Test; the product value stays.
  const { mock, page, app } = await start({ env: { ROBOT_TEST_CONNECTION_START_MS: "1500" } })
  const report = ["# S32 web address and the reasons of a failed Test", ""]
  await openConnections(page)
  await pickWeb(page)
  await page.getByTestId("connection-name").fill("Web")

  // http://example.com is refused. The reason is under the field.
  await page.getByTestId("connection-address").fill("http://example.com")
  await expect(page.getByTestId("connection-error-address")).toHaveText(
    "Use an https address. Only an address on this computer may use http.",
  )
  await shot(page, "s32-16-address-refused")
  await page.getByTestId("connection-save").click()
  await expect(page.getByTestId("connection-form-dialog")).toBeVisible()
  await expect(page.getByTestId("connection-error-address")).toBeVisible()
  report.push(
    "1. The address http://example.com is refused: the reason shows under the field, and Save does not save.",
  )
  // An address with a sign-in part is refused too.
  await page.getByTestId("connection-address").fill("https://user:pass@example.com/mcp")
  await expect(page.getByTestId("connection-error-address")).toContainText(
    "must not hold a user name or a password",
  )
  await page.getByTestId("connection-address").fill("not an address")
  await expect(page.getByTestId("connection-error-address")).toHaveText(
    "This address is not valid.",
  )
  // http://127.0.0.1:9000 is accepted: no reason shows. Nobody listens there, so Test says why.
  await page.getByTestId("connection-address").fill("http://127.0.0.1:9000")
  await expect(page.getByTestId("connection-error-address")).toHaveCount(0)
  await page.getByTestId("connection-test").click()
  await expect(page.getByTestId("connection-test-failed")).toHaveText(
    "Test failed: The address refused the call.",
  )
  report.push("2. http://127.0.0.1:9000 is accepted. Test says: The address refused the call.")
  await shot(page, "s32-17-address-accepted-refused")

  // A server that answers with text that is not MCP.
  await page.getByTestId("connection-address").fill(`http://127.0.0.1:${wrongPort}/mcp`)
  await page.getByTestId("connection-test").click()
  await expect(page.getByTestId("connection-test-failed")).toHaveText(
    "Test failed: The answer is not valid.",
  )

  // The test program as a web server that needs a token: a wrong token is refused.
  await page.getByTestId("connection-address").fill(web.url)
  await page.getByTestId("connection-test").click()
  await expect(page.getByTestId("connection-test-failed")).toHaveText(
    "Test failed: The sign-in was refused.",
  )
  await fillLines(page, "header", [
    { name: "Authorization", value: "Bearer wrong-token", secret: true },
  ])
  await page.getByTestId("connection-test").click()
  await expect(page.getByTestId("connection-test-failed")).toHaveText(
    "Test failed: The sign-in was refused.",
  )
  // The right token works.
  // The user types the token key by key: the field keeps its focus while the list is drawn again.
  await page.getByTestId("connection-header-value").fill("")
  await page.getByTestId("connection-header-value").pressSequentially("Bearer tok-web-123456")
  await expect(page.getByTestId("connection-header-value")).toHaveValue("Bearer tok-web-123456")
  await page.getByTestId("connection-test").click()
  await expect(page.getByTestId("connection-test-result")).toContainText("Connected. Tools: 8.")
  await shot(page, "s32-18-web-tested")
  report.push(
    "3. Sign-in refused with a wrong token, and not valid with a server that is not MCP. The right token works.",
  )
  await page.getByTestId("connection-save").click()
  await expect(page.getByTestId("connection-form-dialog")).toBeHidden()
  const row = rowOf(page, "Web")
  await expect(row.getByTestId("connection-row-state")).toHaveText("Connected · tools: 8")
  await expect(row.getByTestId("connection-row-target")).toHaveText(web.url)
  await expect(row.getByTestId("connection-row")).toHaveCount(0)
  // The saved token is never shown again: the form says Saved.
  await row.getByTestId("connection-edit").click()
  await expect(page.getByTestId("connection-header-line")).toHaveAttribute("data-saved", "true")
  await expect(page.getByTestId("connection-header-value")).toHaveValue("")
  await page.getByTestId("connection-cancel").click()
  await closeSettings(page)

  // An agent uses the tool over the web address: the card, then the result.
  await send(page, tool("mcp__web__lookup", { word: "oslo" }))
  await expect(page.getByTestId("ask-card")).toContainText("Web · lookup")
  await page.getByTestId("ask-allow").click()
  await settled(page)
  expect(lastToolResult(mock)).toContain("Found oslo")
  report.push(
    "4. An agent called a tool over the web address. The card named Web · lookup. The result came back.",
  )

  // The reasons for a program: not found, ended, no answer.
  await openConnections(page)
  const reasonOf = async (command: string, args: string[]) => {
    await fillProgram(page, { name: "Probe", command, args })
    await page.getByTestId("connection-test").click()
    const failed = page.getByTestId("connection-test-failed")
    await expect(failed).toBeVisible({ timeout: 15_000 })
    const text = (await failed.textContent()) ?? ""
    await page.getByTestId("connection-cancel").click()
    await expect(page.getByTestId("connection-form-dialog")).toBeHidden()
    return text
  }
  expect(await reasonOf("/no/such/program", [])).toBe("Test failed: The program was not found.")
  expect(await reasonOf("/bin/sh", ["-c", "exit 0"])).toBe("Test failed: The program ended.")
  expect(await reasonOf("/bin/sleep", ["30"])).toBe("Test failed: No answer in 20 seconds.")
  report.push(
    "5. Test says: The program was not found. The program ended. No answer in 20 seconds.",
  )
  writeReport("s32-connections-web", report)
  web.stop()
  wrong.close()
  await app.close()
  await mock.close()
})

test("the form checks the name, and the 21st connection is refused", async () => {
  test.setTimeout(240_000)
  const { page, app, mock } = await start()
  const report = ["# S32 names and the limit of 20 connections", ""]
  await openConnections(page)
  for (let n = 1; n <= 20; n++) {
    await pickWeb(page)
    await page.getByTestId("connection-name").fill(`Service ${n}`)
    await page.getByTestId("connection-address").fill(`https://example.com/mcp/${n}`)
    await page.getByTestId("connection-save").click()
    await expect(page.getByTestId("connection-form-dialog")).toBeHidden()
  }
  await expect(page.getByTestId("connection-row")).toHaveCount(20)
  await shot(page, "s32-19-twenty-connections")
  // The form for the 21st: the name checks first.
  await pickWeb(page)
  await page.getByTestId("connection-address").fill("https://example.com/mcp/21")
  await page.getByTestId("connection-name").fill("service 7")
  await expect(page.getByTestId("connection-error-name")).toHaveText(
    "Another connection has this name.",
  )
  await page.getByTestId("connection-name").fill("x".repeat(41))
  await expect(page.getByTestId("connection-error-name")).toHaveText(
    "The name can have at most 40 characters.",
  )
  await page.getByTestId("connection-name").fill("   ")
  await expect(page.getByTestId("connection-error-name")).toHaveText("Give the connection a name.")
  await shot(page, "s32-20-name-errors")
  await page.getByTestId("connection-name").fill("Service 21")
  await expect(page.getByTestId("connection-error-name")).toHaveCount(0)
  await page.getByTestId("connection-save").click()
  await expect(page.getByTestId("connection-error")).toHaveText(
    "A server holds at most 20 connections. Remove one first.",
  )
  await expect(page.getByTestId("connection-form-dialog")).toBeVisible()
  await shot(page, "s32-21-twenty-first-refused")
  await page.getByTestId("connection-cancel").click()
  await expect(page.getByTestId("connection-row")).toHaveCount(20)
  report.push(
    "1. Twenty connections were saved. The form for the 21st said: A server holds at most 20 connections.",
  )
  // Remove one after a confirm: the question shows, Keep it leaves it, Remove goes.
  const first = rowOf(page, "Service 1")
  await first.getByTestId("connection-remove").click()
  await expect(first.getByTestId("connection-remove-ask")).toContainText(
    "Remove the connection Service 1?",
  )
  await first.getByTestId("connection-remove-cancel").click()
  await expect(first.getByTestId("connection-remove-ask")).toHaveCount(0)
  await first.getByTestId("connection-remove").click()
  await shot(page, "s32-22-remove-ask")
  await first.getByTestId("connection-remove-confirm").click()
  await expect(page.getByTestId("connection-row")).toHaveCount(19)
  report.push("2. Remove asks first. Keep it leaves the connection. Remove connection removes it.")
  writeReport("s32-connections-limit", report)
  await app.close()
  await mock.close()
})

test("more than 20 tools: the agent gets the step Search tools and not the tools; a found tool asks as any tool", async () => {
  test.setTimeout(180_000)
  const { mock, calls, page, app } = await start()
  const report = ["# S32 many tools and the step Search tools", ""]
  await openConnections(page)
  // The test program offers 8 tools and 13 more: 21 tools.
  await addProgram(
    page,
    {
      name: "Notes",
      env: [
        { name: "MCP_TEST_CALLS", value: calls },
        { name: "MCP_TEST_TOOLS", value: "13" },
      ],
    },
    21,
  )
  await expect(rowOf(page, "Notes").getByTestId("connection-row-state")).toHaveText(
    "Connected · tools: 21",
  )
  await closeSettings(page)

  // The first request holds the step and none of the 21 tools.
  await send(page, "hello")
  await settled(page)
  const first = toolsOfLastRequest(mock)
  expect(first).toContain("search_tools")
  expect(first.filter((n) => n.startsWith("mcp__"))).toEqual([])
  report.push(
    "1. With 21 tools the first request holds the step search_tools and none of the 21 tools.",
  )

  // The agent searches "weather", then calls the tool that it found.
  await send(
    page,
    `TOOLS ${JSON.stringify([
      { name: "search_tools", args: { query: "weather" } },
      { name: "mcp__notes__weather_now", args: { city: "Oslo" } },
    ])}`,
  )
  const ask = page.getByTestId("ask-card")
  await expect(ask).toBeVisible({ timeout: 15_000 })
  await expect(ask).toContainText("Notes · weather_now")
  const search = page
    .getByTestId("tool-card")
    .filter({ hasText: "Searched tools: weather · found: 1" })
  await expect(search).toHaveCount(1)
  await shot(page, "s32-23-search-then-card")
  await page.getByTestId("ask-allow").click()
  await settled(page)
  expect(callsIn(calls)).toEqual([{ tool: "weather_now", args: { city: "Oslo" } }])
  report.push(
    "2. The step card reads: Searched tools: weather · found: 1. The found tool asks as any tool.",
  )

  // The log has one entry for the call and none for the search.
  await openPermissions(page)
  const entries = page.getByTestId("action-log-entry")
  await expect(entries).toHaveCount(1)
  await expect(entries).toContainText("Notes · weather_now")
  await closeSettings(page)
  report.push("3. The log has one entry for the call and none for the search.")

  // Words that match no tool: the step says so. A tool that was not found fails.
  await send(page, tool("search_tools", { query: "zzzzzz" }))
  await settled(page)
  expect(lastToolResult(mock)).toBe("No tool found.")
  await send(page, tool("mcp__notes__echo", { text: "x" }))
  await settled(page)
  expect(lastToolResult(mock)).toBe("Unknown tool. Search for it first.")
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  expect(callsIn(calls)).toHaveLength(1)
  // A tool that was found in an earlier turn is not open in this one.
  await send(page, tool("mcp__notes__weather_now", { city: "Oslo" }))
  await settled(page)
  expect(lastToolResult(mock)).toBe("Unknown tool. Search for it first.")
  expect(callsIn(calls)).toHaveLength(1)
  await shot(page, "s32-24-unknown-tool")
  report.push(
    "4. No match gives: No tool found. A tool that was not found, or found in an earlier turn, fails with: Unknown tool. Search for it first. The connection got no call.",
  )

  // Turn one tool off: 20 tools, so the next request holds all 20 and no step.
  await openConnections(page)
  const row = rowOf(page, "Notes")
  await row.getByTestId("connection-tools-summary").click()
  await row
    .locator('[data-testid=connection-tool][data-tool="slow"]')
    .getByTestId("connection-tool-switch")
    .click()
  // The list stays open: the row is not drawn again.
  await expect(row.getByTestId("connection-tool-list")).toBeVisible()
  await shot(page, "s32-25-tools-open")
  await closeSettings(page)
  await send(page, "hello again")
  await settled(page)
  const names = toolsOfLastRequest(mock)
  expect(names).not.toContain("search_tools")
  expect(names.filter((n) => n.startsWith("mcp__"))).toHaveLength(20)
  report.push("5. After one tool was turned off the request holds all 20 tools and no step.")
  writeReport("s32-connections-search", report)
  await app.close()
  await mock.close()
})

test("Korean, in a narrow and in a wide window: the page, the form, the card and the line of a connection that is down", async () => {
  test.setTimeout(180_000)
  const work = area()
  const program = join(work, "notes-server")
  writeFileSync(program, `#!/bin/sh\nexec "${process.execPath}" "${SERVER}"\n`)
  chmodSync(program, 0o755)
  const { mock, calls, page, app } = await start({
    work,
    locale: "ko-KR",
    size: [480, 760],
  })
  const report = ["# S32 Korean, narrow and wide", ""]
  await openConnections(page)
  await expect(page.getByTestId("connections-empty")).toContainText("아직 연결이 없어요")
  await shot(page, "s32-26-ko-narrow-empty")

  // The form in a narrow window: the lines of values go under their names.
  await fillProgram(page, {
    name: "Notes",
    command: program,
    args: [],
    env: [
      { name: "MCP_TEST_CALLS", value: calls },
      { name: "TEST_TOKEN", value: "tok-ko-narrow-1234", secret: true },
    ],
  })
  await page.getByTestId("connection-test").click()
  await expect(page.getByTestId("connection-test-result")).toContainText("연결됐어요. 도구 8개.")
  await shot(page, "s32-27-ko-narrow-form-tested")
  await page.getByTestId("connection-confirm").check()
  await page.getByTestId("connection-save").click()
  await expect(page.getByTestId("connection-form-dialog")).toBeHidden()
  const row = rowOf(page, "Notes")
  await expect(row.getByTestId("connection-row-state")).toHaveText("연결됨 · 도구 8개")
  await row.getByTestId("connection-tools-summary").click()
  await shot(page, "s32-28-ko-narrow-row-tools")
  report.push(
    "1. Korean words on the page, the form, the test result and the row, in a window 480 wide.",
  )

  // A card in Korean names the connection and the tool.
  await closeSettings(page)
  await send(page, tool("mcp__notes__echo", { text: "안녕" }))
  const ask = page.getByTestId("ask-card")
  await expect(ask).toBeVisible({ timeout: 15_000 })
  await expect(ask).toContainText("Notes · echo")
  await shot(page, "s32-29-ko-narrow-card")
  await page.getByTestId("ask-allow").click()
  await settled(page)

  // The program is gone: the muted line, in Korean, and the turn goes on.
  rmSync(program)
  await openConnections(page)
  await row.getByTestId("connection-switch").click()
  await row.getByTestId("connection-switch").click()
  await closeSettings(page)
  await send(page, "hello")
  await settled(page)
  await expect(page.getByTestId("connection-down")).toHaveText("연결 Notes을(를) 쓸 수 없어요.")
  await shot(page, "s32-30-ko-narrow-down")
  report.push("2. The card and the muted line of a connection that is down read in Korean.")

  // The same page in a wide window.
  await resizeWindow(app, 1100, 800)
  await openConnections(page)
  await expect(rowOf(page, "Notes").getByTestId("connection-row-state")).toContainText("오류")
  await shot(page, "s32-31-ko-wide-row-error")
  await rowOf(page, "Notes").getByTestId("connection-edit").click()
  await shot(page, "s32-32-ko-wide-form")
  report.push(
    "3. The row says: Error, with the reason in Korean. The form is shown in Korean in a wide window.",
  )
  writeReport("s32-connections-ko", report)
  await app.close()
  await mock.close()
})
