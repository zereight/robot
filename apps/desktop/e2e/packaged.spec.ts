import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { launch, shot } from "./harness.ts"

const version = JSON.parse(
  readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
).version

test.skip(!process.env.ROBOT_E2E_APP, "runs only against a packaged app (ROBOT_E2E_APP)")

test("packaged app: starts, shows its version, and carries the host that keeps the keys", async () => {
  const { app, page, userData } = await launch(undefined, { ROBOT_SYSTEM_LOCALE: "en-US" })
  const info = await app.evaluate(({ app: electronApp }) => ({
    packaged: electronApp.isPackaged,
    name: electronApp.getName(),
    version: electronApp.getVersion(),
    resources: process.resourcesPath,
  }))
  expect({ ...info, resources: undefined }).toEqual({
    packaged: true,
    name: "ROBot",
    version,
    resources: undefined,
  })
  // The keys are in the host program now; the app has no native keychain module of its own.
  const host = join(info.resources, "robot-host")
  expect(existsSync(host)).toBe(true)
  expect(existsSync(join(info.resources, "app.asar.unpacked/node_modules/@napi-rs"))).toBe(false)
  // The host reads the store of this test run: the file of the harness, which holds no "probe".
  const file = `${userData}-secrets.json`
  const probe = spawnSync(host, ["secrets", "get", "probe", "--file", file])
  expect(probe.status).toBe(3)
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-about").click()
  await expect(page.getByTestId("settings")).toContainText(version)
  await shot(page, `packaged-${process.platform}-${process.arch}-about`)
  await app.close()
})
