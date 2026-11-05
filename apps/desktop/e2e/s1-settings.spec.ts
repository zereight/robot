import { existsSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, shot } from "./harness.ts"

const chooseOption = (page: Page, group: string, value: string) =>
  page.getByTestId(group).locator(`label[data-value="${value}"]`).click()

/** Words that may stay in Latin letters in the Korean interface: names and code. */
const allowedLatin = new Set(["ROBot", "English", "OpenAI", "Anthropic", "API", "URL", "VPN"])
// Names of products are not translated.
// A file name is a name too: the text says where the report is saved, and the file has one name.
const productNames =
  /Claude Code|Muse Code|Codex|Tailscale|Microsoft|Teams|opencode|\bpi\b|diagnostic-report\.txt|Cursor/g

const latinWords = async (page: Page, selector: string) => {
  const text = await page.locator(selector).evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement
    for (const skip of clone.querySelectorAll(
      "[data-testid=licenses], [data-testid$=-folder] div div + div, [data-testid=setting-workspace-root] div div + div",
    ))
      skip.remove()
    return clone.textContent ?? ""
  })
  // Version numbers are data, and a pre-release has letters ("0.1.0-alpha.1").
  const words = text.replace(/\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?/g, "").replace(productNames, "")
  return (words.match(/[A-Za-z]{2,}/g) ?? []).filter((w) => !allowedLatin.has(w))
}

const bodyContrast = (page: Page) =>
  page.evaluate(() => {
    const parse = (c: string) => (c.match(/\d+/g) ?? []).slice(0, 3).map(Number)
    const lum = ([r = 0, g = 0, b = 0]: number[]) => {
      const f = (v: number) => {
        const c = v / 255
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const style = getComputedStyle(document.body)
    const [a, b] = [lum(parse(style.color)), lum(parse(style.backgroundColor))].sort(
      (x, y) => y - x,
    )
    return ((a ?? 0) + 0.05) / ((b ?? 0) + 0.05)
  })

test("settings: language, theme and text size apply at once and survive a restart", async () => {
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)

  expect(existsSync(join(userData, "robot.db"))).toBe(true)

  await page.getByTestId("open-settings").click()
  await expect(page.getByTestId("settings")).toBeVisible()
  await expect(page.getByTestId("settings-nav-general")).toHaveText("General")
  await shot(page, "s1-01-settings-en")

  await page.getByTestId("settings-nav-data").click()
  await expect(page.getByTestId("setting-data-folder")).toContainText(userData)

  await page.getByTestId("settings-nav-general").click()
  await chooseOption(page, "setting-language", "ko")
  await expect(page.getByTestId("settings-nav-general")).toHaveText("일반")
  await expect(page.locator("html")).toHaveAttribute("lang", "ko")

  for (const section of [
    "general",
    "appearance",
    "providers",
    "devices",
    "notifications",
    "archive",
    "data",
    "about",
  ]) {
    await page.getByTestId(`settings-nav-${section}`).click()
    expect(await latinWords(page, "[data-testid=settings]"), `section ${section}`).toEqual([])
  }
  await page.getByTestId("settings-nav-about").click()
  await expect(page.getByTestId("licenses").locator("li")).not.toHaveCount(0)
  await shot(page, "s1-02-about-ko")

  await page.getByTestId("settings-nav-appearance").click()
  for (const theme of ["dark", "light"]) {
    await chooseOption(page, "setting-theme", theme)
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
    expect(await bodyContrast(page)).toBeGreaterThanOrEqual(4.5)
    await shot(page, `s1-03-appearance-${theme}`)
  }
  await chooseOption(page, "setting-text-size", "large")
  await expect(page.locator("html")).toHaveCSS("font-size", "16px")
  await chooseOption(page, "setting-reduce-motion", "on")
  await expect(page.locator("html")).toHaveAttribute("data-reduce-motion", "true")
  await page.getByTestId("setting-compact-places").click()
  await expect(page.getByTestId("setting-compact-places")).toHaveAttribute("aria-checked", "true")

  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings")).toBeHidden()
  await app.close()

  ;({ app, page } = await launch(userData, env))
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light")
  await expect(page.locator("html")).toHaveAttribute("lang", "ko")
  await expect(page.locator("html")).toHaveCSS("font-size", "16px")
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await expect(page.getByTestId("setting-compact-places")).toHaveAttribute("aria-checked", "true")
  await shot(page, "s1-04-after-restart")
  await app.close()
})

test("settings: the close button sits on the left", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await page.getByTestId("open-settings").click()
  await expect(page.getByTestId("settings")).toBeVisible()
  const box = await page.getByTestId("settings").boundingBox()
  const close = await page.getByTestId("settings-close").boundingBox()
  expect(box).not.toBeNull()
  expect(close).not.toBeNull()
  const pageBox = box ?? { x: 0, y: 0, width: 0, height: 0 }
  const closeBox = close ?? { x: 0, y: 0, width: 0, height: 0 }
  expect(closeBox.x + closeBox.width / 2).toBeLessThan(pageBox.x + pageBox.width / 2)
  await app.close()
})

test("settings: the system language is used until the user picks one", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await expect(page.locator("html")).toHaveAttribute("lang", "ko")
  await expect(page.getByTestId("open-settings")).toHaveAttribute("aria-label", "설정")
  await app.close()
})
