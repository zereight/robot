import { execFileSync } from "node:child_process"
import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch } from "./harness.ts"

// An installed app has a Dock icon, and the user quits it from there. The status island must not
// take the icon away. (A test run is a background program from the start, so the test turns the
// app into a normal one first, like an installed app is.)
test.skip(process.platform !== "darwin", "The Dock is a macOS part")

const rpc = (page: Page, method: string, input?: unknown) =>
  page.evaluate(
    async ([m, i]) => {
      const bridge = (
        window as unknown as {
          robot: {
            invoke: (method: string, input: unknown) => Promise<{ ok: boolean; error?: unknown }>
          }
        }
      ).robot
      const result = await bridge.invoke(m as string, i)
      if (!result.ok) throw new Error(JSON.stringify(result.error))
    },
    [method, input] as const,
  )

/** "Foreground" for an app with a Dock icon, "UIElement" for one without. */
const appType = (pid: number) => {
  const asn = execFileSync("lsappinfo", ["find", `pid=${pid}`], { encoding: "utf8" }).trim()
  const info = execFileSync("lsappinfo", ["info", "-only", "ApplicationType", asn], {
    encoding: "utf8",
  })
  return /"ApplicationType"="(\w+)"/.exec(info)?.[1]
}

test("the status island keeps the Dock icon of the app", async () => {
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  const pid = app.process().pid as number

  await app.evaluate(({ app: electronApp }) => {
    electronApp.setActivationPolicy("regular")
    // The island is off in a test run until the test asks for it.
    process.env.ROBOT_FORCE_ISLAND = "1"
  })
  await expect.poll(() => appType(pid), { timeout: 10_000 }).toBe("Foreground")

  // Turn the island off and on again, so that the app makes its window.
  await rpc(page, "settings.update", { island: "off" })
  await rpc(page, "settings.update", { island: "always" })
  await expect
    .poll(
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some(
            (w) => w.getTitle() === "ROBot island" && w.isVisible(),
          ),
        ),
      { timeout: 15_000 },
    )
    .toBe(true)

  // The icon stays. This also holds a moment later, after the window has settled.
  await new Promise((resolve) => setTimeout(resolve, 1000))
  expect(appType(pid)).toBe("Foreground")
  await app.close()
})
