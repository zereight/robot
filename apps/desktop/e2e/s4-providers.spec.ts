import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const createAgent = async (page: Page, name: string) => {
  await page.getByTestId("new-agent").click()
  await page.getByTestId("agent-name").fill(name)
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("chat-start")).toContainText(name)
}

/** Every file in the data folder, read as text, so a test can search it for a secret. */
const dataFolderText = (dir: string): string =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => readFileSync(join(e.parentPath, e.name)).toString("latin1"))
    .join("\n")

test("providers: connect a key, pick a model, switch, disconnect, reconnect", async () => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1200, 800)

  await createAgent(page, "Ada")
  await expect(page.getByTestId("chat-header-model")).toHaveText("No model")

  // Connect: a wrong key is refused; the right key connects.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await expect(page.getByTestId("providers-section")).toContainText("No accounts yet.")
  await page.getByTestId("provider-add").click()
  await page.getByTestId("provider-kind").selectOption("openai")
  await page.getByTestId("provider-name").fill("Mock")
  await page.getByTestId("provider-base-url").fill(mock.openaiUrl)
  await page.getByTestId("provider-api-key").fill("sk-wrong")
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-error")).toHaveText("The provider refused the key.")
  await page.getByTestId("provider-api-key").fill(GOOD_KEY)
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Connected")
  await page.getByTestId("provider-check").click()
  await expect(page.getByTestId("provider-note")).toHaveText("Connected")
  await shot(page, "s4-01-connected")

  // A second account with the Anthropic API.
  await page.getByTestId("provider-add").click()
  await page.getByTestId("provider-kind").selectOption("anthropic")
  await page.getByTestId("provider-base-url").fill(mock.anthropicUrl)
  await page.getByTestId("provider-api-key").fill(GOOD_KEY)
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText(["Connected", "Connected"])
  await page.getByTestId("settings-close").click()

  // Choose a model with an effort level.
  await page.getByTestId("chat-header-model").click()
  await page.getByTestId("model-account").selectOption({ label: "Mock" })
  await expect(page.getByTestId("model-model").locator("option")).toHaveText([
    "mock-fast",
    "o3-mini",
  ])
  await page.getByTestId("model-model").selectOption("o3-mini")
  await page.getByTestId("model-effort").selectOption("high")
  await shot(page, "s4-02-model-dialog")
  await page.getByTestId("model-save").click()
  await expect(page.getByTestId("chat-header-model")).toHaveText("o3-mini")

  // Switch to the other account; the agent keeps its identity.
  await page.getByTestId("chat-header-model").click()
  await page.getByTestId("model-account").selectOption({ label: "Anthropic" })
  // The newest models come first. Haiku 3.5 has a newer model of its family in the list, so it
  // is last, in the folded group "Older models" (spec 006).
  await expect(page.getByTestId("model-model").locator("option")).toHaveText([
    "Claude Haiku 5.5",
    "Claude Sonnet 4.5",
    "Claude Haiku 3.5",
  ])
  await expect(page.getByTestId("model-older-toggle")).toHaveText("Older models (1)")

  // A Claude model offers all five levels, up to "Max". The request carries the level.
  await page.getByTestId("model-model").selectOption("claude-haiku-5-5")
  await expect(page.getByTestId("model-effort").locator("option")).toHaveText([
    "Default",
    "Low",
    "Medium",
    "High",
    "Extra high",
    "Max",
  ])
  await page.getByTestId("model-effort").selectOption("max")
  await shot(page, "s4-04-claude-effort")
  await page.getByTestId("model-save").click()
  await expect(page.getByTestId("chat-header-model")).toHaveText("claude-haiku-5-5")
  await page.getByTestId("composer-input").fill("think about it")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("thinking")).toHaveCount(1)
  const sent = mock.requests.find((r) => r.path === "/anthropic/v1/messages")
  expect(sent?.body).toMatchObject({
    model: "claude-haiku-5-5",
    output_config: { effort: "max" },
    thinking: { type: "adaptive" },
  })
  expect(JSON.stringify(sent?.body)).not.toContain("budget_tokens")

  // A model that does not think shows no effort control.
  await page.getByTestId("chat-header-model").click()
  await page.getByTestId("model-model").selectOption("claude-3-5-haiku-latest")
  await expect(page.getByTestId("model-effort")).toHaveCount(0)

  // An older model has no effort setting but thinks with a budget: three levels, no more.
  await page.getByTestId("model-model").selectOption("claude-sonnet-4-5")
  await expect(page.getByTestId("model-effort").locator("option")).toHaveText([
    "Default",
    "Low",
    "Medium",
    "High",
  ])
  await page.getByTestId("model-effort").selectOption("medium")
  await page.getByTestId("model-save").click()
  await expect(page.getByTestId("chat-header-model")).toHaveText("claude-sonnet-4-5")
  await page.getByTestId("composer-input").fill("think again")
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("thinking")).toHaveCount(2)
  const older = mock.requests.filter((r) => r.path === "/anthropic/v1/messages").at(-1)
  expect(older?.body).toMatchObject({
    model: "claude-sonnet-4-5",
    thinking: { type: "enabled", budget_tokens: 8192 },
  })
  expect(JSON.stringify(older?.body)).not.toContain("output_config")
  await expect(page.getByTestId("chat-start")).toContainText("Ada")

  // The key is nowhere in the data folder.
  await app.close()
  expect(dataFolderText(userData)).not.toContain(GOOD_KEY)

  // After a restart the choice stays.
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1200, 800)
  await expect(page.getByTestId("chat-header-model")).toHaveText("claude-sonnet-4-5")

  // Disconnect, then connect again.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-disconnect").first().click()
  await expect(page.getByTestId("provider-status").first()).toHaveText("Not connected")
  await shot(page, "s4-03-disconnected")
  await page.getByTestId("provider-reconnect").click()
  await page.getByTestId("provider-api-key").fill(GOOD_KEY)
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status").first()).toHaveText("Connected")
  await app.close()
  await mock.close()
})
