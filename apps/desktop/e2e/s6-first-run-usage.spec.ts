import { expect, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const guide = { ROBOT_SYSTEM_LOCALE: "en-US", ROBOT_SKIP_FIRST_RUN: "" }

test("first start: language, theme, account and first agent, then a reply", async () => {
  test.setTimeout(90_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  let { app, page } = await launch(userData, guide)
  await resizeWindow(app, 1200, 860)

  // Step 1: language and theme apply at once. The box does not close on Escape.
  const box = page.getByTestId("first-run")
  await expect(box).toBeVisible()
  await expect(page.getByTestId("first-run-step")).toHaveText("Step 1 of 3")
  await page.keyboard.press("Escape")
  await expect(box).toBeVisible()
  await shot(page, "s6-01-first-run-look")
  await page.getByTestId("first-run-language").locator('label[data-value="ko"]').click()
  await expect(page.getByTestId("first-run-step")).toHaveText("3단계 중 1단계")
  await expect(box).toContainText("ROBot에 오신 것을 환영해요")
  await shot(page, "s6-02-first-run-korean")
  await page.getByTestId("first-run-language").locator('label[data-value="en"]').click()
  await expect(page.getByTestId("first-run-step")).toHaveText("Step 1 of 3")
  await page.getByTestId("first-run-theme").locator('label[data-value="light"]').click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await page.getByTestId("first-run-next").click()

  // Step 2: a wrong key is refused. The right key connects.
  await expect(page.getByTestId("first-run-account")).toBeVisible()
  await page.getByTestId("provider-kind").selectOption("openai")
  await page.getByTestId("provider-name").fill("Mock")
  await page.getByTestId("provider-base-url").fill(mock.openaiUrl)
  await page.getByTestId("provider-api-key").fill("sk-wrong")
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-error")).toBeVisible()
  await page.getByTestId("provider-api-key").fill(GOOD_KEY)
  await page.getByTestId("provider-submit").click()

  // Step 3: the first agent.
  await expect(page.getByTestId("first-run-step")).toHaveText("Step 3 of 3")
  await page.getByTestId("agent-name").fill("Ada")
  await page.getByTestId("model-model").waitFor()
  await shot(page, "s6-03-first-run-agent")
  await page.getByTestId("agent-submit").click()
  await expect(box).toHaveCount(0)
  await expect(page.getByTestId("chat-start")).toContainText("Ada")

  // The first reply streams in.
  await page.getByTestId("composer-input").fill("hello")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.locator("[data-testid=message][data-author=agent]").first()).toContainText(
    "You said: hello",
  )
  await shot(page, "s6-04-first-reply")

  // The guide does not return after a restart.
  await app.close()
  ;({ app, page } = await launch(userData, guide))
  await expect(page.getByTestId("app-root")).toBeVisible()
  await expect(page.getByTestId("first-run")).toHaveCount(0)
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await app.close()
  await mock.close()
})

test("first start: skipping the guide ends it for good", async () => {
  const userData = freshUserData()
  let { app, page } = await launch(userData, guide)
  await expect(page.getByTestId("first-run")).toBeVisible()
  await page.getByTestId("first-run-skip").click()
  await expect(page.getByTestId("first-run")).toHaveCount(0)
  await expect(page.getByTestId("no-place")).toBeVisible()
  await app.close()
  ;({ app, page } = await launch(userData, guide))
  await expect(page.getByTestId("app-root")).toBeVisible()
  await expect(page.getByTestId("first-run")).toHaveCount(0)
  await app.close()
})

test("first start: a data folder that has an agent skips the guide", async () => {
  const userData = freshUserData()
  let { app, page } = await launch(userData)
  await page.getByTestId("new-agent").click()
  await page.getByTestId("agent-name").fill("Ada")
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("chat-start")).toContainText("Ada")
  await app.close()
  ;({ app, page } = await launch(userData, guide))
  await expect(page.getByTestId("app-root")).toBeVisible()
  await expect(page.getByTestId("first-run")).toHaveCount(0)
  await app.close()
})

test("usage: tokens per agent and day, for the period", async () => {
  test.setTimeout(90_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1200, 860)

  await page.getByTestId("page-usage").click()
  await expect(page.getByTestId("usage-empty")).toBeVisible()
  await shot(page, "s6-05-usage-empty")

  await page.getByTestId("page-chats").click()
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-add").click()
  await page.getByTestId("provider-kind").selectOption("openai")
  await page.getByTestId("provider-base-url").fill(mock.openaiUrl)
  await page.getByTestId("provider-api-key").fill(GOOD_KEY)
  await page.getByTestId("provider-submit").click()
  await page.getByTestId("provider-status").last().waitFor()
  await page.getByTestId("settings-close").click()

  for (const name of ["Ada", "Bo"]) {
    await page.getByTestId("new-agent").click()
    await page.getByTestId("agent-name").fill(name)
    await page.getByTestId("model-model").waitFor()
    await page.getByTestId("agent-submit").click()
    await expect(page.getByTestId("chat-start")).toContainText(name)
    const replies = name === "Ada" ? 2 : 1
    for (let i = 0; i < replies; i++) {
      await page.getByTestId("composer-input").fill(`hello ${i}`)
      await page.getByTestId("composer-input").press("Enter")
      await expect(page.locator("[data-testid=message][data-author=agent]")).toHaveCount(i + 1)
      await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)
    }
  }

  // The mock reports 20 input and 10 output tokens for every reply: 3 replies in total.
  await page.getByTestId("page-usage").click()
  await expect(page.getByTestId("usage-total-replies")).toHaveText("3")
  await expect(page.getByTestId("usage-total-input")).toHaveText("60")
  await expect(page.getByTestId("usage-total-output")).toHaveText("30")
  const rows = page.getByTestId("usage-agent-row")
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText("Ada")
  await expect(rows.first()).toContainText("40")
  await expect(rows.last()).toContainText("Bo")
  await expect(page.getByTestId("usage-day")).toHaveCount(1)
  await shot(page, "s6-06-usage")

  // Another period, and Korean.
  await page.getByTestId("usage-range").locator('label[data-value="30"]').click()
  await expect(page.getByTestId("usage-total-replies")).toHaveText("3")
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("usage-page")).toContainText("에이전트별")
  await shot(page, "s6-07-usage-korean")
  await app.close()
  await mock.close()
})
