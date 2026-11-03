import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { type ElectronApplication, expect, type Locator, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Pictures from the web (spec 003, "Pictures from the web"; also 000, 011, 012 and 016). A picture
// with an https address is a box until the user loads it. An http picture is a box with no button.
// A data:image picture shows at once. The test server counts every request, so the test can tell
// that nothing reaches it before the button is pressed.

const agentMessages = (page: Page) => page.locator("[data-testid=message][data-author=agent]")
const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })

// A picture of one pixel.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="

/** The host of the pictures. Its pictures come from a server of the test, which counts them. */
const startImageServer = async () => {
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? "")
    res.writeHead(200, { "content-type": "image/png" })
    res.end(Buffer.from(PNG_BASE64, "base64"))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    port,
    /** The path and query of each request that reached the server, in order. */
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}
type ImageServer = Awaited<ReturnType<typeof startImageServer>>

/**
 * `https://host.test` is the test server. A request for it goes to the server of the test, so the
 * test sees it. A request for `http://host.test` must never be made: the route records it.
 */
const routeHost = async (app: ElectronApplication, server: ImageServer, plainHttp: string[]) => {
  const context = app.context()
  await context.route("https://host.test/**", async (route) => {
    const url = new URL(route.request().url())
    const response = await route.fetch({
      url: `http://127.0.0.1:${server.port}${url.pathname}${url.search}`,
    })
    await route.fulfill({ response })
  })
  await context.route("http://host.test/**", async (route) => {
    plainHttp.push(route.request().url())
    await route.abort()
  })
}

/** True when the picture of the page is drawn (it loaded, and it has a size). */
const drawn = (image: Locator) =>
  expect
    .poll(() =>
      image.evaluate(
        (el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth > 0,
      ),
    )
    .toBe(true)

const alphabet = (length: number) =>
  Array.from({ length }, (_, i) => String.fromCharCode(97 + (i % 26))).join("")

test("pictures from the web: a box until the user loads it, http and data:image, restart, knowledge", async () => {
  test.setTimeout(150_000)
  const mock = await startMockProvider()
  const images = await startImageServer()
  const plainHttp: string[] = []
  const userData = freshUserData()
  try {
    let { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
    await resizeWindow(app, 1200, 860)
    await routeHost(app, images, plainHttp)
    // The addresses that were asked for, each one once.
    const addresses = () => [...new Set(images.requests)]
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")

    // A reply with three pictures: https, http and data:image. The mock answers with the text of
    // the message, so the reply holds the Markdown of the three.
    await send(
      page,
      `pictures ![chart](https://host.test/a.png?d=1) ![plain](http://host.test/b.png) ![dot](data:image/png;base64,${PNG_BASE64})`,
    )
    await settled(page)
    const reply = agentMessages(page).nth(0)

    // https: a box with the alt text, the address and the button. Nothing was requested.
    const asked = reply.locator("[data-testid=picture-box][data-picture=ask]")
    await expect(asked).toHaveCount(1)
    await expect(asked.getByTestId("picture-alt")).toHaveText("chart")
    await expect(asked.getByTestId("picture-address")).toHaveText("https://host.test/a.png?d=1")
    await expect(asked.getByTestId("picture-load")).toHaveText("Load image")

    // http: the alt text, no button, and no request of any kind.
    const blocked = reply.locator("[data-testid=picture-box][data-picture=blocked]")
    await expect(blocked).toHaveCount(1)
    await expect(blocked.getByTestId("picture-alt")).toHaveText("plain")
    await expect(blocked.getByTestId("picture-load")).toHaveCount(0)

    // data:image: it shows at once, with no box.
    const dot = reply.locator("img[src^='data:image/png']")
    await expect(dot).toHaveCount(1)
    await drawn(dot)
    await expect(reply.getByTestId("picture-box")).toHaveCount(2)
    await shot(page, "s80-01-boxes")

    // The picture of data:image is drawn, so the page has had its time to ask for a picture.
    expect(images.requests).toEqual([])
    expect(plainHttp).toEqual([])

    // The button loads that one picture. One request arrives, and the picture takes the place of
    // the box.
    await asked.getByTestId("picture-load").click()
    await expect.poll(() => images.requests).toEqual(["/a.png?d=1"])
    const loaded = reply.getByTestId("picture-image")
    await expect(loaded).toHaveCount(1)
    await drawn(loaded)
    await expect(asked).toHaveCount(0)
    // The box of http stays, and the page asks for nothing more.
    await expect(blocked).toHaveCount(1)
    expect(plainHttp).toEqual([])
    await shot(page, "s80-02-loaded")

    // The choice is for that address in that message. A second reply with the same address shows
    // a box, and a different address in the first reply is a box too.
    await send(
      page,
      "pictures ![chart](https://host.test/a.png?d=1) ![other](https://host.test/c.png)",
    )
    await settled(page)
    const second = agentMessages(page).nth(1)
    await expect(second.locator("[data-testid=picture-box][data-picture=ask]")).toHaveCount(2)
    await expect(second.getByTestId("picture-image")).toHaveCount(0)
    expect(images.requests).toEqual(["/a.png?d=1"])

    // The choice holds while the app runs: another page and back shows the picture again.
    await page.getByTestId("page-tasks").click()
    await expect(agentMessages(page)).toHaveCount(0)
    await page.getByTestId("page-chats").click()
    await expect(reply.getByTestId("picture-image")).toHaveCount(1)
    await expect(reply.locator("[data-testid=picture-box][data-picture=ask]")).toHaveCount(0)
    // The picture draws again, so it may ask again (the test turns the cache of the page off).
    // It asks for that address only: the pictures that the user did not load stay unasked.
    await expect.poll(() => addresses()).toEqual(["/a.png?d=1"])

    // Long words: the alt text is cut at 80 characters and the address at 100. An empty alt text
    // shows the word "Image". Nothing loads.
    const alt = alphabet(90)
    const address = `https://host.test/${"0123456789".repeat(12)}.png`
    await send(page, `pictures ![${alt}](${address}) ![](https://host.test/empty.png)`)
    await settled(page)
    const cut = agentMessages(page).nth(2).locator("[data-testid=picture-box]")
    await expect(cut).toHaveCount(2)
    await expect(cut.nth(0).getByTestId("picture-alt")).toHaveText(alt.slice(0, 80))
    await expect(cut.nth(0).getByTestId("picture-address")).toHaveText(address.slice(0, 100))
    await expect(cut.nth(1).getByTestId("picture-alt")).toHaveText("Image")
    expect(addresses()).toEqual(["/a.png?d=1"])

    // A picture in a link: the press loads the picture and does not open the link.
    await send(page, "pictures [![badge](https://host.test/d.png)](https://example.com/docs)")
    await settled(page)
    const linked = agentMessages(page).nth(3)
    const badge = linked.locator("[data-testid=picture-box]")
    await expect(badge).toHaveCount(1)
    await badge.getByTestId("picture-load").click()
    await expect.poll(() => addresses()).toEqual(["/a.png?d=1", "/d.png"])
    await expect(linked.getByTestId("picture-image")).toHaveCount(1)

    // An article of knowledge: a picture in its text is a box too, and the choice is per article.
    await page.getByTestId("chat-header-agent").click()
    await expect(page.getByTestId("agent-profile")).toBeVisible()
    await page.getByTestId("profile-tabs").getByText("Knowledge").click()
    await expect(page.getByTestId("knowledge-page")).toBeVisible()
    await page.getByTestId("knowledge-add").click()
    await page.getByTestId("knowledge-title-input").fill("Charts")
    await page.getByTestId("knowledge-summary-input").fill("A chart of costs")
    await page
      .getByTestId("knowledge-body-input")
      .fill("Costs: ![costs](https://host.test/k.png?d=2) and ![old](http://host.test/k.png)")
    await page.getByTestId("knowledge-save").click()
    await expect(page.getByTestId("knowledge-article-title")).toHaveText("Charts")
    const article = page.getByTestId("knowledge-article")
    await expect(article.locator("[data-testid=picture-box][data-picture=ask]")).toHaveCount(1)
    await expect(article.locator("[data-testid=picture-box][data-picture=blocked]")).toHaveCount(1)
    await expect(article.getByTestId("picture-address")).toHaveText([
      "https://host.test/k.png?d=2",
      "http://host.test/k.png",
    ])
    expect(addresses()).toEqual(["/a.png?d=1", "/d.png"])
    await article.getByTestId("picture-load").click()
    await expect.poll(() => addresses()).toEqual(["/a.png?d=1", "/d.png", "/k.png?d=2"])
    await drawn(article.getByTestId("picture-image"))
    expect(plainHttp).toEqual([])
    await shot(page, "s80-03-knowledge")

    // Restart (in Korean): the choice was not saved. Every box shows again, with the Korean words,
    // and the server of the test has no new request.
    const before = [...images.requests]
    await app.close()
    ;({ app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "ko-KR" }))
    await resizeWindow(app, 1200, 860)
    await routeHost(app, images, plainHttp)
    const again = agentMessages(page).nth(0)
    await expect(again).toBeVisible()
    await expect(again.locator("[data-testid=picture-box][data-picture=ask]")).toHaveCount(1)
    await expect(again.getByTestId("picture-load")).toHaveText("이미지 불러오기")
    await expect(again.getByTestId("picture-image")).toHaveCount(0)
    await expect(again.locator("[data-testid=picture-box][data-picture=blocked]")).toHaveCount(1)
    await drawn(again.locator("img[src^='data:image/png']"))
    await expect(agentMessages(page).nth(2).getByTestId("picture-alt").nth(1)).toHaveText("이미지")
    await shot(page, "s80-04-after-restart")
    expect(images.requests).toEqual(before)
    expect(plainHttp).toEqual([])
    await app.close()
  } finally {
    await images.close()
    await mock.close()
  }
})
