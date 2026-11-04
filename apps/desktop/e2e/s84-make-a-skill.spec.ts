import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 017, "Make a skill from work": a draft skill from a finished task, an article and a memory
// item. A stand-in model writes the draft. The spec also asks for the form of a new skill, the
// list of skills in settings, and the slash list in a chat, so this file drives those too.

const FILE_SENTINEL = "FILE-CONTENT-SENTINEL-77"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 20_000,
  })
const tools = (...calls: { name: string; args: unknown }[]) => `TOOLS ${JSON.stringify(calls)}`

type Chat = { messages: { role: string; content: string }[] }

/** The requests that asked a model for a draft skill (the system text names the job). */
const draftRequests = (mock: Awaited<ReturnType<typeof startMockProvider>>) =>
  mock.requests
    .filter((r) => r.path === "/v1/chat/completions")
    .map((r) => r.body as Chat)
    .filter((b) => String(b.messages[0]?.content).includes("You write a reusable skill from work"))

/** The skills of the first server, as the app lists them. */
const skillList = (page: Page) =>
  page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the page has no types of the preload
    const robot = (window as any).robot
    const servers = await robot.invoke("servers.list")
    const result = await robot.invoke("skills.list", { serverId: servers.value[0].id })
    return result.value as { name: string; enabled: boolean; agentIds: string[] | null }[]
  })

/** Opens the Tasks page and the detail of the task whose label holds the text. */
const openTask = async (page: Page, text: string) => {
  await page.getByTestId("page-tasks").click()
  await page.getByTestId("task-row").filter({ hasText: text }).getByTestId("task-open").click()
  await expect(page.getByTestId("task-detail")).toBeVisible()
}
const closeTask = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("task-detail")).toHaveCount(0)
}

/** Waits until the form shows a draft: the muted line is gone and the name is filled. */
const drafted = async (page: Page, name: string) => {
  await expect(page.getByTestId("skill-form")).toHaveAttribute("data-phase", "ready", {
    timeout: 15_000,
  })
  await expect(page.getByTestId("skill-name")).toHaveValue(name)
}

/** The local test page with text that was fetched from outside. */
const startTestPage = async () => {
  const site = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" })
    res.end("<html><body><h1>Prices</h1><p>Today the price is 4 dollars.</p></body></html>")
  })
  await new Promise<void>((done) => site.listen(0, "127.0.0.1", done))
  const { port } = site.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/prices`, close: () => site.close() }
}

test("make a skill from a task: the form, the request, Save, the list and the slash list", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const testPage = await startTestPage()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1360, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // A file that the agent reads later. Its content may never reach the request for a draft.
  await send(
    page,
    `Save a note. TOOL write_file ${JSON.stringify({ path: "seed.txt", content: FILE_SENTINEL })}`,
  )
  await settled(page)
  // A task in the state done, with a prompt, two steps and a reply.
  await send(
    page,
    `Get the weekly report SLOWDRAFT. ${tools(
      { name: "read_file", args: { path: "seed.txt" } },
      { name: "list_files", args: {} },
    )}`,
  )
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  // A task that read a page from outside. The test page is on this computer, so the fetch of it
  // asks first (007, "Addresses of a web page fetch"). Allow once lets the turn go on.
  await send(page, `Read the prices. TOOL fetch_url ${JSON.stringify({ url: testPage.url })}`)
  await expect(page.getByTestId("ask-card")).toContainText(testPage.url, { timeout: 15_000 })
  await page.getByTestId("ask-allow").click()
  await settled(page)
  await createAgent(page, "Bo")

  // --- Settings, Skills, before any skill: a muted line and the button -------------------------
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-skills").click()
  await expect(page.getByTestId("skills-empty")).toContainText("A skill is a set of instructions")
  await expect(page.getByTestId("skills-new")).toBeVisible()
  await page.getByTestId("settings-close").click()

  // --- The task view: "Make a skill" opens the form with "Writing a draft…" --------------------
  await openTask(page, "Get the weekly report")
  await page.getByTestId("task-make-skill").click()
  await expect(page.getByTestId("skill-form-dialog")).toBeVisible()
  await expect(page.getByTestId("skill-writing")).toHaveText("Writing a draft…")
  await expect(page.getByTestId("skill-save")).toBeDisabled()
  await shot(page, "s84-01-writing")
  await drafted(page, "Weekly report")
  await expect(page.getByTestId("skill-description")).toHaveValue(
    "When the user wants the weekly report",
  )
  await expect(page.getByTestId("skill-instructions")).toHaveValue(
    /Do the work of Weekly report[\s\S]*Ask the user before you delete anything/,
  )
  // The task read no outside content.
  await expect(page.getByTestId("skill-outside")).toHaveCount(0)
  await expect(page.getByTestId("skill-privacy")).toContainText("Do not write secrets in it")
  // The field "Agents" holds the agent of the task only.
  await expect(page.getByTestId("skill-agents-mode").getByLabel("Chosen agents")).toBeChecked()
  await expect(page.locator("[data-testid=skill-agent][data-agent=Ada]")).toBeChecked()
  await expect(page.locator("[data-testid=skill-agent][data-agent=Bo]")).not.toBeChecked()
  await shot(page, "s84-02-draft")

  // The request holds the prompt, the two steps and the reply, and no output of a tool.
  expect(draftRequests(mock)).toHaveLength(1)
  const asked = draftRequests(mock)[0]?.messages.at(-1)?.content ?? ""
  expect(asked).toContain("Get the weekly report")
  expect(asked).toContain("- file: seed.txt")
  expect(asked.match(/^- /gm)).toHaveLength(2)
  expect(asked).toContain("The final reply of the agent")
  expect(asked).not.toContain(FILE_SENTINEL)
  expect(asked.length).toBeLessThanOrEqual(20_000)
  expect(asked.endsWith("Reply with the JSON object only.")).toBe(true)

  // The request made no task and no message: the task list and the chat are as they were.
  await expect(page.getByTestId("skill-save")).toBeEnabled()
  await page.getByTestId("skill-save").click()
  await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
  await expect(page.getByText("Saved the skill Weekly report.")).toBeVisible()
  await closeTask(page)
  await page.getByTestId("page-tasks").click()
  await expect(page.getByTestId("task-row")).toHaveCount(3)

  // The skill is in the list of skills, for Ada only, and on.
  expect(await skillList(page)).toEqual([
    expect.objectContaining({
      name: "Weekly report",
      enabled: true,
      agentIds: [expect.any(String)],
    }),
  ])
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-skills").click()
  const row = page.locator("[data-testid=skill-row][data-skill='Weekly report']")
  await expect(row).toBeVisible()
  await expect(row.getByTestId("skill-row-agents")).toHaveText("Ada")
  await expect(row.getByTestId("skill-switch")).toHaveAttribute("aria-checked", "true")
  await shot(page, "s84-03-skills-list")
  await page.getByTestId("settings-close").click()

  // A skill made this way has no link to its source: a delete of the task changes nothing. (The
  // list holds no field that names a source.)
  expect(Object.keys((await skillList(page))[0] ?? {})).not.toContain("source")

  // --- The slash list: Ada lists the skill, Bo does not ----------------------------------------
  await page.locator("[data-testid^=place-agent-]").filter({ hasText: "Ada" }).click()
  await page.getByTestId("composer-input").fill("/we")
  await expect(page.getByTestId("skill-option")).toHaveCount(1)
  await expect(page.getByTestId("skill-option")).toContainText("Weekly report")
  await shot(page, "s84-04-slash-list")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("composer-skill")).toContainText("Weekly report")
  await expect(page.getByTestId("composer-input")).toHaveValue("")
  await page.getByTestId("composer-input").fill("for the team")
  await page.getByTestId("composer-input").press("Enter")
  await settled(page)
  const sent = mock.requests
    .filter((r) => r.path === "/v1/chat/completions")
    .map((r) => (r.body as Chat).messages.at(-1)?.content ?? "")
    .find((c) => c.includes("for the team")) as string
  expect(sent.indexOf("Do the work of Weekly report")).toBeGreaterThanOrEqual(0)
  expect(sent.indexOf("Do the work of Weekly report")).toBeLessThan(sent.indexOf("for the team"))
  await page.locator("[data-testid^=place-agent-]").filter({ hasText: "Bo" }).click()
  await page.getByTestId("composer-input").fill("/")
  // The list shows the command and no skill: the skill is for Ada only.
  await expect(page.getByTestId("command-option")).toHaveCount(1)
  await expect(page.getByTestId("skill-option")).toHaveCount(0)
  await page.getByTestId("composer-input").fill("")

  // --- A taken name gets a number in the draft ------------------------------------------------
  await openTask(page, "Get the weekly report")
  await page.getByTestId("task-make-skill").click()
  await drafted(page, "Weekly report 2")
  // Escape closes the form and leaves the task view open: the newest box takes the key.
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
  await expect(page.getByTestId("task-detail")).toBeVisible()
  await closeTask(page)
  expect(await skillList(page)).toHaveLength(1)

  // --- A task whose turn read outside content: the muted line ---------------------------------
  await openTask(page, "Read the prices")
  await page.getByTestId("task-make-skill").click()
  await drafted(page, "Weekly report 2")
  await expect(page.getByTestId("skill-outside")).toHaveText(
    "This work read outside content. Read the instructions before you save.",
  )
  await shot(page, "s84-05-outside")
  // Nothing is saved before the user presses Save.
  await page.getByTestId("skill-cancel").click()
  await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
  expect(await skillList(page)).toHaveLength(1)
  await closeTask(page)

  // A task that is not done has no "Make a skill".
  await page.locator("[data-testid^=place-agent-]").filter({ hasText: "Ada" }).click()
  await send(page, "A turn that fails. fail once")
  await settled(page)
  await openTask(page, "A turn that fails")
  await expect(page.getByTestId("task-detail-state")).toHaveAttribute("data-state", "failed")
  await expect(page.getByTestId("task-retry")).toBeVisible()
  await expect(page.getByTestId("task-make-skill")).toHaveCount(0)
  await closeTask(page)

  testPage.close()
  await app.close()
  await mock.close()
})

test("make a skill from an article and a memory item; failure, cancel, and a full server", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1360, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  const openProfile = async () => {
    await page.getByTestId("chat-header-agent").click()
    await expect(page.getByTestId("memory-panel")).toBeVisible()
  }
  const addItem = async (text: string) => {
    await page.getByTestId("memory-input").fill(text)
    await page.getByTestId("memory-add").click()
    await expect(page.getByTestId("memory-item").filter({ hasText: text })).toBeVisible()
  }
  const makeFromItem = async (text: string) => {
    const item = page.getByTestId("memory-item").filter({ hasText: text })
    await item.getByTestId("memory-item-menu").click()
    await page.getByTestId("memory-make-skill").click()
    await expect(page.getByTestId("skill-form-dialog")).toBeVisible()
  }

  // --- A memory item: the form fills the same way --------------------------------------------
  await openProfile()
  await addItem("Run the linter before a commit")
  await makeFromItem("Run the linter before a commit")
  await drafted(page, "Linter first")
  await expect(page.getByTestId("skill-agents-mode").getByLabel("Chosen agents")).toBeChecked()
  await expect(page.locator("[data-testid=skill-agent][data-agent=Ada]")).toBeChecked()
  await expect(page.getByTestId("skill-outside")).toHaveCount(0)
  const asked = draftRequests(mock).at(-1)?.messages.at(-1)?.content ?? ""
  expect(asked).toContain("Run the linter before a commit")
  await shot(page, "s84-06-memory")
  await page.getByTestId("skill-cancel").click()
  await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
  expect(await skillList(page)).toEqual([])

  // --- The stand-in fails: the reason and "Try again"; no skill is made ----------------------
  await addItem("FAILDRAFT use the linter")
  await makeFromItem("FAILDRAFT use the linter")
  await expect(page.getByTestId("skill-failed")).toContainText("No draft:")
  await expect(page.getByTestId("skill-save")).toBeDisabled()
  await shot(page, "s84-07-failed")
  expect(await skillList(page)).toEqual([])
  await page.getByTestId("skill-retry").click()
  await drafted(page, "Linter first")
  await expect(page.getByTestId("skill-failed")).toHaveCount(0)
  await page.getByTestId("skill-cancel").click()
  await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)

  // --- Cancel while the draft is written: the form closes, the app drops the request ---------
  await addItem("SLOWDRAFT keep the commits small")
  await makeFromItem("SLOWDRAFT keep the commits small")
  await expect(page.getByTestId("skill-writing")).toBeVisible()
  await page.getByTestId("skill-cancel").click()
  await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
  await expect.poll(() => mock.dropped.length, { timeout: 15_000 }).toBe(1)
  expect(await skillList(page)).toEqual([])

  // --- An article: the same form -------------------------------------------------------------
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  await send(
    page,
    `Write it down. TOOL write_article ${JSON.stringify({
      title: "Release steps",
      summary: "How a release goes",
      body: "1. Tag the commit. 2. Build the app. 3. Publish the release.",
      sources: [],
    })}`,
  )
  await settled(page)
  await page.getByTestId("chat-header-agent").click()
  await page.getByTestId("profile-tabs").getByText("Knowledge").click()
  await expect(page.getByTestId("knowledge-page")).toBeVisible()
  await page.getByTestId("knowledge-item").click()
  await expect(page.getByTestId("knowledge-article-title")).toHaveText("Release steps")
  await page.getByTestId("knowledge-make-skill").click()
  await drafted(page, "Release steps")
  const articleAsk = draftRequests(mock).at(-1)?.messages.at(-1)?.content ?? ""
  expect(articleAsk).toContain("How a release goes")
  expect(articleAsk).toContain("3. Publish the release.")
  await expect(page.locator("[data-testid=skill-agent][data-agent=Ada]")).toBeChecked()
  await shot(page, "s84-08-article")
  await page.getByTestId("skill-save").click()
  await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)
  expect(await skillList(page)).toEqual([
    expect.objectContaining({ name: "Release steps", enabled: true }),
  ])
  // A later change of the source does not change the skill: delete the article.
  await page.getByTestId("knowledge-delete").click()
  await expect(page.getByTestId("knowledge-item")).toHaveCount(0)
  expect((await skillList(page))[0]?.name).toBe("Release steps")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)

  // --- A full server: the form opens, and Save refuses ---------------------------------------
  await page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the page has no types of the preload
    const robot = (window as any).robot
    const servers = await robot.invoke("servers.list")
    const serverId = servers.value[0].id
    for (let i = 1; i < 100; i++)
      await robot.invoke("skills.create", {
        serverId,
        name: `Filler ${i}`,
        description: "",
        instructions: "x",
        agentIds: null,
      })
  })
  expect(await skillList(page)).toHaveLength(100)
  await openProfile()
  await makeFromItem("Run the linter before a commit")
  await drafted(page, "Linter first")
  await page.getByTestId("skill-save").click()
  await expect(page.getByTestId("skill-error")).toHaveText(
    "This server has 100 skills, the most it can hold.",
  )
  await expect(page.getByTestId("skill-form-dialog")).toBeVisible()
  await shot(page, "s84-09-full")
  expect(await skillList(page)).toHaveLength(100)
  await page.getByTestId("skill-cancel").click()
  await expect(page.getByTestId("skill-form-dialog")).toHaveCount(0)

  await app.close()
  await mock.close()
})
