import { expect, type Locator, type Page, test } from "@playwright/test"
import { connectMock, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Avatars (spec 002, "Avatars"): they follow the theme. In the dark theme a face is a very dark
// disc with a thin rim of light and features that glow, in the family of the app mark. In the
// light theme it is a light disc with dark features and no glow. The glow is still, the number of
// layers follows the size (so that a long list stays cheap), and a change of the theme moves
// nothing.

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

const rows = (page: Page) => page.locator("[data-place-row]")
const rowNamed = (page: Page, name: string) =>
  rows(page).filter({ hasText: new RegExp(`^${name}$`) })

// The disc of the mark of the user, in each theme. In the dark theme it is the
// tile of the app mark. The app mark itself does not change with the theme.
const MARK_TILE = "rgb(10, 8, 23)"
const MARK_TILE_LIGHT = "rgb(225, 247, 239)"

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

/**
 * Sets the theme and returns the most looks that one avatar had on the way: the colours of its
 * disc, its features and its rim, read on every frame. An avatar that changes at once has two
 * looks: the old and the new. A soft change has more, one for each step. A change of the theme
 * moves nothing (spec 002). The window of 450 ms is longer than the soft change of a new hue.
 */
const setTheme = async (page: Page, theme: "dark" | "light") => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.evaluate(() => {
    const looks = new Map<Element, Set<string>>()
    const read = (el: Element) => {
      if (el instanceof SVGSVGElement) {
        const layers = el.querySelectorAll(":scope > g > g")
        const core = layers[layers.length - 1]
        const [disc, rim] = el.querySelectorAll("circle")
        return [
          disc && getComputedStyle(disc).fill,
          core && getComputedStyle(core).color,
          rim && getComputedStyle(rim).stroke,
        ].join(" ")
      }
      const style = getComputedStyle(el)
      // The colour of an outline counts only when the outline is drawn (a picture). A disc has
      // none, and its `outline-color` is the colour of the text, which the rest of the app changes.
      const outline = style.outlineStyle === "none" ? "" : style.outlineColor
      return [style.backgroundColor, style.boxShadow, outline].join(" ")
    }
    const sample = () => {
      for (const el of document.querySelectorAll(
        "svg[data-face-shape], img, [data-testid=user-mark]",
      )) {
        const seen = looks.get(el) ?? new Set<string>()
        seen.add(read(el))
        looks.set(el, seen)
      }
    }
    const watch = { stop: false }
    const loop = () => {
      sample()
      if (!watch.stop) requestAnimationFrame(loop)
    }
    requestAnimationFrame(loop)
    Object.assign(window, {
      __avatarWatch: () =>
        new Promise<number>((done) =>
          setTimeout(() => {
            watch.stop = true
            done(Math.max(0, ...[...looks.values()].map((seen) => seen.size)))
          }, 450),
        ),
    })
  })
  await page.getByTestId("setting-theme").locator(`label[data-value="${theme}"]`).click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme)
  const looks = await page.evaluate(() =>
    (window as unknown as { __avatarWatch: () => Promise<number> }).__avatarWatch(),
  )
  await page.getByTestId("settings-close").click()
  return looks
}

test("avatars: they follow the theme, layers that follow the size, a still glow, no motion when the theme changes", async () => {
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
  // The rim is 1.5 px wide. A page draws an outline in whole pixels of the screen: 1.5 px on a
  // screen with twice the pixels (a Mac with Retina), 1 px on a screen with the normal count. So
  // the width that the page reports depends on the screen that runs the test.
  const scale = await page.evaluate(() => window.devicePixelRatio)
  const rim = await picture.evaluate((el) => Number.parseFloat(getComputedStyle(el).outlineWidth))
  expect(rim).toBeCloseTo(Math.max(1, Math.floor(1.5 * scale)) / scale, 2)
  expect(await picture.evaluate((el) => getComputedStyle(el).outlineColor)).toMatch(
    /^rgba\(.+, 0\.4\)$/,
  )
  await rowNamed(page, "Ada").click()
  await shot(page, "avatars-01-dark")

  // The light theme: a light disc with dark features and no glow. The change moves nothing.
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  expect(await setTheme(page, "light")).toBeLessThanOrEqual(2)
  const light = await look(rowNamed(page, "Ada").locator("svg[data-face-shape]"))
  expect(luminance(rgb(light.tile))).toBeGreaterThan(0.6)
  expect(luminance(rgb(light.core))).toBeLessThan(0.05)
  expect(contrast(light.core, light.tile)).toBeGreaterThanOrEqual(7)
  // The core is the only layer: no glow, at any size.
  expect(light.layers).toBe(1)
  expect(light.eyes).toBe(1)
  expect(light.parts).toBe(small.parts)
  const lightBig = await look(page.getByTestId("chat-start").locator("svg[data-face-shape]"))
  expect(lightBig.layers).toBe(1)
  expect(contrast(lightBig.core, lightBig.tile)).toBeGreaterThanOrEqual(7)
  // The mark of the user: a light disc, a dark glyph, no wide copy of the glyph.
  await expect(you).toHaveCSS("background-color", MARK_TILE_LIGHT)
  await expect(you.locator(":scope > span")).toHaveCount(1)
  expect(
    contrast(
      await you.locator("svg").evaluate((el) => getComputedStyle(el).color),
      MARK_TILE_LIGHT,
    ),
  ).toBeGreaterThanOrEqual(7)
  // A picture does not change. Its rim shows: it is a solid colour that is dark enough.
  await rowNamed(page, "Bea").click()
  const lightPicture = rowNamed(page, "Bea").locator("img")
  await expect(lightPicture).toHaveCSS("outline-style", "solid")
  expect(await lightPicture.evaluate((el) => getComputedStyle(el).outlineColor)).toMatch(
    /^rgb\(\d+, \d+, \d+\)$/,
  )
  await rowNamed(page, "Ada").click()
  await shot(page, "avatars-02-light")

  // Back to the dark theme: the dark discs and the glow come back.
  expect(await setTheme(page, "dark")).toBeLessThanOrEqual(2)
  const again = await look(rowNamed(page, "Ada").locator("svg[data-face-shape]"))
  expect(again.tile).toBe(small.tile)
  expect(again.core).toBe(small.core)
  expect(again.layers).toBe(small.layers)
  await expect(you).toHaveCSS("background-color", MARK_TILE)
  await expect(you.locator(":scope > span")).toHaveCount(2)
  await app.close()
})
