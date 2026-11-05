import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// Manage tools (spec 036): the main agent asks the user to make an agent. The call shows a card
// with the whole change, nothing is made before the user allows it, and the new agent shows
// "Made by <main agent>" in its profile.

const INSTRUCTIONS = `Read the diff first. ${"Check every line. ".repeat(40)}Then write one verdict.`

const tools = (...calls: { name: string; args: unknown }[]) => `TOOLS ${JSON.stringify(calls)}`
const makeRita = {
  name: "make_agent",
  args: { name: "Rita", role: "Reviewer", instructions: INSTRUCTIONS, model: "o3-mini" },
}

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })

test("manage tools: the main agent asks to make an agent, Deny makes none, Allow makes it with the mark", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_MAIN_AGENT: "Max",
  })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Max")
  const serverId = (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find(
    (s) => s.kind === "local",
  )?.id as string
  const agents = () =>
    rpc<{ name: string; madeBy?: string | null }[]>(page, "agents.list", {
      serverId,
      archived: false,
    })

  // The card shows the whole change, with Allow and Deny only.
  await send(page, tools(makeRita))
  const card = page.getByTestId("ask-card")
  await expect(card).toContainText('Make the agent "Rita"', { timeout: 15_000 })
  await expect(card).toContainText("Reviewer")
  await expect(card).toContainText(INSTRUCTIONS)
  await expect(page.getByTestId("ask-allow")).toBeVisible()
  await expect(page.getByTestId("ask-deny")).toBeVisible()
  await expect(page.getByTestId("ask-always")).toHaveCount(0)
  expect((await agents()).map((a) => a.name)).toEqual(["Max"])
  await shot(page, "s126-01-request-card")

  // Deny: no agent.
  await page.getByTestId("ask-deny").click()
  await settled(page)
  expect((await agents()).map((a) => a.name)).toEqual(["Max"])

  // Allow: the agent exists and is marked.
  await send(page, tools(makeRita))
  await expect(card).toContainText('Make the agent "Rita"', { timeout: 15_000 })
  await page.getByTestId("ask-allow").click()
  await settled(page)
  const made = (await agents()).find((a) => a.name === "Rita")
  expect(made?.madeBy).toBe("Max")

  // The profile of the new agent says who made it. The line stays; the user's own agents have none.
  await page.locator("[data-place-row]").filter({ hasText: /^Rita/ }).click()
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await expect(page.getByTestId("agent-made-by")).toHaveText("Made by Max")
  await expect(page.getByTestId("agent-instructions")).toHaveValue(INSTRUCTIONS)
  await shot(page, "s126-02-made-by")

  await app.close()
  await mock.close()
})
