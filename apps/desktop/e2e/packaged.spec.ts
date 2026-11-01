import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { launch, shot } from "./harness.ts"

const version = JSON.parse(
  readFileSync(join(import.meta.dirname, "../package.json"), "utf8"),
).version

test.skip(!process.env.ROBOT_E2E_APP, "runs only against a packaged app (ROBOT_E2E_APP)")

test("packaged app: starts, shows its version, and loads the native keychain module", async () => {
  const { app, page } = await launch(undefined, { ROBOT_SYSTEM_LOCALE: "en-US" })
  const info = await app.evaluate(({ app: electronApp }) => {
    const unpacked = `${process.resourcesPath}/app.asar.unpacked/node_modules/@napi-rs`
    const fs = process.getBuiltinModule("node:fs")
    const dir = fs
      .readdirSync(unpacked)
      .find((d) => d.startsWith(`keyring-${process.platform}-${process.arch}`))
    const file = dir && fs.readdirSync(`${unpacked}/${dir}`).find((f) => f.endsWith(".node"))
    const mod = { exports: {} as Record<string, unknown> }
    if (file) process.dlopen(mod, `${unpacked}/${dir}/${file}`)
    return {
      packaged: electronApp.isPackaged,
      name: electronApp.getName(),
      version: electronApp.getVersion(),
      keyring: Object.keys(mod.exports).includes("Entry"),
    }
  })
  expect(info).toEqual({ packaged: true, name: "ROBot", version, keyring: true })
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-about").click()
  await expect(page.getByTestId("settings")).toContainText(version)
  await shot(page, `packaged-${process.platform}-${process.arch}-about`)
  await app.close()
})
