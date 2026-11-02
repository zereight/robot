import { expect, type Page, test } from "@playwright/test"
import { freshUserData, type Launched, launch, resizeWindow, shot } from "./harness.ts"

// Two copies of the app run side by side, each with its own data folder. They find each other on
// 127.0.0.1, so the test needs no network.
const PORT_A = 47851
const PORT_B = 47852

const envFor = (port: number, extra: Record<string, string> = {}) => ({
  ROBOT_SYSTEM_LOCALE: "en-US",
  ROBOT_LINK_ADDRESSES: "127.0.0.1",
  ROBOT_LINK_PORT: String(port),
  // A fast retry, so a test does not wait for a long back-off.
  ROBOT_LINK_RETRY_MAX_MS: "1000",
  ...extra,
})

const start = async (port: number, extra: Record<string, string> = {}): Promise<Launched> => {
  const launched = await launch(freshUserData(), envFor(port, extra))
  await resizeWindow(launched.app, 1200, 860)
  return launched
}

const openDevices = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-devices").click()
  await expect(page.getByTestId("devices-section")).toBeVisible()
}

const closeSettings = async (page: Page) => {
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("devices-section")).toBeHidden()
}

const setName = async (page: Page, name: string) => {
  await page.getByTestId("device-name").fill(name)
  await page.getByTestId("device-name").press("Enter")
  await expect(page.getByTestId("device-name")).toHaveValue(name)
}

/** The pairing screen of a computer. The code and the address come from the screen itself. */
const openPairing = async (page: Page) => {
  await page.getByTestId("pair-open").click()
  const turnOn = page.getByTestId("pair-turn-on")
  if (await turnOn.isVisible().catch(() => false)) await turnOn.click()
  await expect(page.getByTestId("pair-code")).toHaveAttribute("data-code", /^\d{6}$/)
  const code = (await page.getByTestId("pair-code").getAttribute("data-code")) ?? ""
  const address =
    (await page.getByTestId("pair-addresses").locator("li").first().getAttribute("data-address")) ??
    ""
  return { code, address }
}

const fillConnect = async (page: Page, address: string, code: string) => {
  await page.getByTestId("connect-address").fill(address)
  await page.getByTestId("connect-code").fill(code)
  await page.getByTestId("connect-next").click()
}

const serverRow = (page: Page, name: string) =>
  page.locator(`[data-testid=server-row][data-name="${name}"]`)
const clientRow = (page: Page, name: string) =>
  page.locator(`[data-testid=client-row][data-name="${name}"]`)

test("devices: two copies pair, a wrong code and the switch are refused, access can be removed", async () => {
  test.setTimeout(150_000)
  const a = await start(PORT_A)
  const b = await start(PORT_B)
  try {
    // First start: the switch is off, the name is the name of the computer, nothing is linked.
    await openDevices(a.page)
    await expect(a.page.getByTestId("device-accept")).toHaveAttribute("aria-checked", "false")
    await expect(a.page.getByTestId("device-name")).not.toHaveValue("")
    await expect(a.page.getByTestId("devices-vpn")).toBeVisible()
    await expect(a.page.getByTestId("clients-empty")).toBeVisible()
    await expect(a.page.getByTestId("servers-empty")).toBeVisible()
    await shot(a.page, "s18-01-devices-first-start")
    await setName(a.page, "Studio Mac")
    await openDevices(b.page)
    await setName(b.page, "Laptop")

    // "Pair a device" asks before it turns the switch on, then shows QR, code and address.
    await a.page.getByTestId("pair-open").click()
    await expect(a.page.getByTestId("pair-turn-on")).toBeVisible()
    await shot(a.page, "s18-02-turn-on")
    await a.page.getByTestId("pair-turn-on").click()
    await expect(a.page.getByTestId("pair-qr")).toBeVisible()
    await expect(a.page.getByTestId("pair-addresses")).toContainText(`127.0.0.1:${PORT_A}`)
    await expect(a.page.getByTestId("pair-left")).toContainText("The code ends in")
    const code = (await a.page.getByTestId("pair-code").getAttribute("data-code")) ?? ""
    expect(code).toMatch(/^\d{6}$/)
    await a.page.getByTestId("pair-copy").click()
    await expect(a.page.getByTestId("pair-copied")).toBeVisible()
    await shot(a.page, "s18-03-pairing-screen")

    // A wrong code gives a plain line. The right code goes on to the question.
    await b.page.getByTestId("connect-open").click()
    const wrong = code === "000000" ? "111111" : "000000"
    await fillConnect(b.page, `127.0.0.1:${PORT_A}`, wrong)
    await expect(b.page.getByTestId("connect-error")).toContainText("The code is not right")
    await shot(b.page, "s18-04-wrong-code")
    await fillConnect(b.page, `127.0.0.1:${PORT_A}`, code)
    await expect(b.page.getByTestId("connect-found")).toContainText("Studio Mac")
    await expect(b.page.getByTestId("connect-two-way")).toHaveAttribute("aria-checked", "true")
    await shot(b.page, "s18-05-two-way-question")
    await b.page.getByTestId("connect-finish").click()

    // The first computer asks before it lets the other one in.
    await expect(a.page.getByTestId("join-dialog")).toBeVisible()
    await expect(a.page.getByTestId("join-dialog")).toContainText("Allow Laptop?")
    await expect(a.page.getByTestId("join-dialog")).toContainText(
      "steps that change files and run commands",
    )
    await expect(a.page.getByTestId("join-two-way")).toBeVisible()
    // The switch "Let <device name> create and change agents" is on at first, with its text.
    await expect(a.page.getByTestId("join-can-change")).toHaveAttribute("aria-checked", "true")
    await expect(a.page.getByTestId("join-dialog")).toContainText(
      "Let Laptop create and change agents",
    )
    await expect(a.page.getByTestId("join-can-change-body")).toContainText(
      "agents, channels and memory on this computer",
    )
    await shot(a.page, "s18-06-allow-dialog")
    await a.page.getByTestId("join-allow").click()
    await expect(b.page.getByTestId("connect-dialog")).toBeHidden()

    // The code was used once, so the pairing screen says so.
    await expect(a.page.getByTestId("pair-ended")).toContainText("The code was used")
    await a.page.getByTestId("pair-close").click()

    // Both lists show the other computer, and both ways work (the question was answered yes).
    await expect(clientRow(a.page, "Laptop")).toBeVisible()
    await expect(serverRow(b.page, "Studio Mac")).toBeVisible()
    await expect(clientRow(b.page, "Studio Mac")).toBeVisible()
    await expect(serverRow(a.page, "Laptop")).toBeVisible()
    await expect(serverRow(b.page, "Studio Mac").getByTestId("server-row-state")).toHaveAttribute(
      "data-state",
      "online",
    )
    await expect(serverRow(a.page, "Laptop").getByTestId("server-row-state")).toHaveAttribute(
      "data-state",
      "online",
    )
    await expect(a.page.getByTestId("device-accept")).toHaveAttribute("aria-checked", "true")
    await expect(b.page.getByTestId("device-accept")).toHaveAttribute("aria-checked", "true")
    await shot(a.page, "s18-07-linked")
    await shot(b.page, "s18-08-linked-other-side")

    // The row of the device has the switch "Can create and change agents": on, as the dialog was
    // left. It turns off and on again. The other side was not asked, so it starts off there.
    const change = (page: Page, name: string) =>
      clientRow(page, name).getByTestId("client-can-change")
    await expect(change(a.page, "Laptop")).toHaveAttribute("aria-checked", "true")
    await expect(clientRow(a.page, "Laptop")).toContainText("Can create and change agents")
    await expect(change(a.page, "Laptop")).toBeEnabled()
    await change(a.page, "Laptop").click()
    await expect(change(a.page, "Laptop")).toHaveAttribute("aria-checked", "false")
    await change(a.page, "Laptop").click()
    await expect(change(a.page, "Laptop")).toHaveAttribute("aria-checked", "true")
    await expect(change(b.page, "Studio Mac")).toHaveAttribute("aria-checked", "false")

    // A code works once: the same code does not let a third try in.
    await b.page.getByTestId("connect-open").click()
    await fillConnect(b.page, `127.0.0.1:${PORT_A}`, code)
    await expect(b.page.getByTestId("connect-error")).toContainText("This code has ended")
    await b.page.getByTestId("connect-cancel").click()

    // A computer cannot pair with itself.
    await a.page.evaluate(() => window.robot.invoke("devices.pair.start", undefined))
    const own = await a.page.evaluate(async () => {
      const result = await window.robot.invoke("devices.pair.get", undefined)
      return result.ok ? result.value : undefined
    })
    expect(own?.active).toBe(true)
    await a.page.getByTestId("connect-open").click()
    await fillConnect(a.page, `127.0.0.1:${PORT_A}`, own?.code ?? "")
    await expect(a.page.getByTestId("connect-error")).toContainText("This is the same computer")
    await shot(a.page, "s18-09-same-computer")
    await a.page.getByTestId("connect-cancel").click()
    await a.page.evaluate(() => window.robot.invoke("devices.pair.stop", undefined))

    // With the switch off the computer accepts no connection. The linked computer is cut off,
    // and a new link is refused with a plain line.
    await a.page.getByTestId("device-accept").click()
    await expect(a.page.getByTestId("device-accept")).toHaveAttribute("aria-checked", "false")
    await expect(
      serverRow(b.page, "Studio Mac").getByTestId("server-row-state"),
    ).not.toHaveAttribute("data-state", "online", { timeout: 15_000 })
    await b.page.getByTestId("connect-open").click()
    await fillConnect(b.page, `127.0.0.1:${PORT_A}`, "123456")
    await expect(b.page.getByTestId("connect-error")).toContainText("does not accept connections")
    await shot(b.page, "s18-10-switch-off")
    await b.page.getByTestId("connect-cancel").click()

    // On again: the linked computer comes back with no new pairing.
    await a.page.getByTestId("device-accept").click()
    await expect(a.page.getByTestId("device-accept")).toHaveAttribute("aria-checked", "true")
    await expect(serverRow(b.page, "Studio Mac").getByTestId("server-row-state")).toHaveAttribute(
      "data-state",
      "online",
      { timeout: 20_000 },
    )

    // Remove access: the device leaves the list, and its own list says "Pair again".
    await clientRow(a.page, "Laptop").getByTestId("client-remove").click()
    await expect(clientRow(a.page, "Laptop")).toHaveCount(0)
    await expect(serverRow(b.page, "Studio Mac").getByTestId("server-row-state")).toHaveAttribute(
      "data-state",
      "not_allowed",
      { timeout: 15_000 },
    )
    await expect(serverRow(b.page, "Studio Mac").getByTestId("server-row-state")).toHaveText(
      "Pair again",
    )
    await shot(b.page, "s18-11-access-removed")

    // The other computer can drop the entry.
    await serverRow(b.page, "Studio Mac").getByTestId("server-remove").click()
    await expect(serverRow(b.page, "Studio Mac")).toHaveCount(0)
    await closeSettings(a.page)
  } finally {
    await a.app.close()
    await b.app.close()
  }
})

test("devices: a one-way link goes one way only, and the address of a server can be edited", async () => {
  test.setTimeout(120_000)
  const a = await start(PORT_A)
  const b = await start(PORT_B)
  try {
    await openDevices(a.page)
    await setName(a.page, "Studio Mac")
    const { code, address } = await openPairing(a.page)
    await openDevices(b.page)
    await b.page.getByTestId("connect-open").click()
    await b.page.getByTestId("connect-address").fill(address)
    await b.page.getByTestId("connect-code").fill(code)
    await b.page.getByTestId("connect-next").click()
    await b.page.getByTestId("connect-two-way").click()
    await expect(b.page.getByTestId("connect-two-way")).toHaveAttribute("aria-checked", "false")
    await b.page.getByTestId("connect-finish").click()
    await a.page.getByTestId("join-allow").click()
    await expect(b.page.getByTestId("connect-dialog")).toBeHidden()
    await a.page.getByTestId("pair-close").click()

    // One way only: the joining computer opens the other, not the other way around.
    await expect(serverRow(b.page, "Studio Mac")).toBeVisible()
    await expect(a.page.getByTestId("servers-empty")).toBeVisible()
    await expect(b.page.getByTestId("clients-empty")).toBeVisible()

    // A bad address is refused with a plain line; a good one is saved.
    const row = serverRow(b.page, "Studio Mac")
    await row.getByTestId("server-edit").click()
    await row.getByTestId("server-addresses-input").fill("not an address")
    await row.getByTestId("server-addresses-save").click()
    await expect(row.getByTestId("server-addresses-error")).toContainText("This is not an address")
    await row.getByTestId("server-addresses-input").fill(`127.0.0.1:${PORT_A}`)
    await row.getByTestId("server-addresses-save").click()
    await expect(row.getByTestId("server-row-addresses")).toHaveText(`127.0.0.1:${PORT_A}`)
    await shot(b.page, "s18-12-edit-address")
  } finally {
    await a.app.close()
    await b.app.close()
  }
})

test("devices: a code that has ended is refused", async () => {
  test.setTimeout(90_000)
  const a = await start(PORT_A, { ROBOT_LINK_CODE_TTL_MS: "2500" })
  const b = await start(PORT_B)
  try {
    await openDevices(a.page)
    const { code, address } = await openPairing(a.page)
    await expect(a.page.getByTestId("pair-ended")).toContainText("The code has ended", {
      timeout: 15_000,
    })
    await shot(a.page, "s18-13-code-ended")
    await openDevices(b.page)
    await b.page.getByTestId("connect-open").click()
    await fillConnect(b.page, address, code)
    await expect(b.page.getByTestId("connect-error")).toContainText("This code has ended")
    await shot(b.page, "s18-14-code-ended-other-side")
  } finally {
    await a.app.close()
    await b.app.close()
  }
})
