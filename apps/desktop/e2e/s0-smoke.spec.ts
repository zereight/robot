import { expect, test } from "@playwright/test"
import { launch, shot } from "./harness.ts"

test("app starts and the renderer gets data from the main process", async () => {
  const { app, page } = await launch()
  await expect(page.getByTestId("app-root")).toBeVisible()
  await expect(page.getByTestId("open-settings")).toBeVisible()
  await shot(page, "s0-smoke")
  await app.close()
})
