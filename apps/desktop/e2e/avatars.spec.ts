import { expect, type Locator, type Page, test } from "@playwright/test"
import { connectMock, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Avatars (spec 002, "Avatars"): a very dark disc with a thin rim of light and features that
// glow, in the family of the app mark. The glow is still, the number of layers follows the size
// (so that a long list stays cheap), and the discs are the same in both themes.

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

const rows = (page: Page) => page.locator("[data-place-row]")
const rowNamed = (page: Page, name: string) =>
  rows(page).filter({ hasText: new RegExp(`^${name}$`) })

// The tile of the app mark: the colour that the mark of the user and of a channel use as well.
const MARK_TILE = "rgb(10, 8, 23)"

const rgb = (css: string): [number, number, number] =>
  (css.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number) as [number, number, number]
const luminance = (colour: [number, number, number]) => {
  const [r, g, b] = colour.map((v) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** What a drawn face looks like: its disc, its top layer, and how many layers it has. */
const look = (face: Locator) =>
  face.evaluate((svg) => {
    const skin = svg.querySelector("circle") as SVGCircleElement
    const layers = [...svg.querySelectorAll(":scope > g > g")]
    const core = layers[layers.length - 1] as SVGGElement
    return {
      tile: getComputedStyle(skin).fill,
      core: getComputedStyle(core).color,
      layers: layers.length,
      eyes: svg.querySelectorAll("[data-part=eyes]").length,
      parts: core.children.length,
      moving: svg.getAnimations({ subtree: true }).length,
    }
  })

const makeAgent = async (page: Page, name: string, shape: number, hue: number) => {
  await page.getByTestId("new-agent").click()
  await page.getByTestId("agent-name").fill(name)
  await page.getByTestId(`face-shape-${shape}`).click()
  await page.getByTestId(`face-hue-${hue}`).click()
  await page.getByTestId("model-model").waitFor()
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("chat-start").filter({ hasText: name }).waitFor()
  await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
}

const setTheme = async (page: Page, theme: "dark" | "light") => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.getByTestId("setting-theme").locator(`label[data-value="${theme}"]`).click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
  await page.getByTestId("settings-close").click()
}

test("avatars: dark discs of light, layers that follow the size, a still glow, the same in both themes", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  // The theme follows the system at first, so the test sets the dark theme on purpose.
  await setTheme(page, "dark")

  // The first shape had no features at all once. Shape 4 has closed eyes, so it has no eyes to blink.
  await makeAgent(page, "Ada", 0, 2)
  await makeAgent(page, "Bea", 4, 7)

  await rowNamed(page, "Ada").click()
  const big = page.getByTestId("chat-start").locator("svg[data-face-shape]")
  await expect(big).toHaveAttribute("data-face-shape", "0")
  const ada = await look(big)
  // 80 px: four layers of glow and the sharp core. Every layer holds the eyes, so the face blinks
  // as a whole.
  expect(ada.layers).toBe(5)
  expect(ada.eyes).toBe(5)
  expect(ada.parts).toBeGreaterThan(1)
  // A very dark disc, light features, and a contrast of 7 to 1 or more.
  expect(luminance(rgb(ada.tile))).toBeLessThan(0.02)
  expect(contrast(ada.core, ada.tile)).toBeGreaterThanOrEqual(7)

  await rowNamed(page, "Bea").click()
  const bea = await look(page.getByTestId("chat-start").locator("svg[data-face-shape]"))
  expect(bea.layers).toBe(5)
  expect(bea.eyes).toBe(0)
  expect(bea.parts).toBeGreaterThan(2)

  // The place list shows a small face: one layer of glow and the core. The cost of a face follows
  // its size, so a long list stays cheap.
  const small = await look(rowNamed(page, "Ada").locator("svg[data-face-shape]"))
  expect(small.layers).toBe(2)

  // The glow is still: it does not move, also when the pointer is over it.
  await rowNamed(page, "Ada").click()
  await page.getByTestId("composer-input").fill("hello")
  await page.getByTestId("composer-input").press("Enter")
  const reply = page.locator("[data-testid=message][data-author=agent]").first()
  await expect(reply).toContainText("You said: hello")
  const mid = reply.locator("svg[data-face-shape]")
  expect((await look(mid)).layers).toBe(3)
  await mid.hover()
  await expect.poll(async () => (await look(mid)).moving).toBe(0)
  await expect(mid.locator(":scope > g > g").last()).toHaveCSS("opacity", "1")

  // The mark of the user: a dark disc of the app mark with a glyph of light.
  const you = page
    .locator("[data-testid=message][data-author=user]")
    .first()
    .getByTestId("user-mark")
  await expect(you).toBeVisible()
  await expect(you).toHaveCSS("background-color", MARK_TILE)
  await expect(you).toHaveCSS("border-radius", "50%")
  expect(await you.evaluate((el) => getComputedStyle(el).boxShadow)).toContain("inset")

  // The mark of a channel: the same disc with a `#`.
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Launch")
  for (const name of ["Ada", "Bea"]) await page.getByTestId(`channel-member-${name}`).check()
  await page.getByTestId("channel-lead").selectOption({ label: "Ada" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")
  const channelMark = rows(page).filter({ hasText: "Launch" }).getByTestId("channel-mark")
  await expect(channelMark).toHaveCSS("background-color", MARK_TILE)

  // A picture has the same rim of light, in the hue of the agent, and stays round.
  await rowNamed(page, "Bea").click()
  await page.getByTestId("chat-header-agent").click()
  await page
    .getByTestId("face-file")
    .setInputFiles({ name: "me.png", mimeType: "image/png", buffer: onePixelPng })
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
  const picture = rowNamed(page, "Bea").locator("img")
  await expect(picture).toBeVisible()
  await expect(picture).toHaveCSS("border-radius", "50%")
  await expect(picture).toHaveCSS("outline-style", "solid")
  await expect(picture).toHaveCSS("outline-width", "1.5px")
  expect(await picture.evaluate((el) => getComputedStyle(el).outlineColor)).toMatch(
    /^rgba\(.+, 0\.4\)$/,
  )
  await rowNamed(page, "Ada").click()
  await shot(page, "avatars-01-dark")

  // The same in the light theme: the discs stay dark, and the features stay light.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await setTheme(page, "light")
  const light = await look(rowNamed(page, "Ada").locator("svg[data-face-shape]"))
  expect(light.tile).toBe(small.tile)
  expect(light.core).toBe(small.core)
  await expect(you).toHaveCSS("background-color", MARK_TILE)
  await expect(channelMark).toHaveCSS("background-color", MARK_TILE)
  await shot(page, "avatars-02-light")
  await app.close()
})
