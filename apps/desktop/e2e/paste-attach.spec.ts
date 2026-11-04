import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { type ElectronApplication, expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Paste and drop in the message box (spec 003, flow 4): a picture or a video that has no file on
// disk is saved first, then attached. The clipboard is the real clipboard of the system, and the
// paste is a real paste of the window.

/** A picture of one pixel. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

/** Puts text, a picture or both on the clipboard of the system. */
const putOnClipboard = (app: ElectronApplication, items: { text?: string; png?: string }) =>
  app.evaluate(async ({ clipboard, ClipboardItem }, { text, png }) => {
    const entry: Record<string, string | Blob> = {}
    if (text !== undefined) entry["text/plain"] = text
    if (png) entry["image/png"] = new Blob([Buffer.from(png, "base64")], { type: "image/png" })
    await clipboard.write([new ClipboardItem(entry)])
  }, items)

/** Pastes into the message box, as the paste shortcut does. */
const pasteIntoBox = async (app: ElectronApplication, page: Page) => {
  await page.getByTestId("composer-input").focus()
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((w) => w.getTitle() === "ROBot")
      ?.webContents.paste()
  })
}

/**
 * Drops files that have no path on disk (the files of a web page) on the message box. A file with
 * `draw` is a real picture of that size. The others hold zero bytes.
 */
const dropOnBox = (
  page: Page,
  files: { name: string; type: string; bytes: number; draw?: { width: number; height: number } }[],
) =>
  page.getByTestId("composer-input").evaluate(async (box, list) => {
    const data = new DataTransfer()
    for (const f of list) {
      let part: BlobPart = new Uint8Array(f.bytes)
      if (f.draw) {
        const canvas = document.createElement("canvas")
        canvas.width = f.draw.width
        canvas.height = f.draw.height
        const context = canvas.getContext("2d")
        if (context) {
          context.fillStyle = "#3366cc"
          context.fillRect(0, 0, canvas.width, canvas.height)
        }
        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, "image/png"),
        )
        if (blob) part = blob
      }
      data.items.add(new File([part], f.name, { type: f.type }))
    }
    box.dispatchEvent(
      new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }),
    )
  }, files)

const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)

test("paste a picture or text into the box, drop files that have no path, and send", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const box = page.getByTestId("composer-input")
  const chips = page.getByTestId("attachment-chip")
  const previews = page.getByTestId("attachment-preview")

  // A screenshot on the clipboard: a chip with a small preview. The paste does not reach the text.
  await putOnClipboard(app, { png: PNG_BASE64 })
  await pasteIntoBox(app, page)
  await expect(chips).toHaveCount(1)
  await expect(chips.first()).toContainText("image.png")
  await expect(previews).toHaveCount(1)
  await expect
    .poll(() => previews.first().evaluate((i: HTMLImageElement) => i.naturalWidth))
    .toBe(1)
  await expect(box).toHaveValue("")
  await shot(page, "paste-01-pasted")

  // Text on the clipboard pastes as text, and no chip comes.
  await putOnClipboard(app, { text: "alpha beta" })
  await pasteIntoBox(app, page)
  await expect(box).toHaveValue("alpha beta")
  await expect(chips).toHaveCount(1)

  // Text and a picture together (a copied table): the text wins and nothing is attached.
  await putOnClipboard(app, { text: " gamma", png: PNG_BASE64 })
  await pasteIntoBox(app, page)
  await expect(box).toHaveValue("alpha beta gamma")
  await expect(chips).toHaveCount(1)

  // A picture and a video dropped from a web page have no path. The video has no preview.
  await dropOnBox(page, [
    { name: "dropped.png", type: "image/png", bytes: 8 },
    { name: "clip.mov", type: "video/quicktime", bytes: 16 },
  ])
  await expect(chips).toHaveCount(3)
  await expect(previews).toHaveCount(2)
  await expect(chips.nth(1)).toContainText("dropped.png")
  await expect(chips.nth(2)).toContainText("clip.mov")

  // A file over 20 MB is refused with a line, and the chips stay as they were.
  await dropOnBox(page, [{ name: "big.mov", type: "video/quicktime", bytes: 21 * 1024 * 1024 }])
  await expect(page.getByTestId("composer-error")).toContainText("big.mov is larger than 20 MB")
  await expect(chips).toHaveCount(3)

  // A chip that is removed takes its preview with it.
  await chips.nth(1).getByTestId("attachment-remove").click()
  await expect(chips).toHaveCount(2)
  await expect(previews).toHaveCount(1)

  // A real picture that is larger than the small picture is cut down when it shows after the send.
  await dropOnBox(page, [
    { name: "wide.png", type: "image/png", bytes: 0, draw: { width: 600, height: 300 } },
  ])
  await expect(chips).toHaveCount(3)
  await expect(previews).toHaveCount(2)

  // The send copies the saved files into the workspace of the agent.
  await box.press("Enter")
  await expect(page.getByTestId("message-file")).toHaveCount(3)
  await expect(chips).toHaveCount(0)
  await expect(previews).toHaveCount(0)
  await settled(page)

  // The sent message shows a small picture for each image, above its text, and none for the video.
  // The chips stay below the text, so a file can still be opened.
  const sentPictures = page.getByTestId("message-picture")
  await expect(sentPictures).toHaveCount(2)
  const small = page.locator("[data-testid=message-picture][alt='image.png']")
  const wide = page.locator("[data-testid=message-picture][alt='wide.png']")
  await expect.poll(() => small.evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(1)
  // 600 x 300 is cut down to 256 x 128: the longer side is 256, and the proportions stay.
  await expect
    .poll(() => wide.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]))
    .toEqual([256, 128])
  // It shows at half of that, and the whole row stays inside the box of 128 px.
  const shown = await wide.boundingBox()
  expect(shown?.width).toBeLessThanOrEqual(130)
  expect(shown?.height).toBeLessThanOrEqual(130)
  const text = await page.locator("[data-testid=message][data-author=user] p").first().boundingBox()
  expect(shown?.y ?? 0).toBeLessThan(text?.y ?? 0)
  const fileChip = await page.getByTestId("message-file").first().boundingBox()
  expect(fileChip?.y ?? 0).toBeGreaterThan(text?.y ?? 0)
  await expect(page.getByTestId("message-pictures")).toHaveCount(1)
  await shot(page, "paste-02-sent")

  // A press on a small picture shows it enlarged, at the full size of the file. Escape closes it.
  await page.getByRole("button", { name: "Enlarge wide.png" }).click()
  const viewer = page.getByTestId("picture-viewer")
  await expect(viewer).toBeVisible()
  const large = page.getByTestId("picture-viewer-image")
  await expect
    .poll(() => large.evaluate((i: HTMLImageElement) => [i.naturalWidth, i.naturalHeight]))
    .toEqual([600, 300])
  const enlarged = await large.boundingBox()
  expect(enlarged?.width).toBeGreaterThan(shown?.width ?? 0)
  await shot(page, "paste-03-enlarged")
  await page.keyboard.press("Escape")
  await expect(viewer).toHaveCount(0)
  const copies = readdirSync(userData, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.parentPath.endsWith("attachments"))
    .sort((a, b) => a.name.localeCompare(b.name))
  expect(copies.map((e) => e.name)).toEqual(["clip.mov", "image.png", "wide.png"])
  // The system may encode the picture again, so the bytes can differ. It is still a picture of
  // one pixel.
  const image = copies.find((e) => e.name === "image.png")
  const saved = readFileSync(join(image?.parentPath ?? "", "image.png"))
  expect([...saved.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  expect([saved.readUInt32BE(16), saved.readUInt32BE(20)]).toEqual([1, 1])
  // A file without a picture keeps its bytes.
  const clip = copies.find((e) => e.name === "clip.mov")
  expect(readFileSync(join(clip?.parentPath ?? "", "clip.mov"))).toEqual(Buffer.alloc(16))
  await app.close()
  await mock.close()
})
