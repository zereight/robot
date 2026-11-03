import { expect, type Page, test } from "@playwright/test"
import { createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const connectAnthropic = async (page: Page, baseUrl: string) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-add").click()
  await page.getByTestId("provider-kind").selectOption("anthropic")
  await page.getByTestId("provider-base-url").fill(baseUrl)
  await page.getByTestId("provider-api-key").fill(GOOD_KEY)
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Connected")
  await page.getByTestId("settings-close").click()
}

/** Sends a message and waits until the reply number `reply` has arrived. */
const ask = async (page: Page, text: string, reply: number) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.locator("[data-testid=message][data-author=agent]")).toHaveCount(reply)
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)
}

test("prompt cache: a chat turn asks for 1 hour where the host takes the marker, and the usage counts the cached input", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  // The stand-in provider is not the official host. A test run may name it as a host that takes the
  // marker, as the official host does.
  let { app, page } = await launch(userData, { ...env, ROBOT_TEST_CACHE_HOST: "127.0.0.1" })
  await resizeWindow(app, 1200, 800)
  await connectAnthropic(page, mock.anthropicUrl)
  await createAgent(page, "Ada")

  // A turn that the person starts in the chat asks for the 1 hour lifetime, once, on the top level.
  await ask(page, "hello cache", 1)
  const messages = () =>
    mock.requests
      .filter((r) => r.method === "POST" && r.path === "/anthropic/v1/messages")
      .map((r) => r.body as Record<string, unknown>)
  expect(messages()).toHaveLength(1)
  expect(messages()[0]?.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
  expect(JSON.stringify(messages()[0]?.messages)).not.toContain("cache_control")

  // The stand-in reports 4 new, 6 written and 10 read input tokens, as the real API does with the
  // marker. The usage page counts all of them as input.
  await page.getByTestId("page-usage").click()
  await expect(page.getByTestId("usage-total-replies")).toHaveText("1")
  await expect(page.getByTestId("usage-total-input")).toHaveText("20")
  await expect(page.getByTestId("usage-total-output")).toHaveText("10")
  await shot(page, "prompt-cache-usage")

  // The same account on a host that does not take the marker (the app starts with no test host):
  // the request has no marker, so a proxy that refuses an unknown field still works.
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1200, 800)
  await page.getByTestId("page-chats").click()
  await ask(page, "hello again", 2)
  expect(messages()).toHaveLength(2)
  expect("cache_control" in (messages()[1] ?? {})).toBe(false)
  expect(messages()[1]?.model).toBe(messages()[0]?.model)

  // The second reply has no cached input: 20 new tokens. The page adds it to the 20 before.
  await page.getByTestId("page-usage").click()
  await expect(page.getByTestId("usage-total-replies")).toHaveText("2")
  await expect(page.getByTestId("usage-total-input")).toHaveText("40")

  await app.close()
  await mock.close()
})
