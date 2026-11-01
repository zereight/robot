import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const messages = (page: Page) => page.getByTestId("message")
const agentMessages = (page: Page) => page.locator("[data-testid=message][data-author=agent]")
const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)

test("chat: send, stream, stop, queue, markdown, retry, reply, edit, restart", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await expect(page.getByTestId("chat-header-model")).toHaveText("mock-fast")

  // Send: the message shows at once and the reply streams in.
  await send(page, "hello")
  await expect(messages(page).first()).toContainText("hello")
  await expect(agentMessages(page).first()).toContainText("You said: hello")
  await expect(agentMessages(page).first()).toContainText("BOT")
  await expect(page.getByTestId("composer-input")).toHaveValue("")
  await settled(page)

  // Stop mid-reply: the partial reply stays and is marked stopped.
  await send(page, "please go slow")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await expect(page.getByTestId("working-line")).toBeVisible()
  await expect(agentMessages(page).nth(1)).toContainText("word3")
  await shot(page, "s5-01-streaming")
  await page.getByTestId("composer-stop").click()
  await expect(agentMessages(page).nth(1)).toHaveAttribute("data-status", "stopped")
  await expect(agentMessages(page).nth(1).getByTestId("stopped-mark")).toBeVisible()
  await expect(agentMessages(page).nth(1)).not.toContainText("word59")
  await expect(page.getByTestId("composer-send")).toBeVisible()

  // Send again works.
  await send(page, "again")
  await expect(agentMessages(page).nth(2)).toContainText("You said: again")
  await settled(page)

  // Queue: a message sent while the agent works waits, can be edited, and goes when the turn ends.
  await send(page, "slow once more")
  await expect(page.getByTestId("composer-stop")).toBeVisible()
  await send(page, "queued one")
  await expect(page.getByTestId("queued")).toContainText("queued one")
  await page.getByTestId("queued-edit").click()
  await page.getByTestId("queued-input").fill("queued and edited")
  await page.getByTestId("queued-input").press("Enter")
  await expect(page.getByTestId("queued")).toContainText("queued and edited")
  await shot(page, "s5-02-queue")
  await expect(page.getByTestId("queued")).toHaveCount(0, { timeout: 10_000 })
  await expect(agentMessages(page).last()).toContainText("You said: queued and edited", {
    timeout: 10_000,
  })
  await settled(page)

  // Markdown: heading, list, code block with copy, table, link; raw HTML shows as text.
  await send(page, "markdown please")
  const md = agentMessages(page).last()
  await expect(md.locator("h4")).toHaveText("Plan")
  await expect(md.locator("li")).toHaveText(["first step", "second step"])
  await expect(md.locator("pre code")).toHaveText("const answer = 42")
  await expect(md.getByTestId("code-copy")).toBeVisible()
  await expect(md.locator("table td")).toHaveText(["a", "1"])
  await expect(md.locator("a")).toHaveAttribute("href", "https://example.com/docs")
  await expect(md.locator("b")).toHaveCount(0)
  await expect(md).toContainText("<b>raw html</b>")
  await settled(page)
  await shot(page, "s5-03-markdown")

  // Thinking folds into one line that opens.
  await send(page, "think about it")
  const thinking = agentMessages(page).last().getByTestId("thinking")
  await expect(thinking.locator("summary")).toHaveText("Thought")
  await expect(thinking.locator("p")).toBeHidden()
  await thinking.locator("summary").click()
  await expect(thinking.locator("p")).toHaveText("Weighing the options.")
  await settled(page)

  // Failure: plain reason and Retry.
  await send(page, "fail once")
  await expect(page.getByTestId("failed-row")).toContainText("The provider returned an error")
  await shot(page, "s5-04-failed")
  await page.getByTestId("retry").click()
  await expect(page.getByTestId("failed-row")).toHaveCount(0)
  await expect(agentMessages(page).last()).toContainText("You said: fail once")
  await settled(page)

  // Reply: quote, link back, flash, Back.
  const firstReply = agentMessages(page).first()
  await firstReply.hover()
  await firstReply.getByTestId("action-reply").click()
  await expect(page.getByTestId("reply-quote")).toContainText("Replying to Ada")
  await send(page, "about that")
  await expect(page.getByTestId("reply-quote")).toHaveCount(0)
  const sentReply = messages(page).filter({ hasText: "about that" }).first()
  await expect(sentReply.getByTestId("reply-link")).toContainText("Reply to Ada")
  await settled(page)
  await sentReply.getByTestId("reply-link").click()
  await expect(firstReply).toHaveAttribute("data-flash", "true")
  await expect(page.getByTestId("jump-back")).toBeVisible()
  await page.getByTestId("jump-back").click()
  await expect(page.getByTestId("jump-back")).toHaveCount(0)

  // Edit the last own message: the reply is made again.
  const lastUser = page.locator("[data-testid=message][data-author=user]").last()
  await lastUser.hover()
  await lastUser.getByTestId("action-edit").click()
  await page.getByTestId("edit-input").fill("about that, changed")
  await page.getByTestId("edit-save").click()
  await expect(agentMessages(page).last()).toContainText("You said: about that, changed")
  await settled(page)

  // Scrolling up shows "Jump to latest".
  await page.getByTestId("chat-scroller").evaluate((el) => {
    el.scrollTop = 0
  })
  await expect(page.getByTestId("jump-latest")).toBeVisible()
  await page.getByTestId("jump-latest").click()
  await expect(page.getByTestId("jump-latest")).toHaveCount(0)

  // Unread: a reply that ends while another chat is open shows a badge.
  await createAgent(page, "Bea")
  await page
    .getByTestId("section-agents")
    .locator("[data-place-row]")
    .filter({ hasText: /^Ada$/ })
    .click()
  await send(page, "slow for unread")
  await page
    .getByTestId("section-agents")
    .locator("[data-place-row]")
    .filter({ hasText: /^Bea/ })
    .click()
  const adaRow = page.getByTestId("section-agents").locator("[data-place-row]").first()
  await expect(adaRow.getByTestId("working-dot")).toBeVisible()
  await expect(adaRow).toContainText("1", { timeout: 10_000 })
  await expect(adaRow).toHaveAttribute("aria-label", /Last message: word0/)
  await shot(page, "s5-05-unread")
  await adaRow.click()
  await expect(adaRow).not.toContainText("1")

  // Restart: every turn is still there, the stopped one still marked.
  const countBefore = await messages(page).count()
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1200, 860)
  await expect(messages(page)).toHaveCount(countBefore)
  await expect(page.getByTestId("stopped-mark")).toHaveCount(1)
  await shot(page, "s5-06-after-restart")

  // Disconnect: the message box gives a button to connect.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-disconnect").click()
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("composer-blocked")).toContainText("not connected")
  await page.getByTestId("composer-connect").click()
  await expect(page.getByTestId("providers-section")).toBeVisible()
  await app.close()
  await mock.close()
})
