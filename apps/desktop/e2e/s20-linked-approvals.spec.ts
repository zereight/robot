import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { freeNearbyPort, freePortPair, multicastWorks } from "./ports.ts"

// MacBook 1 answers the approvals of MacBook 2. Two copies of the app run side by side, each with
// its own data folder. They find each other with the network name service on a port of their own,
// so a test run does not disturb the real one.
const envFor = (port: number, nearby: number, extra: Record<string, string> = {}) => ({
  ROBOT_SYSTEM_LOCALE: "en-US",
  ROBOT_LINK_ADDRESSES: "127.0.0.1",
  ROBOT_LINK_PORT: String(port),
  ROBOT_LINK_RETRY_MAX_MS: "1000",
  ROBOT_LINK_NEARBY_PORT: String(nearby),
  ...extra,
})

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 20_000,
  })
const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const clientRow = (page: Page, name: string) =>
  page.locator(`[data-testid=client-row][data-name="${name}"]`)

const setName = async (page: Page, name: string) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-devices").click()
  await page.getByTestId("device-name").fill(name)
  await page.getByTestId("device-name").press("Enter")
  await expect(page.getByTestId("device-name")).toHaveValue(name)
}

const files = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)],
      )
    : []

test("linked server: approvals, questions and tasks are answered from another computer, and access can be removed", async () => {
  test.setTimeout(300_000)
  const [PORT_1, PORT_2] = await freePortPair()
  const NEARBY = await freeNearbyPort()
  // Some hosted test machines block multicast, and then no computer can find another by name. The
  // list of nearby computers is checked where it works; the rest of the flow does not need it.
  const multicast = await multicastWorks(NEARBY)
  const mock = await startMockProvider()
  const data1 = freshUserData()
  const data2 = freshUserData()
  const outside = join(data2, "outside")
  mkdirSync(outside, { recursive: true })
  const notices = join(data1, "notices.jsonl")
  const noticed = (): { title: string; body: string }[] =>
    existsSync(notices)
      ? readFileSync(notices, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { title: string; body: string })
      : []

  const two = await launch(data2, envFor(PORT_2, NEARBY))
  const one = await launch(
    data1,
    envFor(PORT_1, NEARBY, { ROBOT_TEST_NOTIFY_LOG: notices, ROBOT_TEST_UNFOCUSED: "1" }),
  )
  try {
    await resizeWindow(two.app, 1200, 860)
    await resizeWindow(one.app, 1200, 860)
    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(two.page, "Ada")
    await setName(two.page, "MacBook 2")
    await two.page.getByTestId("settings-close").click()
    await setName(one.page, "MacBook 1")
    await one.page.getByTestId("settings-close").click()

    // No computer shows a code yet, so the connect dialog of MacBook 1 lists none.
    await one.page.getByTestId("server-add").click()
    if (multicast) {
      await expect(one.page.getByTestId("connect-nearby")).toContainText(
        "No computer shows a pairing code now.",
        { timeout: 15_000 },
      )
      await expect(one.page.getByTestId("connect-nearby-item")).toHaveCount(0)
    }

    // MacBook 2 shows a code: it appears in the list by name, and a click fills the address.
    await two.page.getByTestId("open-settings").click()
    await two.page.getByTestId("settings-nav-devices").click()
    await two.page.getByTestId("pair-open").click()
    await two.page.getByTestId("pair-turn-on").click()
    await expect(two.page.getByTestId("pair-code")).toHaveAttribute("data-code", /^\d{6}$/)
    const code = (await two.page.getByTestId("pair-code").getAttribute("data-code")) ?? ""
    if (multicast) {
      await expect(one.page.getByTestId("connect-nearby-item")).toHaveCount(1, { timeout: 20_000 })
      await expect(one.page.getByTestId("connect-nearby-item")).toContainText("MacBook 2")
      await shot(one.page, "s20-01-nearby")
      await one.page.getByTestId("connect-nearby-item").click()
    } else {
      test.info().annotations.push({
        type: "multicast blocked",
        description:
          "This computer blocks multicast: the list of nearby computers was not checked.",
      })
      await one.page.getByTestId("connect-address").fill(`127.0.0.1:${PORT_2}`)
    }
    await expect(one.page.getByTestId("connect-address")).toHaveValue(`127.0.0.1:${PORT_2}`)
    await one.page.getByTestId("connect-code").fill(code)
    await one.page.getByTestId("connect-next").click()
    await one.page.getByTestId("connect-two-way").click() // one way is enough here
    await one.page.getByTestId("connect-finish").click()
    await two.page.getByTestId("join-allow").click()
    await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
    await two.page.getByTestId("pair-close").click()
    await two.page.getByTestId("settings-close").click()

    await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online", {
      timeout: 20_000,
    })
    await tile(one.page, "MacBook 2").click()
    await one.page.locator("[data-testid^=place-agent-]").first().click()
    await expect(one.page.getByTestId("chat-header-agent")).toContainText("Ada")
    await two.page.locator("[data-testid^=place-agent-]").first().click()

    // A risky step of the agent waits. MacBook 1 gets a notice that names MacBook 2.
    const keep = join(outside, "keep.txt")
    const gone = join(outside, "gone.txt")
    writeFileSync(keep, "keep me")
    writeFileSync(gone, "delete me")
    await send(one.page, `TOOL run_command ${JSON.stringify({ command: `rm "${gone}"` })}`)
    await expect(one.page.getByTestId("ask-card")).toBeVisible({ timeout: 20_000 })
    await expect(two.page.getByTestId("ask-card")).toBeVisible({ timeout: 20_000 })
    expect(existsSync(gone)).toBe(true)
    // A client cannot make "always allow" for the agent. The computer of the agent can.
    await expect(one.page.getByTestId("ask-always")).toHaveCount(0)
    await expect(two.page.getByTestId("ask-always")).toHaveCount(1)
    await expect
      .poll(() => noticed().filter((n) => n.title === "Ada · MacBook 2").length, {
        timeout: 15_000,
      })
      .toBe(1)
    expect(noticed().find((n) => n.title === "Ada · MacBook 2")?.body).toContain("gone.txt")
    await shot(one.page, "s20-02-approval-on-client")

    // MacBook 1 allows: the step runs on MacBook 2, and the card there says who allowed it.
    await one.page.getByTestId("ask-allow").click()
    await expect.poll(() => existsSync(gone), { timeout: 20_000 }).toBe(false)
    await settled(one.page)
    await settled(two.page)
    await expect(two.page.getByTestId("tool-decision").first()).toHaveText("Allowed by MacBook 1")
    await expect(one.page.getByTestId("tool-decision").first()).toHaveText("Allowed by MacBook 1")
    await expect(two.page.getByTestId("ask-card")).toHaveCount(0)
    await shot(two.page, "s20-03-allowed-by")

    // A request that MacBook 1 answered does not notify again.
    expect(
      noticed().filter((n) => n.title === "Ada · MacBook 2" && n.body.includes("gone.txt")),
    ).toHaveLength(1)

    // A mute of MacBook 2 on MacBook 1 holds: the next request waits, but no notice shows.
    const before = noticed().length
    await one.page.getByTestId("open-settings").click()
    await one.page.getByTestId("settings-nav-notifications").click()
    await expect(one.page.getByTestId("mute-server")).toBeVisible()
    await expect(one.page.getByText("Server MacBook 2")).toBeVisible()
    await one.page.getByTestId("mute-server").selectOption("1h")
    await shot(one.page, "s20-04-mute-server")
    await one.page.getByTestId("settings-close").click()

    // Deny from MacBook 1: the file stays, and the card says "Denied by".
    await send(one.page, `TOOL run_command ${JSON.stringify({ command: `rm "${keep}"` })}`)
    await expect(one.page.getByTestId("ask-card")).toBeVisible({ timeout: 20_000 })
    await one.page.getByTestId("ask-deny").click()
    await settled(one.page)
    await settled(two.page)
    expect(existsSync(keep)).toBe(true)
    expect(noticed().filter((n) => n.title.includes("MacBook 2")).length).toBe(before)
    await expect(two.page.getByTestId("tool-decision").last()).toHaveText("Denied by MacBook 1")

    // A question from the agent is answered on MacBook 1, and the agent goes on with the answer.
    await send(one.page, `TOOL ask_user ${JSON.stringify({ question: "Which colour?" })}`)
    await expect(one.page.getByTestId("ask-card")).toContainText("Which colour?", {
      timeout: 20_000,
    })
    await one.page.getByTestId("ask-input").fill("green")
    await one.page.getByTestId("ask-send").click()
    await settled(one.page)
    await expect(one.page.getByTestId("message").last()).toContainText("Tool said: green")
    await expect(two.page.getByTestId("message").last()).toContainText("Tool said: green", {
      timeout: 15_000,
    })

    // Turn the mute off again: the next request notifies.
    await one.page.getByTestId("open-settings").click()
    await one.page.getByTestId("settings-nav-notifications").click()
    await one.page.getByTestId("mute-server").selectOption("off")
    await one.page.getByTestId("settings-close").click()

    // Tasks of MacBook 2 show on MacBook 1. A task that waits for an answer can be stopped there.
    await send(one.page, `TOOL run_command ${JSON.stringify({ command: "sudo ls" })}`)
    await expect(one.page.getByTestId("ask-card")).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(() => noticed().filter((n) => n.title === "Ada · MacBook 2").length, {
        timeout: 15_000,
      })
      .toBe(2)
    await one.page.getByTestId("page-tasks").click()
    await expect(one.page.getByTestId("tasks-table")).toBeVisible()
    await expect(one.page.locator("[data-testid=task-row][data-state=waiting]")).toHaveCount(1, {
      timeout: 15_000,
    })
    await shot(one.page, "s20-04-tasks")
    await one.page
      .locator("[data-testid=task-row][data-state=waiting]")
      .getByTestId("task-open")
      .click()
    await expect(one.page.getByTestId("task-detail")).toBeVisible()
    await expect(one.page.getByTestId("task-retry")).toHaveCount(0)
    await one.page.getByTestId("task-stop").click()
    await expect(one.page.getByTestId("task-detail-state")).toHaveAttribute(
      "data-state",
      /cancelled|failed/,
      { timeout: 20_000 },
    )
    await one.page.getByRole("button", { name: "Close" }).click()
    await expect(two.page.getByTestId("ask-card")).toHaveCount(0, { timeout: 15_000 })
    await one.page.getByTestId("page-chats").click()

    // The cache of MacBook 2 is on disk of MacBook 1 while the link lives.
    await expect
      .poll(() => files(join(data1, "link-cache")).length, { timeout: 15_000 })
      .toBeGreaterThan(0)

    // Remove access on MacBook 2: the tile on MacBook 1 shows "Pair again", and the cache is gone.
    await two.page.getByTestId("open-settings").click()
    await two.page.getByTestId("settings-nav-devices").click()
    await clientRow(two.page, "MacBook 1").getByTestId("client-remove").click()
    await expect(clientRow(two.page, "MacBook 1")).toHaveCount(0)
    await two.page.getByTestId("settings-close").click()

    await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "not_allowed", {
      timeout: 20_000,
    })
    await expect(one.page.getByTestId("server-notice")).toContainText("Pair again")
    // The window holds nothing of that server any more, and the message box says why.
    await expect(one.page.locator("[data-testid^=place-agent-]")).toHaveCount(0, {
      timeout: 15_000,
    })
    await expect(one.page.getByTestId("composer-offline")).toHaveCount(0)
    await expect.poll(() => files(join(data1, "link-cache")).length, { timeout: 15_000 }).toBe(0)
    await shot(one.page, "s20-05-pair-again")

    // "Pair again" opens the connect dialog.
    await one.page.getByTestId("pair-again").click()
    await expect(one.page.getByTestId("connect-dialog")).toBeVisible()
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})
