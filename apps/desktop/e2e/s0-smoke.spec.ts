import { expect, test } from "@playwright/test"
import { launch, shot } from "./harness.ts"

test("app starts and the renderer talks to the main process", async () => {
  const { app, page } = await launch()
  await expect(page.getByTestId("app-root")).toBeVisible()
  await expect(page.getByTestId("app-version")).toHaveText(/\d+\.\d+\.\d+/)
  await shot(page, "s0-smoke")
  await app.close()
})
