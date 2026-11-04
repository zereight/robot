import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

const placeRows = (page: Page) => page.getByTestId("section-agents").locator("[data-place-row]")
// An agent with a role line shows it as a badge after the name (spec 001), so the row is found by
// its name and not by its whole text.
const rowNamed = (page: Page, name: string) =>
  placeRows(page).and(page.locator(`[data-place-name="${name}"]`))

const openProfile = async (page: Page, name: string) => {
  await rowNamed(page, name).click()
  await expect(page.getByTestId("chat-start").locator("h2")).toHaveText(name)
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
}

test("agents: create, duplicate, edit, archive, restore and delete", async () => {
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1200, 800)

  // A blank form does not save, and it says why. The reason goes away when the name is filled.
  await page.getByTestId("new-agent").click()
  await page.getByTestId("starter-blank").click()
  await expect(page.getByTestId("agent-name")).toHaveValue("")
  await expect(page.getByTestId("agent-name-error")).toBeHidden()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-name-error")).toHaveText("Give the agent a name.")
  await expect(page.getByTestId("agent-name")).toHaveAttribute("aria-invalid", "true")
  await expect(page.getByTestId("agent-name")).toBeFocused()
  await shot(page, "s3-00-name-required")

  // Create from a starter.
  await page.getByTestId("starter-assistant").click()
  await expect(page.getByTestId("agent-name-error")).toBeHidden()
  await expect(page.getByTestId("agent-name")).toHaveAttribute("aria-invalid", "false")
  await expect(page.getByTestId("agent-name")).toHaveValue("Assistant")
  await expect(page.getByTestId("agent-instructions")).not.toHaveValue("")
  await page.getByTestId("agent-name").fill("Ada")
  await page.getByTestId("face-shape-3").click()
  await page.getByTestId("face-hue-5").click()
  await shot(page, "s3-01-new-agent")
  await page.getByTestId("agent-submit").click()

  await expect(page.getByTestId("chat-start")).toContainText("Ada")
  await expect(page.getByTestId("chat-start")).toContainText("This is the start of your chat.")
  await expect(page.getByTestId("chat-start")).toContainText("Answers daily questions")
  await expect(rowNamed(page, "Ada")).toHaveAttribute("aria-current", "true")
  await expect(page.getByTestId("chat-start").locator("svg")).toHaveAttribute(
    "data-face-shape",
    "3",
  )
  await expect(page.getByTestId("chat-header-model")).toHaveText("No model")
  expect(readdirSync(join(userData, "workspaces"))).toHaveLength(1)
  await shot(page, "s3-02-chat-start")

  // Duplicate twice.
  await openProfile(page, "Ada")
  await page.getByTestId("agent-duplicate").click()
  await expect(page.getByTestId("chat-start").locator("h2")).toHaveText("Ada copy")
  await openProfile(page, "Ada")
  await page.getByTestId("agent-duplicate").click()
  await expect(page.getByTestId("chat-start")).toContainText("Ada copy 2")
  // The copies keep the role line of the original, so each row shows it as a badge (spec 001).
  await expect(placeRows(page)).toHaveText([
    /^Ada.*Answers daily questions/,
    /^Ada copy.*Answers daily questions/,
    /^Ada copy 2.*Answers daily questions/,
  ])
  expect(
    await placeRows(page).evaluateAll((all) =>
      all.map((el) => (el as HTMLElement).dataset.placeName),
    ),
  ).toEqual(["Ada", "Ada copy", "Ada copy 2"])
  expect(readdirSync(join(userData, "workspaces"))).toHaveLength(3)

  // Search and keyboard.
  await page.getByTestId("place-search").fill("copy")
  await expect(placeRows(page)).toHaveCount(2)
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("ArrowDown")
  await page.keyboard.press("Enter")
  await expect(page.getByTestId("chat-start").locator("h2")).toHaveText("Ada copy 2")
  await page.getByTestId("place-search").fill("")

  // Edit: an empty name does not save, and the form says why. A taken name is refused; a free
  // name is saved; a picture replaces the drawn face.
  await openProfile(page, "Ada copy 2")
  await page.getByTestId("agent-name").fill("")
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-name-error")).toHaveText("Give the agent a name.")
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await page.getByTestId("agent-name").fill("a".repeat(41))
  await expect(page.getByTestId("agent-name-error")).toHaveText(
    "The name can have at most 40 characters.",
  )
  await page.getByTestId("agent-name").fill("ada")
  await expect(page.getByTestId("agent-name-error")).toBeHidden()
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-error")).toHaveText(
    "Another agent on this server has this name.",
  )
  await page
    .getByTestId("face-file")
    .setInputFiles({ name: "me.png", mimeType: "image/png", buffer: onePixelPng })
  await expect(rowNamed(page, "Ada copy 2").locator("img")).toBeVisible()
  await page.getByTestId("agent-name").fill("Bea")
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
  await expect(page.getByTestId("chat-start")).toContainText("Bea")
  await shot(page, "s3-03-edited")

  // Archive, restore, archive again, delete.
  await openProfile(page, "Bea")
  await page.getByTestId("agent-archive").click()
  await expect(rowNamed(page, "Bea")).toHaveCount(0)
  await expect(page.getByTestId("no-place")).toBeVisible()
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-archive").click()
  await expect(page.getByTestId("archive-section")).toContainText("Bea")
  await page.getByTestId("archive-restore").click()
  await expect(page.getByTestId("archive-section")).toContainText("No archived agents.")
  await page.getByTestId("settings-close").click()
  await expect(rowNamed(page, "Bea")).toHaveCount(1)

  await openProfile(page, "Bea")
  await page.getByTestId("agent-archive").click()
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-archive").click()
  await page.getByTestId("archive-delete").click()
  await expect(page.getByTestId("delete-confirm")).toContainText("system trash")
  await shot(page, "s3-04-delete-confirm")
  await page.getByTestId("delete-confirm-button").click()
  await expect(page.getByTestId("archive-section")).toContainText("No archived agents.")
  expect(readdirSync(join(userData, "workspaces"))).toHaveLength(2)
  expect(existsSync(join(userData, "test-trash"))).toBe(true)
  expect(readdirSync(join(userData, "test-trash"))).toHaveLength(1)
  await page.getByTestId("settings-close").click()

  // The open place survives a restart.
  await rowNamed(page, "Ada copy").click()
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await expect(page.getByTestId("chat-start").locator("h2")).toHaveText("Ada copy")
  await expect(rowNamed(page, "Ada copy")).toHaveAttribute("aria-current", "true")
  await shot(page, "s3-05-after-restart")
  await app.close()
})

test("agents: a long name stays on one line in the chat header", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1000, 700)
  const name = "Account Research Partner for Quarterly Reviews"
  await page.getByTestId("new-agent").click()
  await page.getByTestId("starter-assistant").click()
  await page.getByTestId("agent-name").fill(name.slice(0, 40))
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("chat-start")).toBeVisible()

  const header = page.getByTestId("conversation-header")
  const agent = page.getByTestId("chat-header-agent")
  const box = async (locator: ReturnType<Page["getByTestId"]>) => {
    const b = await locator.boundingBox()
    if (!b) throw new Error("not visible")
    return b
  }
  // The name button stays inside the header, which keeps its height. The model button is whole.
  const headerBox = await box(header)
  const agentBox = await box(agent)
  const modelBox = await box(page.getByTestId("chat-header-model"))
  expect(headerBox.height).toBeLessThanOrEqual(48)
  expect(agentBox.height).toBeLessThanOrEqual(headerBox.height)
  expect(agentBox.x + agentBox.width).toBeLessThanOrEqual(modelBox.x + 1)
  expect(modelBox.x + modelBox.width).toBeLessThanOrEqual(headerBox.x + headerBox.width)
  // The full name is on the button for the pointer.
  await expect(agent).toHaveAttribute("title", name.slice(0, 40))
  await shot(page, "s3-07-long-name-header")
  await app.close()
})

test("agents: the profile box of an agent scrolls in a short window", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1000, 460)
  await page.getByTestId("new-agent").click()
  await page.getByTestId("starter-assistant").click()
  await page.getByTestId("agent-name").fill("Tall")
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("chat-start")).toBeVisible()
  await page.getByTestId("chat-header-agent").click()
  const box = page.getByTestId("agent-profile")
  await expect(box).toBeVisible()
  // The box never grows past the window. What does not fit scrolls, so every button stays in reach.
  const heights = await box.evaluate((el) => ({
    box: el.getBoundingClientRect().height,
    window: innerHeight,
  }))
  expect(heights.box).toBeLessThanOrEqual(heights.window)
  await page.getByTestId("agent-archive").click({ timeout: 5_000 })
  await expect(page.getByTestId("no-place")).toBeVisible()
  await app.close()
})

test("agents: a new agent can get a random name suggestion", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 800)
  const nameField = page.getByTestId("agent-name")
  const suggest = page.getByTestId("agent-name-suggest")

  // Each press fills the field with a new, valid name. A starter name is replaced.
  await page.getByTestId("new-agent").click()
  await page.getByTestId("starter-assistant").click()
  await expect(nameField).toHaveValue("Assistant")
  await suggest.click()
  await expect(nameField).not.toHaveValue("Assistant")
  let last = await nameField.inputValue()
  expect(last.length).toBeGreaterThan(0)
  expect([...last].length).toBeLessThanOrEqual(40)
  for (let i = 0; i < 8; i++) {
    await suggest.click()
    await expect(nameField).not.toHaveValue(last)
    last = await nameField.inputValue()
  }
  await expect(page.getByTestId("agent-submit")).toBeEnabled()
  await shot(page, "s3-06-suggested-name")

  // The suggested name makes an agent. Its name is then never suggested again.
  const first = last
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("chat-start").locator("h2")).toHaveText(first)
  await page.getByTestId("new-agent").click()
  for (let i = 0; i < 60; i++) {
    const before = await nameField.inputValue()
    await suggest.click()
    await expect(nameField).not.toHaveValue(before)
    expect((await nameField.inputValue()).toLowerCase()).not.toBe(first.toLowerCase())
  }
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("new-agent-dialog")).toBeHidden()

  // An archived agent still holds its name.
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
  await expect(suggest).toHaveCount(0)
  await page.getByTestId("agent-archive").click()
  await expect(page.getByTestId("no-place")).toBeVisible()
  await page.getByTestId("new-agent").click()
  for (let i = 0; i < 60; i++) {
    const before = await nameField.inputValue()
    await suggest.click()
    await expect(nameField).not.toHaveValue(before)
    expect((await nameField.inputValue()).toLowerCase()).not.toBe(first.toLowerCase())
  }
  await app.close()
})

test("agents: name suggestions stay English in the Korean interface", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 1200, 800)
  await page.getByTestId("new-agent").click()
  await expect(page.getByTestId("agent-name-suggest")).toHaveAttribute(
    "aria-label",
    "이름 추천받기",
  )
  await page.getByTestId("agent-name-suggest").click()
  await expect(page.getByTestId("agent-name")).toHaveValue(/^[A-Za-z]+$/)
  await shot(page, "s3-07-suggested-name-ko")
  await app.close()
})
