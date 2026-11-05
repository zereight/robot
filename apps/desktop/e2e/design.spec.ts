import { expect, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow } from "./harness.ts"

// The look that DESIGN.md promises, read from the window that the app really shows. The token
// test checks the table; this one checks that the table reaches the screen. It runs only when
// DESIGN_CHECK is set, so the normal suite skips it:
//
//   DESIGN_CHECK=1 bunx playwright test e2e/design.spec.ts
//
// It reads and never writes.

test.skip(!process.env.DESIGN_CHECK, "Reads the look of the window. Set DESIGN_CHECK=1.")

test("the window follows DESIGN.md", async () => {
  const { app, page } = await launch(freshUserData())
  try {
    await resizeWindow(app, 1440, 900)
    await page.getByTestId("new-agent").waitFor()

    const tokens = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      const read = (name: string) => root.getPropertyValue(name).trim()
      return {
        steps: ["xs", "s", "m", "l", "xl", "2xl"].map((n) => read(`--text-${n}`)),
        surfaces: ["rail", "sidebar", "main", "elevated"].map((n) => read(`--c-${n}`)),
        theme: document.documentElement.dataset.theme ?? "",
      }
    })

    // A theme is on, so the values below are a real theme, not the empty default.
    expect(["dark", "light"]).toContain(tokens.theme)

    // Every text step moves up by at least a tenth, so a heading reads as a heading.
    const steps = tokens.steps.map((value) => {
      expect(value).toMatch(/^[0-9.]+rem$/)
      return Number.parseFloat(value)
    })
    for (let i = 1; i < steps.length; i += 1) {
      expect((steps[i] as number) / (steps[i - 1] as number)).toBeGreaterThanOrEqual(1.1)
    }

    // DESIGN.md, "The Floor Rule". At the small text size the smallest step still reads, so a
    // Korean syllable does not blur. 13 px is the root of that setting.
    expect((steps[0] as number) * 13).toBeGreaterThanOrEqual(11)

    // The label step is bigger than the text around a smaller one: a label is not a caption.
    const label = await page.evaluate(() => {
      const probe = document.createElement("span")
      probe.style.font = "var(--text-s)"
      document.body.append(probe)
      const size = Number.parseFloat(getComputedStyle(probe).fontSize)
      probe.remove()
      return size
    })
    expect(label).toBeGreaterThanOrEqual(14)

    // The four surfaces of the ladder are four different colours, so a panel is visible without
    // a border (DESIGN.md, "Elevation").
    for (const surface of tokens.surfaces) expect(surface).toMatch(/^#[0-9a-f]{6}$/i)
    expect(new Set(tokens.surfaces).size).toBe(tokens.surfaces.length)

    // The claim of this rule is about the small text size, so set it and read the real pixels of
    // a label. The root moves to 13 px, and the smallest step must stay legible on screen.
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-appearance").click()
    await page.getByTestId("setting-text-size").locator('label[data-value="small"]').click()
    await page.getByTestId("settings-close").click()
    await expect(page.getByTestId("settings")).toHaveCount(0)

    const smallLabel = await page.evaluate(() => {
      const probe = document.createElement("span")
      probe.style.fontSize = "var(--text-xs)"
      document.body.append(probe)
      const size = Number.parseFloat(getComputedStyle(probe).fontSize)
      probe.remove()
      return size
    })
    expect(smallLabel).toBeGreaterThanOrEqual(11)

    // DESIGN.md, "Don't". A disabled filled button fades and refuses the pointer, and it does not
    // keep the hover treatment that says "press me". The app passes `disabled` in 134 places, so a
    // button that looks the same when it cannot be pressed is a defect, not a preference.
    //
    // The connect dialog opens with an empty address and code, so its Next button is disabled.
    await page.getByTestId("server-add").click()
    const next = page.getByTestId("connect-next")
    await expect(next).toBeDisabled()
    const look = await next.evaluate((el) => {
      const style = getComputedStyle(el)
      return {
        opacity: Number.parseFloat(style.opacity),
        cursor: style.cursor,
      }
    })
    expect(look.opacity).toBeLessThan(1)
    expect(look.cursor).toBe("not-allowed")

    // A disabled filled button keeps its own colour and only fades. It must not take the colour of
    // the box behind it, which is what `background: inherit` did: the button disappeared into the
    // dialog surface.
    const filled = await next.evaluate((el) => {
      const dialog = el.closest("[class*=dialog]")
      return {
        button: getComputedStyle(el).backgroundColor,
        dialog: dialog ? getComputedStyle(dialog).backgroundColor : "",
      }
    })
    expect(filled.dialog).not.toBe("")
    expect(filled.button).not.toBe(filled.dialog)
  } finally {
    await app.close()
  }
})
