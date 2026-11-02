import { expect, type Page, test } from "@playwright/test"
import { makeFakeRuntimes } from "./fake-runtimes.ts"
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

const addMemory = async (page: Page, text: string) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page.getByTestId("memory-input").fill(text)
  await page.getByTestId("memory-add").click()
  await page.getByTestId("agent-submit").click()
}

test("Claude Code gets the chat as blocks that stay the same from turn to turn, and the memory with the message", async () => {
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
  })
  await resizeWindow(app, 1300, 900)

  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-add").click()
  await expect(page.getByTestId("provider-kind")).toHaveValue("claude_code")
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Connected")
  await page.getByTestId("settings-close").click()
  await createAgent(page, "Ada")

  await addMemory(page, "Likes green tea")
  await send(page, "first")
  await settled(page)
  await addMemory(page, "Lives in Busan")
  await send(page, "second")
  await settled(page)
  await send(page, "third")
  await settled(page)
  await expect(page.getByTestId("message").last()).toContainText("Echo: third")

  const calls = fake.claudeCalls().filter((c) => "blocks" in c) as {
    args: string[]
    blocks: string[]
  }[]
  expect(calls).toHaveLength(3)
  const [one, two, three] = calls as [(typeof calls)[0], (typeof calls)[0], (typeof calls)[0]]
  const system = (c: (typeof calls)[0]) => c.args[c.args.indexOf("--append-system-prompt") + 1]

  // The instructions come first in the request, so they do not change from turn to turn, and
  // they do not hold the memory.
  expect(system(two)).toBe(system(one))
  expect(system(three)).toBe(system(one))
  expect(system(one)).not.toContain("Likes green tea")

  // Each message is a block. The blocks of a turn begin with the blocks of the turn before, so
  // the model can read them from its cache.
  expect(one.blocks[1]).toContain("User: first")
  expect(one.blocks[1]).toContain("- Likes green tea")
  expect(two.blocks.slice(0, one.blocks.length)).toEqual(one.blocks)
  expect(three.blocks.slice(0, two.blocks.length)).toEqual(two.blocks)

  // The memory of a later turn comes with that message only. The earlier message keeps the
  // notes that it had.
  expect(two.blocks.at(-1)).toContain("- Lives in Busan")
  expect(one.blocks[1]).not.toContain("Lives in Busan")
  expect(two.blocks[1]).toBe(one.blocks[1])

  // The page shows what the user wrote, and not the notes.
  await expect(page.getByTestId("message").first()).toContainText("first")
  await expect(page.getByTestId("message").first()).not.toContainText("Notes from the app")
  await shot(page, "claude-cache-blocks")
  await app.close()
})
