import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { unzipSync } from "fflate"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const settled = (page: import("@playwright/test").Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)

test("attach files, export without keys, import into an empty app", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-s7-"))
  const note = join(work, "note.txt")
  const photo = join(work, "photo.png")
  writeFileSync(note, "hello file")
  writeFileSync(photo, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const archive = join(work, "export.zip")
  const env = {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_PICK_FILES: JSON.stringify([note, photo]),
    ROBOT_TEST_SAVE_PATH: archive,
  }
  const userData = freshUserData()
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")

  // Attach: chips show, one can be removed, the rest go with the message.
  await page.getByTestId("composer-attach").click()
  await expect(page.getByTestId("attachment-chip")).toHaveCount(2)
  await shot(page, "s7-01-chips")
  await page.getByTestId("attachment-remove").last().click()
  await expect(page.getByTestId("attachment-chip")).toHaveCount(1)
  await page.getByTestId("composer-input").fill(`see the file, key ${GOOD_KEY}`)
  await page.getByTestId("composer-input").press("Enter")
  await expect(page.getByTestId("message-file").first()).toContainText("note.txt")
  await expect(page.getByTestId("attachment-chip")).toHaveCount(0)
  await expect(page.locator("[data-testid=message][data-author=agent]").first()).toContainText(
    "You said",
  )
  await settled(page)
  await shot(page, "s7-02-sent")

  // A file alone is a message too.
  await page.getByTestId("composer-attach").click()
  await page.getByTestId("composer-send").click()
  await expect(page.getByTestId("message-file")).toHaveCount(3)
  await settled(page)

  // The copy is in the agent's workspace, and the first name is not overwritten.
  const copies = readdirSync(userData, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.parentPath.endsWith("attachments"))
    .map((e) => e.name)
    .sort()
  expect(copies).toEqual(["note (2).txt", "note.txt", "photo.png"])

  // Export: the archive holds the data and no key.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-data").click()
  await page.getByTestId("data-export").click()
  await expect(page.getByTestId("data-note")).toContainText(archive)
  await shot(page, "s7-03-export")
  await app.close()
  const entries = unzipSync(readFileSync(archive))
  expect(Object.keys(entries)).toContain("robot.db")
  expect(Object.keys(entries).filter((n) => n.startsWith("attachments/")).length).toBe(3)
  for (const data of Object.values(entries))
    expect(Buffer.from(data).includes(GOOD_KEY)).toBe(false)

    // Import: a new, empty app restores everything. Accounts ask to sign in again.
  ;({ app, page } = await launch(freshUserData(), { ...env, ROBOT_TEST_OPEN_PATH: archive }))
  await resizeWindow(app, 1200, 860)
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-data").click()
  await page.getByTestId("data-restore").click()
  await expect(page.getByTestId("data-note")).toContainText("Restored 1 agents")
  await shot(page, "s7-04-imported")
  await page.getByTestId("settings-nav-providers").click()
  await expect(page.getByTestId("provider-status")).toHaveText("Not connected")
  await page.getByTestId("settings-close").click()
  await page.locator("[data-testid^=place-agent-]").filter({ hasText: "Ada" }).click()
  await expect(page.getByTestId("message-file").first()).toContainText("note.txt")
  await expect(page.getByTestId("message").first()).toContainText("[redacted]")

  // A second import is refused: the app is not empty any more.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-data").click()
  await page.getByTestId("data-restore").click()
  await expect(page.getByTestId("data-error")).toContainText("only in an app without")
  await app.close()
  await mock.close()
  expect(existsSync(archive)).toBe(true)
})
