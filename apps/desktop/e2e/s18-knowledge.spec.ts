import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { unzipSync } from "fflate"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })

/** The Knowledge folder of the only agent: workspaces/<agent>/Knowledge in the data folder. */
const knowledgeDir = (userData: string) => {
  const root = join(userData, "workspaces")
  const [agent] = readdirSync(root)
  return join(root, agent ?? "")
}

const openKnowledge = async (page: Page) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  // The tabs do not take the focus from the name field.
  await expect(page.getByTestId("agent-profile").getByTestId("agent-name")).toBeFocused()
  await page.getByTestId("profile-tabs").getByText("Knowledge").click()
  await expect(page.getByTestId("knowledge-page")).toBeVisible()
}
const closeProfile = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
}

/** Every file under a folder, with its text. */
const allText = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true, recursive: true })
        .filter((e) => e.isFile())
        .map((e) => readFileSync(join(e.parentPath, e.name), "utf8"))
    : []

test("knowledge: sources, articles, read cards, undo, protection, check, off, key refusal", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-s18-"))
  const report = join(work, "report.txt")
  writeFileSync(report, "Revenue grew 4 percent in the quarter.")
  const archive = join(work, "export.zip")
  const userData = freshUserData()
  const env = {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_PICK_FILES: JSON.stringify([report]),
    ROBOT_TEST_SAVE_PATH: archive,
    ROBOT_TEST_OPEN_LOG: join(work, "opened.log"),
  }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1360, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // Empty: a muted line, and no folder yet.
  await openKnowledge(page)
  await expect(page.getByTestId("knowledge-empty")).toContainText("No articles yet.")
  await expect(page.getByTestId("knowledge-open-folder")).toBeDisabled()
  await expect(page.getByTestId("knowledge-check")).toBeDisabled()
  await shot(page, "s18-01-empty")
  await closeProfile(page)
  const workspace = knowledgeDir(userData)
  const folder = join(workspace, "Knowledge")
  expect(existsSync(folder)).toBe(false)

  // Attach a file and ask the agent to add it: a source, an article that cites it, and a muted
  // line with undo for the change. The source file stays as it was.
  await page.getByTestId("composer-attach").click()
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1)
  const tools = [
    { name: "add_source", args: { path: "attachments/report.txt" } },
    {
      name: "write_article",
      args: {
        title: "Quarterly revenue",
        summary: "Revenue figures of the quarter",
        body: "Revenue grew 4 percent. Costs are in [[Costs]].",
        sources: ["report.txt"],
      },
    },
  ]
  await send(page, `Add this file to knowledge. TOOLS ${JSON.stringify(tools)}`)
  await settled(page)
  await expect(page.getByTestId("knowledge-source-line")).toContainText("Added source: report.txt")
  await expect(page.getByTestId("knowledge-line")).toContainText(
    "Updated article: Quarterly revenue",
  )
  await expect(page.getByTestId("knowledge-undo")).toBeVisible()
  await shot(page, "s18-02-change-line")
  expect(readFileSync(report, "utf8")).toBe("Revenue grew 4 percent in the quarter.")
  expect(readFileSync(join(folder, "sources", "report.txt"), "utf8")).toBe(
    "Revenue grew 4 percent in the quarter.",
  )
  expect(readFileSync(join(workspace, "attachments", "report.txt"), "utf8")).toBe(
    "Revenue grew 4 percent in the quarter.",
  )
  expect(readFileSync(join(folder, "Quarterly revenue.md"), "utf8")).toContain("source: report.txt")

  // A later turn gets the contents list, opens the article, and uses it.
  await send(page, "What do you know about the quarterly revenue growth?")
  await settled(page)
  await expect(page.getByTestId("knowledge-read-card").last()).toContainText(
    "Read article: Quarterly revenue",
  )
  await expect(page.locator("[data-testid=message][data-author=agent]").last()).toContainText(
    "Revenue grew 4 percent",
  )
  await shot(page, "s18-03-read-card")

  // The Knowledge page: list, reading pane, a broken link, a source, the time of the last change.
  await openKnowledge(page)
  await expect(page.getByTestId("knowledge-item")).toHaveCount(1)
  await expect(page.getByTestId("knowledge-count")).toContainText("1 of 500 articles")
  await page.getByTestId("knowledge-item").click()
  await expect(page.getByTestId("knowledge-article-title")).toHaveText("Quarterly revenue")
  await expect(page.getByTestId("knowledge-article")).toContainText("Revenue grew 4 percent")
  await expect(page.getByTestId("knowledge-link")).toHaveAttribute("data-missing", "true")
  await expect(page.getByTestId("knowledge-link")).toContainText("No such article")
  await expect(page.getByTestId("knowledge-source")).toContainText("report.txt")
  await expect(page.getByTestId("knowledge-updated")).toContainText("Changed")
  await expect(page.getByTestId("knowledge-updated")).toContainText("The agent edited it last.")
  await shot(page, "s18-04-page")
  await page.getByTestId("knowledge-open-folder").click()
  await expect.poll(() => readFileSync(join(work, "opened.log"), "utf8")).toContain(folder)

  // The user adds an article; a link opens the linked article.
  await page.getByTestId("knowledge-add").click()
  await page.getByTestId("knowledge-title-input").fill("Costs")
  await page.getByTestId("knowledge-summary-input").fill("Expense list")
  await page.getByTestId("knowledge-body-input").fill("Costs fell 2 percent.")
  await page.getByTestId("knowledge-save").click()
  await expect(page.getByTestId("knowledge-article-title")).toHaveText("Costs")
  await expect(page.getByTestId("knowledge-item")).toHaveCount(2)
  await page.getByTestId("knowledge-search").fill("percent")
  await expect(page.getByTestId("knowledge-item")).toHaveCount(2)
  await page.getByTestId("knowledge-search").fill("fell")
  await expect(page.getByTestId("knowledge-item")).toHaveCount(1)
  await page.getByTestId("knowledge-search").fill("")
  await page.getByTestId("knowledge-item").filter({ hasText: "Quarterly" }).click()
  await expect(page.getByTestId("knowledge-link")).toHaveAttribute("data-missing", "false")
  await page.getByTestId("knowledge-link").click()
  await expect(page.getByTestId("knowledge-article-title")).toHaveText("Costs")
  // The title stays unique, ignoring case.
  await page.getByTestId("knowledge-add").click()
  await page.getByTestId("knowledge-title-input").fill("COSTS")
  await page.getByTestId("knowledge-save").click()
  await expect(page.getByTestId("knowledge-error")).toContainText("Another article has this title.")
  await page.getByTestId("knowledge-cancel").click()

  // Delete an article: a later turn cannot use it. Undo from the change list: it can.
  await page.getByTestId("knowledge-item").filter({ hasText: "Costs" }).click()
  await page.getByTestId("knowledge-delete").click()
  await expect(page.getByTestId("knowledge-item")).toHaveCount(1)
  expect(existsSync(join(folder, "Costs.md"))).toBe(false)
  await closeProfile(page)
  const reads = await page.getByTestId("knowledge-read-card").count()
  await send(page, "Tell me about the costs again.")
  await settled(page)
  await expect(page.getByTestId("knowledge-read-card")).toHaveCount(reads)
  await openKnowledge(page)
  await page.getByTestId("knowledge-changes-fold").locator("summary").first().click()
  await expect(page.getByTestId("knowledge-change").first()).toContainText("Deleted: Costs")
  await shot(page, "s18-05-changes")
  await page.getByTestId("knowledge-change-undo").first().click()
  await expect(page.getByTestId("knowledge-item")).toHaveCount(2)
  expect(readFileSync(join(folder, "Costs.md"), "utf8")).toContain("Costs fell 2 percent.")
  await closeProfile(page)
  await send(page, "Tell me about the costs once more.")
  await settled(page)
  await expect(page.getByTestId("knowledge-read-card").last()).toContainText("Read article: Costs")

  // Undo from the line in the chat.
  await send(
    page,
    `TOOL write_article ${JSON.stringify({ title: "Scratch", summary: "temp", body: "temp" })}`,
  )
  await settled(page)
  const scratch = page.getByTestId("knowledge-line").filter({ hasText: "Scratch" })
  await expect(scratch).toContainText("Updated article: Scratch")
  expect(existsSync(join(folder, "Scratch.md"))).toBe(true)
  await scratch.getByTestId("knowledge-undo").click()
  await expect(scratch.getByTestId("knowledge-undone")).toHaveText("Undone")
  await expect.poll(() => existsSync(join(folder, "Scratch.md"))).toBe(false)

  // Protection: the user edits, then the agent wants to change the article. A card shows the
  // old text beside the new one. Deny keeps the text.
  await openKnowledge(page)
  await page.getByTestId("knowledge-item").filter({ hasText: "Quarterly revenue" }).click()
  await page.getByTestId("knowledge-edit").click()
  await page
    .getByTestId("knowledge-body-input")
    .fill("Revenue grew 5 percent. Costs are in [[Costs]].")
  await page.getByTestId("knowledge-save").click()
  await expect(page.getByTestId("knowledge-updated")).toContainText("You edited it last.")
  await closeProfile(page)
  await send(
    page,
    `TOOL write_article ${JSON.stringify({ title: "Quarterly revenue", body: "Agent rewrite" })}`,
  )
  await expect(page.getByTestId("ask-article")).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId("ask-before")).toContainText("Revenue grew 5 percent")
  await expect(page.getByTestId("ask-after")).toContainText("Agent rewrite")
  await expect(page.getByTestId("ask-always")).toHaveCount(0)
  await shot(page, "s18-06-protection")
  await page.getByTestId("ask-deny").click()
  await settled(page)
  expect(readFileSync(join(folder, "Quarterly revenue.md"), "utf8")).toContain("5 percent")
  await expect(page.getByTestId("knowledge-failed").last()).toContainText("You denied this change.")

  // A stored key cannot be saved. The card says so, and no file holds the key.
  await send(
    page,
    `TOOL write_article ${JSON.stringify({ title: "Secret", body: `The key is ${GOOD_KEY}` })}`,
  )
  await settled(page)
  await expect(page.getByTestId("knowledge-failed").last()).toContainText(
    "Could not save article: Secret",
  )
  await expect(page.getByTestId("knowledge-failed").last()).toContainText(
    "looks like a key or a token",
  )
  await shot(page, "s18-07-key-refused")
  expect(existsSync(join(folder, "Secret.md"))).toBe(false)
  expect(allText(folder).some((text) => text.includes(GOOD_KEY))).toBe(false)

  // A file made by another app shows up on its own.
  await openKnowledge(page)
  await expect(page.getByTestId("knowledge-item")).toHaveCount(2)
  writeFileSync(join(folder, "Outside.md"), "# Outside\n\nWritten by another app.\n")
  await expect(page.getByTestId("knowledge-item")).toHaveCount(3, { timeout: 10_000 })
  await page.getByTestId("knowledge-item").filter({ hasText: "Outside" }).click()
  await expect(page.getByTestId("knowledge-updated")).toContainText("You edited it last.")
  await page.getByTestId("knowledge-delete").click()
  await expect(page.getByTestId("knowledge-item")).toHaveCount(2)

  // Check: delete an article that another one links to. The report names the broken link, and
  // the agent changes nothing.
  await page.getByTestId("knowledge-item").filter({ hasText: "Costs" }).click()
  await page.getByTestId("knowledge-delete").click()
  await expect(page.getByTestId("knowledge-item")).toHaveCount(1)
  const before = readFileSync(join(folder, "Quarterly revenue.md"), "utf8")
  await page.getByTestId("knowledge-check").click()
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  await settled(page)
  const asked = page.locator("[data-testid=message][data-author=user]").last()
  await expect(asked).toContainText("Check knowledge.")
  const report_ = page.locator("[data-testid=message][data-author=agent]").last()
  await expect(report_).toContainText(
    "Quarterly revenue links to Costs. This article does not exist.",
  )
  await shot(page, "s18-08-check")
  expect(readFileSync(join(folder, "Quarterly revenue.md"), "utf8")).toBe(before)

  // Off: the list stays, the muted line shows, and a turn does not read the articles.
  await openKnowledge(page)
  await page.getByTestId("knowledge-enabled").click()
  await expect(page.getByTestId("knowledge-off")).toHaveText("Knowledge is off for this agent.")
  await expect(page.getByTestId("knowledge-item")).toHaveCount(1)
  await shot(page, "s18-09-off")
  await closeProfile(page)
  const readsOff = await page.getByTestId("knowledge-read-card").count()
  await send(page, "What do you know about the quarterly revenue growth?")
  await settled(page)
  await expect(page.getByTestId("knowledge-read-card")).toHaveCount(readsOff)
  const lastChat = [...mock.requests].reverse().find((r) => r.path === "/v1/chat/completions")
    ?.body as {
    tools?: { function: { name: string } }[]
    messages: { role: string; content: string }[]
  }
  expect(lastChat.tools?.map((t) => t.function.name)).not.toContain("read_article")
  expect(lastChat.messages[0]?.content).not.toContain("Quarterly revenue")
  await openKnowledge(page)
  await page.getByTestId("knowledge-enabled").click()
  await expect(page.getByTestId("knowledge-off")).toHaveCount(0)
  await closeProfile(page)

  // Export: the archive holds the articles and the sources, and no key.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-data").click()
  await page.getByTestId("data-export").click()
  await expect(page.getByTestId("data-note")).toContainText(archive)
  await page.getByTestId("settings-close").click()
  const entries = unzipSync(readFileSync(archive))
  const names = Object.keys(entries).filter((n) => n.startsWith("knowledge/"))
  expect(names.some((n) => n.endsWith("/Quarterly revenue.md"))).toBe(true)
  expect(names.some((n) => n.endsWith("/sources/report.txt"))).toBe(true)
  const source = Object.entries(entries).find(([n]) => n.endsWith("/sources/report.txt"))
  expect(Buffer.from(source?.[1] ?? []).toString()).toBe("Revenue grew 4 percent in the quarter.")
  for (const data of Object.values(entries))
    expect(Buffer.from(data).includes(GOOD_KEY)).toBe(false)

  // Over the limit: with 500 articles the page says so, and a user cannot add more.
  for (let i = 0; i < 499; i++)
    writeFileSync(join(folder, `n${i}.md`), `---\ntitle: Note ${i}\nsummary: filler\n---\n\nx\n`)
  await openKnowledge(page)
  await expect(page.getByTestId("knowledge-count")).toContainText("500 of 500 articles", {
    timeout: 15_000,
  })
  await expect(page.getByTestId("knowledge-full")).toContainText("The limit of 500 articles")
  await expect(page.getByTestId("knowledge-add")).toBeDisabled()
  await shot(page, "s18-10-full")
  await closeProfile(page)
  await app.close()

  // After a restart, the files are the truth: the articles are there. In Korean, too.
  ;({ app, page } = await launch(userData, { ...env, ROBOT_SYSTEM_LOCALE: "ko-KR" }))
  await resizeWindow(app, 1360, 900)
  await page.getByTestId("chat-header-agent").click()
  await page.getByTestId("profile-tabs").getByText("지식").click()
  await expect(page.getByTestId("knowledge-count")).toContainText("글 500개 / 최대 500개")
  await page.getByTestId("knowledge-search").fill("Quarterly")
  await page.getByTestId("knowledge-item").click()
  await expect(page.getByTestId("knowledge-article-title")).toHaveText("Quarterly revenue")
  await expect(page.getByTestId("knowledge-updated")).toContainText("마지막으로")
  await expect(page.getByTestId("knowledge-check")).toHaveText("지식 점검")
  await shot(page, "s18-11-korean")
  await app.close()
})

test("knowledge: the first save in a workspace that the user chose asks first", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const chosen = mkdtempSync(join(tmpdir(), "robot-s18-chosen-"))
  const userData = freshUserData()
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_PICK_FOLDER: chosen,
  })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  // The folder for new workspaces is the user's choice, not the default.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-workspace-root").getByRole("button").last().click()
  await expect(page.getByTestId("setting-workspace-root")).toContainText(chosen)
  await page.getByTestId("settings-close").click()
  await createAgent(page, "Bo")
  await send(
    page,
    `TOOL write_article ${JSON.stringify({ title: "Alpha", summary: "a", body: "First." })}`,
  )
  await expect(page.getByTestId("ask-card")).toContainText("Knowledge", { timeout: 15_000 })
  await expect(page.getByTestId("ask-card")).toContainText(chosen)
  await shot(page, "s18-12-first-save-asks")
  await page.getByTestId("ask-allow").click()
  await settled(page)
  const [agentDir] = readdirSync(chosen)
  expect(existsSync(join(chosen, agentDir ?? "", "Knowledge", "Alpha.md"))).toBe(true)
  // The folder exists now: a second article asks nothing.
  await send(
    page,
    `TOOL write_article ${JSON.stringify({ title: "Beta", summary: "b", body: "Second." })}`,
  )
  await settled(page)
  await expect(page.getByTestId("ask-card")).toHaveCount(0)
  await expect(page.getByTestId("knowledge-line").last()).toContainText("Updated article: Beta")
  mkdirSync(chosen, { recursive: true })
  await app.close()
})
