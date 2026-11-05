import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, type RecordedRequest, startMockProvider } from "./mock-provider.ts"

// Spec 006: effort levels (None, Minimal, Ultra), the nearest level after a model change, the order
// of the picker, "Older models", the tag "New", the part "Models" with its switches, and the
// context size and output limit of a custom model (S93). The stand-in provider lists six models
// with dates; "mock-think" takes Minimal and Ultra, "mock-lite" takes Low to High, "mock-pro-2"
// takes Low and High.

// The smallest width in the range of 001 where the form still has its two columns.
const WIDTH = 760
const HEIGHT = 900

const chatRequests = (requests: readonly RecordedRequest[]) =>
  requests.filter((r) => r.path === "/v1/chat/completions")
const lastChat = (requests: readonly RecordedRequest[]) =>
  chatRequests(requests).at(-1)?.body as Record<string, unknown>
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)
const send = async (page: Page, text: string) => {
  const before = await page.locator("[data-testid=message][data-author=agent]").count()
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.locator("[data-testid=message][data-author=agent]")).toHaveCount(before + 1)
  await settled(page)
}
/** The text of the options of a select, hidden options too. */
const optionTexts = (page: Page, testId: string) =>
  page
    .getByTestId(testId)
    .locator("option")
    .evaluateAll((els) => els.map((el) => el.textContent?.trim() ?? ""))
const effortLevels = (page: Page) => optionTexts(page, "model-effort")
/** The picker in the middle of the window: the form is taller than the window. */
const shotPicker = async (page: Page, name: string) => {
  await page.getByTestId("model-picker").evaluate((el) => el.scrollIntoView({ block: "center" }))
  await shot(page, name)
}

const openSettings = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
}
const connectCustom = async (page: Page, baseUrl: string) => {
  await openSettings(page)
  await page.getByTestId("provider-add").click()
  await page.getByTestId("provider-kind").selectOption("custom")
  await page.getByTestId("provider-name").fill("Stand-in")
  await page.getByTestId("provider-base-url").fill(baseUrl)
  await page.getByTestId("provider-api-key").fill(GOOD_KEY)
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Connected")
}
const rowIds = (page: Page) =>
  page
    .locator("[data-testid^=model-row-]")
    .evaluateAll((els) =>
      els.map((el) => el.getAttribute("data-testid")?.slice("model-row-".length)),
    )
const openNewAgent = async (page: Page) => {
  await page.getByTestId("new-agent").click()
  await page.getByTestId("model-model").waitFor()
}
const closeDialog = async (page: Page, testId: string) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId(testId)).toBeHidden()
}

test("effort levels and the model list: order, older models, New, hide, nearest level, custom limits", async () => {
  test.setTimeout(300_000)
  const mock = await startMockProvider({ effortModels: true })
  const userData = freshUserData()
  let { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, WIDTH, HEIGHT)
  try {
    // 1. The part "Models": newest first, the older model of a family is marked, the first fetch
    //    tags no model, and a custom account has the two fields on every model.
    await connectCustom(page, mock.openaiUrl)
    await page.getByTestId("models-toggle").click()
    await expect(page.getByTestId("models-part")).toBeVisible()
    expect(await rowIds(page)).toEqual([
      "mock-fast",
      "mock-think",
      "mock-pro-2",
      "mock-lite",
      "mock-pro-1",
      "o3-mini",
    ])
    await expect(page.locator("[data-testid^=model-new-]")).toHaveCount(0)
    await expect(page.getByTestId("model-row-mock-pro-1")).toContainText("Older models")
    await expect(page.getByTestId("model-row-mock-pro-2")).not.toContainText("Older models")

    // The fields refuse 0 and 10,000,001. They take 32,000 and 2,000.
    const context = page.getByTestId("model-context-mock-think")
    const output = page.getByTestId("model-output-mock-think")
    await output.fill("0")
    await output.press("Tab")
    await expect(page.getByTestId("model-limit-error")).toHaveText(
      "Use a whole number from 1 to 10,000,000.",
    )
    await output.fill("10000001")
    await output.press("Tab")
    await expect(page.getByTestId("model-limit-error")).toBeVisible()
    await context.fill("32000")
    await context.press("Tab")
    await output.fill("2000")
    await output.press("Tab")
    await expect(output).toHaveValue("2000")
    await expect(context).toHaveValue("32000")
    await page.getByTestId("model-row-mock-think").scrollIntoViewIfNeeded()
    await shot(page, "s93-01-models-part-en")
    await page.getByTestId("settings-close").click()

    // 2. The picker: the search box is there for six models; the older model is folded away.
    await openNewAgent(page)
    await page.getByTestId("agent-name").fill("Ada")
    await expect(page.getByTestId("model-search")).toBeVisible()
    expect(await optionTexts(page, "model-model")).toEqual([
      "mock-fast",
      "mock-think",
      "mock-pro-2",
      "mock-lite",
      "o3-mini",
      "mock-pro-1",
    ])
    await expect(page.getByTestId("model-older-group")).toBeHidden()
    await expect(page.getByTestId("model-older-toggle")).toHaveText("Older models (1)")
    await shotPicker(page, "s93-02-picker-folded-en")
    // Typing in the search box opens the group.
    await page.getByTestId("model-search").fill("pro-1")
    await expect(page.getByTestId("model-older-group")).not.toHaveAttribute("hidden", "")
    await expect(page.getByTestId("model-older-toggle")).toHaveCount(0)
    await page.getByTestId("model-search").fill("zzz")
    await expect(page.getByTestId("model-search-none")).toBeVisible()
    await page.getByTestId("model-search").fill("")

    // 3. A model that lists Minimal and Ultra shows them; a form of a new agent starts at Medium.
    await page.getByTestId("model-model").selectOption("mock-think")
    expect(await effortLevels(page)).toEqual([
      "Default",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Ultra",
    ])
    await expect(page.getByTestId("model-effort")).toHaveValue("medium")
    // A model that lists neither shows neither.
    await page.getByTestId("model-model").selectOption("mock-lite")
    expect(await effortLevels(page)).toEqual(["Default", "Low", "Medium", "High"])
    await page.getByTestId("model-model").selectOption("mock-think")
    await page.getByTestId("model-effort").selectOption("ultra")
    await shotPicker(page, "s93-03-ultra-en")
    await page.getByTestId("agent-submit").click()
    await page.getByTestId("chat-start").filter({ hasText: "Ada" }).waitFor()
    await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })

    // 4. The turn sends the level and the output limit of the custom model. The context meter
    //    uses the context size: 28,000 of 32,000 tokens is over 85 percent.
    await send(page, "hello use 28000")
    expect(lastChat(mock.requests)).toMatchObject({
      model: "mock-think",
      reasoning_effort: "ultra",
      max_tokens: 2000,
    })
    const meter = page.getByTestId("context-meter")
    await expect(meter).toHaveAttribute("data-used", "28000")
    await expect(meter).toHaveAttribute("data-level", "high")

    // 5. Change the model: the agent keeps the level when the new model lists it, and else gets
    //    the nearest level. Ultra → High on Low..High. Medium → Low on a model with Low and High.
    await page.getByTestId("chat-header-model").click()
    await expect(page.getByTestId("model-effort")).toHaveValue("ultra")
    await page.getByTestId("model-model").selectOption("mock-lite")
    await expect(page.getByTestId("model-effort")).toHaveValue("high")
    await shot(page, "s93-04-nearest-en")
    await page.getByTestId("model-effort").selectOption("medium")
    await page.getByTestId("model-model").selectOption("mock-pro-2")
    await expect(page.getByTestId("model-effort")).toHaveValue("low")
    await page.getByTestId("model-save").click()
    await expect(page.getByTestId("chat-header-model")).toHaveText("mock-pro-2")
    await send(page, "second")
    const second = lastChat(mock.requests)
    expect(second).toMatchObject({ model: "mock-pro-2", reasoning_effort: "low" })
    // No output limit is set on this model, so the request names none.
    expect("max_tokens" in second).toBe(false)

    // 6. Turn models off. The picker leaves them out, also in its search. The agent keeps its
    //    model, which shows as "Hidden", and still answers.
    await openSettings(page)
    await page.getByTestId("models-toggle").click()
    await page.getByTestId("model-switch-mock-lite").click()
    await page.getByTestId("model-switch-mock-pro-2").click()
    await expect(page.getByTestId("model-switch-mock-lite")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await page.getByTestId("settings-close").click()
    await page.getByTestId("chat-header-model").click()
    expect(await optionTexts(page, "model-model")).toEqual([
      "mock-fast",
      "mock-think",
      "mock-pro-2 · Hidden",
      "o3-mini",
      "mock-pro-1",
    ])
    await page.getByTestId("model-search").fill("lite")
    await expect(page.getByTestId("model-search-none")).toBeVisible()
    await shot(page, "s93-05-hidden-en")
    await closeDialog(page, "model-dialog")
    await send(page, "third")
    expect(lastChat(mock.requests)).toMatchObject({ model: "mock-pro-2" })

    // "Hide all" takes every model out of the picker. "Reset" brings them back.
    await openSettings(page)
    await page.getByTestId("models-toggle").click()
    await page.getByTestId("models-hide-all").click()
    await expect(page.getByTestId("model-switch-mock-fast")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await page.getByTestId("settings-close").click()
    await openNewAgent(page)
    await expect(page.getByTestId("model-all-hidden")).toBeVisible()
    expect(await optionTexts(page, "model-model")).toEqual([])
    await closeDialog(page, "new-agent-dialog")
    await openSettings(page)
    await page.getByTestId("models-toggle").click()
    await page.getByTestId("models-reset").click()
    await expect(page.getByTestId("model-switch-mock-fast")).toHaveAttribute("aria-checked", "true")
    await expect(page.getByTestId("model-switch-mock-pro-2")).toHaveAttribute(
      "aria-checked",
      "true",
    )

    // 7. A model that a later fetch lists for the first time shows "New". Nothing else does.
    mock.addModel({ id: "mock-fresh", created: 1_730_000_000 })
    await page.getByTestId("provider-check").click()
    await expect(page.getByTestId("model-new-mock-fresh")).toHaveText("New")
    await expect(page.locator("[data-testid^=model-new-]")).toHaveCount(1)
    await expect(page.getByTestId("models-part")).toBeVisible()
    await page.getByTestId("model-row-mock-fresh").scrollIntoViewIfNeeded()
    await shot(page, "s93-06-new-en")
    await page.getByTestId("settings-close").click()
    await openNewAgent(page)
    expect((await optionTexts(page, "model-model"))[0]).toBe("mock-fresh · New")
    await closeDialog(page, "new-agent-dialog")

    // 8. A step of a workflow lists every level.
    await page.getByTestId("page-workflows").click()
    await page.getByTestId("wf-new").click()
    await page.getByTestId("wf-name").fill("Effort check")
    await page.getByTestId("wf-add-agent").click()
    expect(await optionTexts(page, "wf-step-effort")).toEqual([
      "Follow the agent",
      "None",
      "Minimal",
      "Low",
      "Medium",
      "High",
      "Extra high",
      "Max",
      "Ultra",
    ])
    await page.getByTestId("wf-step-effort").selectOption("ultra")
    await expect(page.getByTestId("wf-step-effort")).toHaveValue("ultra")
    await shot(page, "s93-07-step-effort-en")
    await page.getByTestId("wf-save").click()
    await expect(page.getByTestId("toast-success")).toHaveText("Workflow saved.")
    await app.close()

    // 9. The same screens in Korean.
    ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" }))
    await resizeWindow(app, WIDTH, HEIGHT)
    await openNewAgent(page)
    await page.getByTestId("model-model").selectOption("mock-think")
    expect(await effortLevels(page)).toEqual(["기본값", "최소", "낮음", "보통", "높음", "울트라"])
    await expect(page.getByTestId("model-older-toggle")).toHaveText("이전 모델 (1)")
    await page.getByTestId("model-effort").selectOption("ultra")
    await shotPicker(page, "s93-08-picker-ko")
    await closeDialog(page, "new-agent-dialog")
    await openSettings(page)
    await page.getByTestId("models-toggle").click()
    await page.getByTestId("model-row-mock-think").scrollIntoViewIfNeeded()
    await shot(page, "s93-09-models-part-ko")
    await page.getByTestId("settings-close").click()
    await page.getByTestId("page-workflows").click()
    await page.getByTestId("wf-open").click()
    await page.getByTestId("wf-node").first().click()
    await page.getByTestId("wf-step-effort").waitFor()
    await expect(page.getByTestId("wf-step-effort")).toHaveValue("ultra")
    expect((await optionTexts(page, "wf-step-effort")).slice(0, 3)).toEqual([
      "에이전트를 따름",
      "없음",
      "최소",
    ])
    await shot(page, "s93-10-step-effort-ko")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})
