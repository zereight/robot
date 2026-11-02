import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 008, memory control, as one computer shows it: the choice "Save at once" or "Ask me first",
// the tabs Items, Proposals and History, undo, and what the memory tool refuses. The lines for a
// linked device and for the other computer of a sync pair are plain text; they need two
// computers, so the unit tests of the link and of sync cover them.

const AGENT_MESSAGES = "[data-testid=message][data-author=agent]"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
/** Sends a message and waits until the agent has answered it. */
const say = async (page: Page, text: string) => {
  const before = await page.locator(AGENT_MESSAGES).count()
  await send(page, text)
  await expect(page.locator(AGENT_MESSAGES)).toHaveCount(before + 1, { timeout: 15_000 })
  await settled(page)
}
const save = (text: string) => `TOOL save_memory ${JSON.stringify({ text })}`

const openMemory = async (page: Page) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("memory-panel")).toBeVisible()
}
const closeProfile = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
}
const tab = (page: Page, name: string) => page.getByTestId("memory-tabs").getByText(name)
const rows = (page: Page) => page.getByTestId("memory-history-row")
const item = (page: Page, text: string) => page.getByTestId("memory-item").filter({ hasText: text })

const allowedLatin = new Set(["ROBot"])
/** Latin words in a part of the screen that holds no text of the user. */
const latinWords = async (page: Page, selector: string) => {
  const text = await page.locator(selector).evaluate((el) => el.textContent ?? "")
  return (text.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !allowedLatin.has(w))
}

test("memory control: save at once, ask first, proposals, history and undo, refusals, memory off", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1360, 1000)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  /** What the last request to the model carried. */
  const lastRequest = () => {
    const chat = mock.requests.filter((r) => r.path === "/v1/chat/completions")
    return chat.at(-1)?.body as {
      messages: { role: string; content: string }[]
      tools?: { function?: { name?: string } }[]
    }
  }
  const lastSystem = () => String(lastRequest().messages[0]?.content ?? "")
  const lastTools = () => (lastRequest().tools ?? []).map((t) => t.function?.name)

  // ---- Save at once (the default): a muted line with Undo, and the next turn uses the fact.
  await say(page, save("Likes green tea"))
  await expect(page.getByTestId("memory-saved-line")).toContainText("Saved to memory")
  await expect(page.getByTestId("memory-undo")).toBeVisible()
  await shot(page, "s49-01-saved-line")
  await say(page, "Which tea do I like?")
  expect(lastSystem()).toContain("What you remember:\n- Likes green tea")

  // The panel: the choice is "Save at once", and no tab for proposals shows.
  await openMemory(page)
  await expect(page.getByTestId("memory-mode")).toContainText("Save at once")
  await expect(page.getByTestId("memory-mode").locator("input:checked")).toHaveAttribute(
    "value",
    "now",
  )
  await expect(page.getByTestId("memory-tabs")).not.toContainText("Proposals")
  await expect(item(page, "Likes green tea")).toHaveCount(1)
  await shot(page, "s49-02-memory-items")

  // Delete the item: the next turn does not use it. The line in the chat cannot undo any more.
  await item(page, "Likes green tea").getByTestId("memory-delete").click()
  await expect(page.getByTestId("memory-item")).toHaveCount(0)
  await closeProfile(page)
  await say(page, "Which tea do I like now?")
  expect(lastSystem()).not.toContain("Likes green tea")
  await expect(page.getByTestId("memory-saved-line").first()).toContainText(
    "A newer change exists. Undo that one first.",
  )
  await expect(page.getByTestId("memory-undo")).toHaveCount(0)

  // ---- The control in the chat does what Undo in History does.
  await say(page, save("Lives in Busan"))
  await page.getByTestId("memory-undo").click()
  await expect(page.getByTestId("memory-undone")).toBeVisible()
  await openMemory(page)
  await expect(page.getByTestId("memory-item")).toHaveCount(0)
  await tab(page, "History").click()
  // Newest first: the undo, then the save, then what happened before.
  await expect(rows(page).first()).toHaveAttribute("data-actor", "undo")
  await expect(rows(page).first()).toHaveAttribute("data-kind", "deleted")
  await expect(rows(page).first()).toContainText("Lives in Busan")
  // Undo of that undo puts the item back.
  await rows(page).first().getByTestId("memory-history-undo").click()
  await tab(page, "Items").click()
  await expect(item(page, "Lives in Busan")).toHaveCount(1)
  await item(page, "Lives in Busan").getByTestId("memory-delete").click()
  await expect(page.getByTestId("memory-item")).toHaveCount(0)
  await closeProfile(page)

  // ---- Ask me first: the agent suggests, the user decides.
  await openMemory(page)
  await page.getByTestId("memory-mode").getByText("Ask me first").click()
  await expect(page.getByTestId("memory-mode-hint")).toContainText("only suggests")
  await expect(page.getByTestId("memory-tabs")).toContainText("Proposals")
  await closeProfile(page)
  await say(page, save("Prefers short answers"))
  await expect(page.getByTestId("memory-suggested-line")).toContainText("Suggested for memory")
  await shot(page, "s49-03-suggested-line")
  // The link opens the memory page on the tab Proposals.
  await page.getByTestId("memory-open").click()
  await expect(page.getByTestId("memory-proposal")).toHaveCount(1)
  await expect(page.getByTestId("memory-proposal")).toContainText("Prefers short answers")
  await expect(page.getByTestId("memory-proposal")).toContainText("From Ada")
  await shot(page, "s49-04-proposals")
  // No new item, and no history row for a proposal.
  await tab(page, "Items").click()
  await expect(page.getByTestId("memory-item")).toHaveCount(0)
  await tab(page, "History").click()
  const rowsBefore = await rows(page).count()
  await tab(page, "Proposals").click()
  // Save: the item shows in Items, and History has a row "added" by a suggestion that was accepted.
  await page.getByTestId("proposal-save").click()
  await expect(page.getByTestId("memory-proposal")).toHaveCount(0)
  await expect(page.getByTestId("memory-proposals-empty")).toBeVisible()
  await tab(page, "Items").click()
  await expect(item(page, "Prefers short answers")).toHaveCount(1)
  await expect(item(page, "Prefers short answers")).toContainText("Suggestion")
  await tab(page, "History").click()
  await expect(rows(page)).toHaveCount(rowsBefore + 1)
  await expect(rows(page).first()).toHaveAttribute("data-actor", "proposal")
  await expect(rows(page).first()).toHaveAttribute("data-kind", "added")
  await expect(rows(page).first()).toContainText("A suggestion that you accepted")
  await shot(page, "s49-05-history")
  await closeProfile(page)
  await say(page, "Please answer in short.")
  expect(lastSystem()).toContain("- Prefers short answers")

  // Dismiss: the proposal leaves, and no item and no history row is made.
  await say(page, save("Plays chess"))
  await openMemory(page)
  await tab(page, "History").click()
  const rowsKept = await rows(page).count()
  await tab(page, "Proposals").click()
  await expect(page.getByTestId("memory-proposal")).toHaveCount(1)
  await page.getByTestId("proposal-dismiss").click()
  await expect(page.getByTestId("memory-proposal")).toHaveCount(0)
  await tab(page, "Items").click()
  await expect(page.getByTestId("memory-item")).toHaveCount(1)
  await tab(page, "History").click()
  await expect(rows(page)).toHaveCount(rowsKept)
  await closeProfile(page)

  // Edit and save: the item has the text that the user typed.
  await say(page, save("Likes tea"))
  await openMemory(page)
  await tab(page, "Proposals").click()
  await page.getByTestId("proposal-edit").click()
  await page.getByTestId("proposal-edit-input").fill("Likes black tea")
  await page.getByTestId("proposal-save-edited").click()
  await tab(page, "Items").click()
  await expect(item(page, "Likes black tea")).toHaveCount(1)
  await closeProfile(page)

  // The same fact again: it is a known fact, and nothing is added (spaces and case do not count).
  await say(page, save("Likes tea"))
  await say(page, save("Likes tea"))
  await say(page, save("  likes TEA "))
  await openMemory(page)
  await tab(page, "Proposals").click()
  await expect(page.getByTestId("memory-proposal")).toHaveCount(1)
  await expect(page.getByTestId("memory-proposal")).toContainText("Likes tea")
  await page.getByTestId("proposal-dismiss").click()
  await closeProfile(page)
  await expect(page.locator(AGENT_MESSAGES).last()).toContainText("Tool said: This fact is")

  // 21 proposals leave 20, and the oldest is gone.
  const many = Array.from({ length: 21 }, (_, i) => ({
    name: "save_memory",
    args: { text: `Fact number ${i + 1}` },
  }))
  await say(page, `TOOLS ${JSON.stringify(many)}`)
  await openMemory(page)
  await tab(page, "Proposals").click()
  await expect(page.getByTestId("memory-proposal")).toHaveCount(20)
  await expect(page.getByTestId("memory-tabs")).toContainText("Proposals (20)")
  await expect(page.getByTestId("memory-proposal").first()).toContainText(/Fact number 2(?!\d)/)
  await expect(page.getByTestId("memory-proposal").last()).toContainText("Fact number 21")
  await expect(page.getByTestId("memory-panel")).not.toContainText(/Fact number 1(?!\d)/)
  await shot(page, "s49-06-twenty-proposals")
  // A change of the choice leaves the proposals as they are.
  await page.getByTestId("memory-mode").getByText("Save at once").click()
  await expect(page.getByTestId("memory-proposal")).toHaveCount(20)
  while ((await page.getByTestId("memory-proposal").count()) > 0)
    await page.getByTestId("proposal-dismiss").first().click()
  // With no proposal and the choice "Save at once", the tab goes away.
  await expect(page.getByTestId("memory-tabs")).not.toContainText("Proposals")
  await closeProfile(page)

  // ---- What the memory tool refuses.
  await say(page, save("The key is sk-abcdefghijklmnop1234"))
  await expect(page.locator(AGENT_MESSAGES).last()).toContainText("looks like a secret")
  await say(page, save("x".repeat(501)))
  await expect(page.locator(AGENT_MESSAGES).last()).toContainText("500 characters")
  await openMemory(page)
  await expect(item(page, "sk-abc")).toHaveCount(0)
  await expect(page.getByTestId("memory-item")).toHaveCount(2)
  await closeProfile(page)

  // ---- Edit an item twice, then undo in the order of the spec.
  await openMemory(page)
  await page.getByTestId("memory-input").fill("Alpha")
  await page.getByTestId("memory-add").click()
  const edit = async (from: string, to: string) => {
    await item(page, from).getByTestId("memory-edit").click()
    await page.getByTestId("memory-edit-input").fill(to)
    await page.getByTestId("memory-save").click()
    await expect(item(page, to)).toHaveCount(1)
  }
  await edit("Alpha", "Beta")
  await edit("Beta", "Gamma")
  await tab(page, "History").click()
  // Newest first: second edit, first edit, add. The first edit cannot be undone now.
  await expect(rows(page).nth(1).getByTestId("memory-history-undo")).toBeDisabled()
  await expect(rows(page).nth(1).getByTestId("memory-history-reason")).toHaveText(
    "A newer change exists. Undo that one first.",
  )
  await expect(rows(page).nth(0).getByTestId("memory-history-undo")).toBeEnabled()
  await shot(page, "s49-07-undo-off")
  // Undo the second edit, then the first: the item has the text from before the first edit.
  await rows(page).nth(0).getByTestId("memory-history-undo").click()
  await tab(page, "Items").click()
  await expect(item(page, "Beta")).toHaveCount(1)
  await tab(page, "History").click()
  await expect(rows(page).nth(0)).toHaveAttribute("data-actor", "undo")
  await rows(page).nth(2).getByTestId("memory-history-undo").click()
  await tab(page, "Items").click()
  await expect(item(page, "Alpha")).toHaveCount(1)
  // Undo the last undo: the item has the text of the first edit again.
  await tab(page, "History").click()
  await expect(rows(page).nth(0)).toHaveAttribute("data-actor", "undo")
  await rows(page).nth(0).getByTestId("memory-history-undo").click()
  await tab(page, "Items").click()
  await expect(item(page, "Beta")).toHaveCount(1)

  // ---- Delete an item, then Undo on its row: the item is back with its text.
  await item(page, "Beta").getByTestId("memory-delete").click()
  await expect(item(page, "Beta")).toHaveCount(0)
  await tab(page, "History").click()
  await expect(rows(page).first()).toHaveAttribute("data-kind", "deleted")
  await rows(page).first().getByTestId("memory-history-undo").click()
  await tab(page, "Items").click()
  await expect(item(page, "Beta")).toHaveCount(1)

  // ---- A text that looks like a secret, typed by hand: it is allowed, and History hides it.
  await page.getByTestId("memory-input").fill("My token is sk-abcdefghijklmnop1234")
  await page.getByTestId("memory-add").click()
  await expect(item(page, "sk-abcdefghijklmnop1234")).toHaveCount(1)
  await tab(page, "History").click()
  await expect(rows(page).first()).toContainText("[redacted]")
  await expect(rows(page).first()).not.toContainText("sk-abc")
  await expect(rows(page).first().getByTestId("memory-history-undo")).toHaveCount(0)
  await tab(page, "Items").click()
  await item(page, "sk-abcdefghijklmnop1234").getByTestId("memory-delete").click()
  await closeProfile(page)

  // ---- Memory off: the agent has no memory tool, the items stay, and the user can still change them.
  await openMemory(page)
  await page.getByTestId("agent-memory-enabled").click()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  await say(page, "Hello again")
  expect(lastTools()).not.toContain("save_memory")
  expect(lastTools().length).toBeGreaterThan(0)
  await say(page, save("Should not be kept"))
  await expect(page.locator(AGENT_MESSAGES).last()).toContainText("memory is off")
  await openMemory(page)
  await expect(page.getByTestId("memory-item").first()).toBeVisible()
  await expect(item(page, "Should not be kept")).toHaveCount(0)
  await page.getByTestId("memory-input").fill("Typed with memory off")
  await page.getByTestId("memory-add").click()
  await expect(item(page, "Typed with memory off")).toHaveCount(1)
  await page.getByTestId("agent-memory-enabled").click()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)

  // ---- The same screens in Korean: no English is left in the labels.
  await app.close()
  ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" }))
  await resizeWindow(app, 1360, 1000)
  await page.getByText("Ada").first().click()
  await say(page, save("Hello"))
  await expect(page.getByTestId("memory-saved-line").last()).toContainText("메모리에 저장했어요")
  expect(await latinWords(page, "[data-testid=memory-saved-line] >> nth=-1")).toEqual([])
  await openMemory(page)
  await expect(page.getByTestId("memory-mode")).toContainText("바로 저장")
  await expect(page.getByTestId("memory-mode")).toContainText("먼저 물어보기")
  await expect(page.getByTestId("memory-tabs")).toContainText("항목")
  await expect(page.getByTestId("memory-tabs")).toContainText("기록")
  await page.getByTestId("memory-mode").getByText("먼저 물어보기").click()
  await expect(page.getByTestId("memory-tabs")).toContainText("제안")
  for (const selector of [
    "[data-testid=memory-mode]",
    "[data-testid=memory-mode-hint]",
    "[data-testid=memory-tabs]",
  ]) {
    expect(await latinWords(page, selector), selector).toEqual([])
  }
  await tab(page, "제안").click()
  await expect(page.getByTestId("memory-proposals-empty")).toContainText("제안이 없어요")
  await tab(page, "기록").click()
  await expect(rows(page).first()).toContainText("에이전트")
  await shot(page, "s49-08-korean")
  await app.close()
})
