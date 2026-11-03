import { execFileSync } from "node:child_process"
import { expect, test } from "@playwright/test"
import { killAtOnce, launch, shot } from "./harness.ts"

// The host program answers the window calls that moved to it: Settings → About lists the crates of
// the host beside the packages of the app. The host never outlives the app: it ends after a normal
// quit and after the app is killed at once.

/** The process numbers of the host of the copy of the app with this data folder. */
const hostPids = (userData: string): number[] => {
  try {
    return execFileSync("pgrep", ["-f", `robot-host --data ${userData}`], { encoding: "utf8" })
      .split("\n")
      .filter(Boolean)
      .map(Number)
  } catch {
    // pgrep ends with an error when no process matches.
    return []
  }
}

const openAbout = async (page: Awaited<ReturnType<typeof launch>>["page"]) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-about").click()
  const licenses = page.getByTestId("licenses")
  // A crate of the host and a package of the window, in one list.
  await expect(licenses.locator("li").filter({ hasText: /^serde_json\s/ })).toHaveCount(1)
  await expect(licenses.locator("li").filter({ hasText: /^solid-js\s/ })).toHaveCount(1)
}

test("the host answers the license list and ends when the app quits", async () => {
  const { app, page, userData } = await launch()
  await openAbout(page)
  await shot(page, "host-01-about-licenses")
  expect(hostPids(userData)).toHaveLength(1)

  await app.close()
  await expect.poll(() => hostPids(userData), { timeout: 10_000 }).toEqual([])
})

test("the host ends when the app is killed at once", async () => {
  const { app, page, userData } = await launch()
  await openAbout(page)
  expect(hostPids(userData)).toHaveLength(1)

  await killAtOnce(app)
  await expect.poll(() => hostPids(userData), { timeout: 10_000 }).toEqual([])
})
