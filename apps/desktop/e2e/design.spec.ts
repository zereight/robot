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

    // The four surfaces of the ladder are four different colours, so a panel is visible without
    // a border (DESIGN.md, "Elevation").
    for (const surface of tokens.surfaces) expect(surface).toMatch(/^#[0-9a-f]{6}$/i)
    expect(new Set(tokens.surfaces).size).toBe(tokens.surfaces.length)
  } finally {
    await app.close()
  }
})
