import { readdirSync } from "node:fs"
import { expect, type Page, test } from "@playwright/test"
import {
  connectMock,
  createAgent,
  freshUserData,
  type Launched,
  launch,
  resizeWindow,
  shot,
} from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { freePortPair } from "./ports.ts"
import {
  closeSettings,
  envFor,
  openDevices,
  report,
  send,
  serverRow,
  setName,
  settled,
  turnOnSync,
} from "./sync-helpers.ts"

// Spec 012, "Create and change agents". MacBook 1 (the client) works with the agents and channels
// of MacBook 2 (the server). Two copies of the app run side by side, each with its own data
// folder, and find each other on 127.0.0.1.

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const clientRow = (page: Page, name: string) =>
  page.locator(`[data-testid=client-row][data-name="${name}"]`)
const placeOf = (page: Page, name: string) =>
  page.locator("[data-testid^=place-agent-]", { hasText: new RegExp(`^${name}`) })
const names = async (page: Page) =>
  (await page.locator("[data-testid^=place-agent-]").allInnerTexts())
    .map((t) => t.split("\n")[0]?.trim() ?? "")
    .filter(Boolean)
    .sort()

interface Reply {
  readonly ok: boolean
  readonly code: string
  readonly message: string
}

/** A request for the linked server as the window of MacBook 1 makes it. Never throws. */
const ask = (page: Page, serverId: string, method: string, input?: unknown) =>
  page.evaluate(
    async ([m, i, s]) => {
      // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
      const r = await (window as any).robot.invoke(m, i, s)
      return r.ok
        ? { ok: true, code: "ok", message: "" }
        : { ok: false, code: r.error.code as string, message: r.error.message as string }
    },
    [method, input, serverId] as [string, unknown, string],
  ) as Promise<Reply>

const linkedServerId = (page: Page) =>
  page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
    const result = await (window as any).robot.invoke("servers.list")
    return (result.value as { id: string; kind: string }[]).find((s) => s.kind === "linked")?.id
  }) as Promise<string>

const agentIdOf = (page: Page, name: string) =>
  page.evaluate(async (wanted) => {
    // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
    const bridge = (window as any).robot
    const servers = (await bridge.invoke("servers.list")).value as { id: string; kind: string }[]
    const local = servers.find((x) => x.kind === "local")?.id
    const list = (await bridge.invoke("agents.list", { serverId: local, archived: false }))
      .value as { id: string; name: string }[]
    return list.find((a) => a.name === wanted)?.id ?? ""
  }, name)

/** Escape closes a dialog; it leaves after its exit motion. */
const dismiss = async (page: Page, testId: string) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId(testId)).toBeHidden()
}

/** MacBook 2 shows a code; MacBook 1 connects one way. `canChange` is the switch of the dialog. */
const pairOneWay = async (one: Launched, two: Launched, canChange: boolean) => {
  await openDevices(two.page)
  await two.page.getByTestId("pair-open").click()
  await two.page.getByTestId("pair-turn-on").click()
  await expect(two.page.getByTestId("pair-code")).toHaveAttribute("data-code", /^\d{6}$/)
  const code = (await two.page.getByTestId("pair-code").getAttribute("data-code")) ?? ""
  const address =
    (await two.page
      .getByTestId("pair-addresses")
      .locator("li")
      .first()
      .getAttribute("data-address")) ?? ""
  await one.page.getByTestId("server-add").click()
  await one.page.getByTestId("connect-address").fill(address)
  await one.page.getByTestId("connect-code").fill(code)
  await one.page.getByTestId("connect-next").click()
  await one.page.getByTestId("connect-two-way").click() // one way is enough here
  await one.page.getByTestId("connect-finish").click()
  // The switch "Let <device name> create and change agents" is on at first.
  await expect(two.page.getByTestId("join-can-change")).toHaveAttribute("aria-checked", "true")
  if (!canChange) await two.page.getByTestId("join-can-change").click()
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

const start = async (ports: [number, number], extra: Record<string, string> = {}) => {
  const mock = await startMockProvider()
  const data2 = freshUserData()
  const two = await launch(data2, envFor(ports[1], extra))
  const one = await launch(freshUserData(), envFor(ports[0], extra))
  await resizeWindow(two.app, 1200, 860)
  await resizeWindow(one.app, 1200, 860)
  await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
  await openDevices(two.page)
  await setName(two.page, "MacBook 2")
  await closeSettings(two.page)
  await openDevices(one.page)
  await setName(one.page, "MacBook 1")
  await closeSettings(one.page)
  return { mock, data2, one, two }
}

test("linked agents: a client with the switch makes and changes agents, channels and memory", async () => {
  test.setTimeout(240_000)
  const s = await start(await freePortPair())
  const { one, two, mock } = s
  try {
    await pairOneWay(one, two, true)
    await closeSettings(two.page)
    await tile(one.page, "MacBook 2").click()
    const serverId = await linkedServerId(one.page)

    // The plus buttons show only because the server lets this device change agents.
    await expect(one.page.getByTestId("new-agent")).toBeVisible()
    await expect(one.page.getByTestId("new-channel")).toBeVisible()

    // Create "Writer" with a model of the server.
    await one.page.getByTestId("new-agent").click()
    await one.page.getByTestId("agent-name").fill("Writer")
    await one.page.getByTestId("agent-instructions").fill("Write short notes.")
    await one.page.getByTestId("model-model").waitFor()
    await shot(one.page, "s24-01-client-new-agent")
    await one.page.getByTestId("agent-submit").click()
    await expect(one.page.getByTestId("chat-start").filter({ hasText: "Writer" })).toBeVisible()
    await expect(placeOf(two.page, "Writer")).toBeVisible()

    // On MacBook 2: a new empty folder, the level "Ask for risky steps", and who changed it.
    await placeOf(two.page, "Writer").click()
    await two.page.getByTestId("chat-header-agent").click()
    await expect(two.page.getByTestId("agent-changed-by")).toContainText(
      "Last changed by MacBook 1",
    )
    const folder =
      (await two.page
        .locator("[data-testid=agent-profile] [data-user-data][title]")
        .first()
        .getAttribute("title")) ?? ""
    expect(folder).toContain("workspaces")
    expect(readdirSync(folder)).toEqual([])
    await expect(
      two.page.locator("[data-testid=agent-permission] input[value=ask_risky]"),
    ).toBeChecked()
    await shot(two.page, "s24-02-server-profile-last-changed-by")
    await dismiss(two.page, "agent-profile")

    // On MacBook 1: the same profile, with no path, no picture, no memory switch, and a level
    // that can only get stricter.
    await placeOf(one.page, "Writer").click()
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.getByTestId("agent-workspace-on")).toHaveText("Workspace: on MacBook 2")
    await expect(
      one.page.locator("[data-testid=agent-profile] [data-user-data][title]"),
    ).toHaveCount(0)
    await expect(one.page.getByTestId("agent-changed-by")).toContainText(
      "Last changed by MacBook 1",
    )
    await expect(one.page.getByTestId("face-file")).toHaveCount(0)
    await expect(one.page.getByTestId("agent-memory-enabled")).toHaveCount(0)
    // The agent is at "Ask for risky steps": a client offers it and every stricter level, with
    // "Read only" too (007, 012). It offers no looser level.
    await expect(one.page.locator("[data-testid=agent-permission] label")).toHaveCount(3)
    await expect(
      one.page.locator("[data-testid=agent-permission] label[data-value=read_only]"),
    ).toHaveCount(1)
    await expect(
      one.page.locator("[data-testid=agent-permission] label[data-value=full]"),
    ).toHaveCount(0)
    await expect(one.page.getByTestId("agent-permission-stricter")).toBeVisible()
    await shot(one.page, "s24-03-client-profile")

    // Edit the instructions from MacBook 1: MacBook 2 has them at once, and the next turn uses them.
    await one.page.getByTestId("agent-instructions").fill("Write notes about SECRET-TOPIC.")
    await one.page.getByTestId("agent-submit").click()
    await expect(one.page.getByTestId("agent-profile")).toBeHidden()
    await two.page.getByTestId("chat-header-agent").click()
    await expect(two.page.getByTestId("agent-instructions")).toHaveValue(
      "Write notes about SECRET-TOPIC.",
    )
    await dismiss(two.page, "agent-profile")
    await send(two.page, "hello Writer")
    await settled(two.page)
    const sent = JSON.stringify(
      mock.requests.filter((r) => r.path.endsWith("/chat/completions")).at(-1)?.body,
    )
    expect(sent).toContain("SECRET-TOPIC")

    // The level: stricter works; afterwards no looser level is offered, and a request for one
    // gets "Not allowed" from the server.
    await one.page.getByTestId("chat-header-agent").click()
    await one.page.locator("[data-testid=agent-permission] label[data-value=ask_all]").click()
    await one.page.getByTestId("agent-submit").click()
    await expect(one.page.getByTestId("agent-profile")).toBeHidden()
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.locator("[data-testid=agent-permission] label")).toHaveCount(2)
    await dismiss(one.page, "agent-profile")
    await two.page.getByTestId("chat-header-agent").click()
    await expect(
      two.page.locator("[data-testid=agent-permission] input[value=ask_all]"),
    ).toBeChecked()
    await dismiss(two.page, "agent-profile")
    const writer = await agentIdOf(two.page, "Writer")
    const looser = await ask(one.page, serverId, "agents.update", {
      id: writer,
      patch: { permission: "full" },
    })
    expect(looser.code).toBe("not_allowed")
    const looser2 = await ask(one.page, serverId, "agents.update", {
      id: writer,
      patch: { permission: "ask_risky" },
    })
    expect(looser2.code).toBe("not_allowed")

    // A request that names a folder is refused, and nothing is made.
    const folderCreate = await ask(one.page, serverId, "agents.create", {
      serverId,
      name: "Sneaky",
      role: "",
      instructions: "",
      workspace: "/tmp",
    })
    const folderChange = await ask(one.page, serverId, "agents.update", {
      id: writer,
      patch: { workspace: "/tmp" },
    })
    expect(folderCreate.code).toBe("invalid_input")
    expect(folderChange.code).toBe("invalid_input")
    expect(await names(two.page)).toEqual(["Writer"])

    // It cannot delete or restore, change a model account, or take the controls.
    const refusals: Record<string, string> = {}
    for (const [method, input] of [
      ["agents.delete", { id: writer }],
      ["agents.restore", { id: writer }],
      ["channels.delete", { id: "x" }],
      ["providers.connect", { kind: "custom", name: "X", baseUrl: "http://x", apiKey: "k" }],
      ["providers.remove", { accountId: "x" }],
      ["settings.update", { patch: { workspaceRoot: "/tmp" } }],
    ] as const) {
      refusals[method] = (await ask(one.page, serverId, method, input)).code
      expect(refusals[method]).toBe("not_allowed")
    }

    // A name that is taken gives a plain error. The case does not matter.
    await one.page.getByTestId("new-agent").click()
    await one.page.getByTestId("agent-name").fill("writer")
    await one.page.getByTestId("model-model").waitFor()
    await one.page.getByTestId("agent-submit").click()
    await expect(one.page.getByTestId("agent-error")).toHaveText(
      "Another agent on this server has this name.",
    )
    await shot(one.page, "s24-04-name-taken")
    await dismiss(one.page, "new-agent-dialog")

    // Duplicate and archive from MacBook 1.
    await one.page.getByTestId("chat-header-agent").click()
    await one.page.getByTestId("agent-duplicate").click()
    await expect(placeOf(two.page, "Writer copy")).toBeVisible()
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.getByTestId("agent-changed-by")).toContainText("MacBook 1")
    await one.page.getByTestId("agent-archive").click()
    await expect(placeOf(two.page, "Writer copy")).toHaveCount(0)
    await expect(placeOf(one.page, "Writer copy")).toHaveCount(0)

    // A channel: make it, change it, and see that there is no way to delete it.
    await one.page.getByTestId("new-channel").click()
    await one.page.getByTestId("channel-name").fill("Docs")
    await one.page.getByTestId("channel-topic").fill("Write the docs")
    await one.page.getByTestId("channel-member-Writer").check()
    await one.page.getByTestId("channel-submit").click()
    await expect(one.page.getByTestId("channel-dialog")).toBeHidden()
    await expect(one.page.getByTestId("channel-header-name")).toHaveText("Docs")
    await expect(two.page.locator("[data-testid^=place-channel-]")).toContainText("Docs")
    await one.page.getByTestId("channel-settings").click()
    await expect(one.page.getByTestId("channel-delete")).toHaveCount(0)
    await one.page.getByTestId("channel-topic").fill("Write all the docs")
    await one.page.getByTestId("channel-submit").click()
    await expect(one.page.getByTestId("channel-dialog")).toBeHidden()
    await expect(one.page.getByTestId("channel-header-topic")).toHaveText("Write all the docs")
    await two.page.locator("[data-testid^=place-channel-]").first().click()
    await expect(two.page.getByTestId("channel-header-topic")).toHaveText("Write all the docs")
    await shot(one.page, "s24-05-client-channel")

    // Memory: add an item from MacBook 1. MacBook 2 lists it.
    await placeOf(one.page, "Writer").click()
    await one.page.getByTestId("chat-header-agent").click()
    await one.page.getByTestId("memory-input").fill("Likes tea")
    await one.page.getByTestId("memory-add").click()
    await expect(one.page.getByTestId("memory-item")).toContainText("Likes tea")
    await dismiss(one.page, "agent-profile")
    await placeOf(two.page, "Writer").click()
    await two.page.getByTestId("chat-header-agent").click()
    await expect(two.page.getByTestId("memory-item")).toContainText("Likes tea")
    await dismiss(two.page, "agent-profile")

    // The user of MacBook 2 changes the agent: the record "Last changed by" goes.
    await two.page.getByTestId("chat-header-agent").click()
    await two.page.getByTestId("agent-role").fill("Editor")
    await two.page.getByTestId("agent-submit").click()
    await two.page.getByTestId("chat-header-agent").click()
    await expect(two.page.getByTestId("agent-changed-by")).toHaveCount(0)
    await dismiss(two.page, "agent-profile")

    report("s24-create", { refusals, looser: looser.code, folder: folderCreate.code })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})

test("linked agents: the switch is read at each request and works at once", async () => {
  test.setTimeout(240_000)
  const s = await start(await freePortPair())
  const { one, two, mock } = s
  try {
    await createAgent(two.page, "Ada")
    // The user turns the switch off in the Allow dialog: the client is read-only.
    await pairOneWay(one, two, false)
    await tile(one.page, "MacBook 2").click()
    const serverId = await linkedServerId(one.page)
    await expect(one.page.getByTestId("new-agent")).toHaveCount(0)
    await expect(one.page.getByTestId("new-channel")).toHaveCount(0)
    await placeOf(one.page, "Ada").click()
    await expect(one.page.getByTestId("chat-header-model")).toHaveAttribute("data-readonly", "true")
    const adaId = await agentIdOf(two.page, "Ada")
    const early = await ask(one.page, serverId, "agents.update", {
      id: adaId,
      patch: { role: "Early" },
    })
    expect(early.code).toBe("change_off")
    expect(early.message).toBe("MacBook 2")

    // The row of the device on MacBook 2 has the switch, off. The user turns it on: the plus
    // buttons show on MacBook 1 at once, with no restart. (Settings is still open on MacBook 2.)
    await expect(two.page.getByTestId("devices-section")).toBeVisible()
    await expect(clientRow(two.page, "MacBook 1").getByTestId("client-can-change")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await shot(two.page, "s24-06-switch-off-in-devices")
    await clientRow(two.page, "MacBook 1").getByTestId("client-can-change").click()
    await expect(one.page.getByTestId("new-agent")).toBeVisible()
    await expect(one.page.getByTestId("new-channel")).toBeVisible()
    await expect(one.page.getByTestId("chat-header-model")).not.toHaveAttribute(
      "data-readonly",
      "true",
    )

    // A dialog is open on MacBook 1 with a name in it. The user turns the switch off on MacBook 2
    // while MacBook 1 is connected. The next change fails with a line that names MacBook 2.
    await one.page.getByTestId("new-agent").click()
    await one.page.getByTestId("agent-name").fill("Late")
    await one.page.getByTestId("model-model").waitFor()
    await clientRow(two.page, "MacBook 1").getByTestId("client-can-change").click()
    await expect(clientRow(two.page, "MacBook 1").getByTestId("client-can-change")).toHaveAttribute(
      "aria-checked",
      "false",
    )
    await one.page.getByTestId("agent-submit").click()
    await expect(one.page.getByTestId("agent-error")).toHaveText(
      "Not allowed. MacBook 2 does not let this device change agents. Turn it on in Settings → Devices on that computer.",
    )
    await shot(one.page, "s24-07-switch-off-error")
    expect(await names(two.page)).toEqual(["Ada"])
    await dismiss(one.page, "new-agent-dialog")

    // The plus buttons and the fields turn read-only. The state is still "online".
    await expect(one.page.getByTestId("new-agent")).toHaveCount(0)
    await expect(one.page.getByTestId("new-channel")).toHaveCount(0)
    await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
    await placeOf(one.page, "Ada").click()
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.getByTestId("agent-profile-view")).toBeVisible()
    await expect(one.page.getByTestId("agent-submit")).toHaveCount(0)
    await expect(one.page.getByTestId("agent-readonly-hint")).toContainText(
      "MacBook 2 does not let this device",
    )
    await shot(one.page, "s24-08-read-only")
    await dismiss(one.page, "agent-profile")

    // An editor that is open when the server turns the switch off turns read-only, too.
    await clientRow(two.page, "MacBook 1").getByTestId("client-can-change").click()
    await expect(one.page.getByTestId("new-agent")).toBeVisible()
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.getByTestId("agent-form")).toBeVisible()
    await clientRow(two.page, "MacBook 1").getByTestId("client-can-change").click()
    await expect(one.page.getByTestId("agent-profile-view")).toBeVisible()
    await expect(one.page.getByTestId("agent-form")).toHaveCount(0)
    report("s24-switch", { early: early.code, message: early.message })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})

test("linked agents: while the computers sync the switch shows on and is locked; Stop syncing gives it back", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const [port1, port2] = await freePortPair()
  const one = await launch(freshUserData(), envFor(port1))
  const two = await launch(freshUserData(), envFor(port2))
  await resizeWindow(one.app, 1200, 860)
  await resizeWindow(two.app, 1200, 860)
  try {
    await connectMock(one.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(one.page, "Ada")
    // MacBook 1 allowed MacBook 2 without the switch.
    await turnOnSync(one, two, "live", false)
    const row = clientRow(one.page, "MacBook 2")
    await expect(row.getByTestId("client-can-change")).toHaveAttribute("aria-checked", "true")
    await expect(row.getByTestId("client-can-change")).toBeDisabled()
    await expect(row.getByTestId("client-can-change-locked")).toHaveText(
      "On while the two computers sync.",
    )
    await shot(one.page, "s24-09-sync-locks-switch")
    // The other direction shows the same: sync gives both computers more than the switch.
    await expect(clientRow(two.page, "MacBook 1").getByTestId("client-can-change")).toBeDisabled()

    // Stop syncing: the switch has the value that it had before (off), and can be changed.
    await serverRow(two.page, "MacBook 1").getByTestId("sync-stop").click()
    await expect(row.getByTestId("client-can-change")).toHaveAttribute("aria-checked", "false")
    await expect(row.getByTestId("client-can-change")).toBeEnabled()
    await expect(row.getByTestId("client-can-change-locked")).toHaveCount(0)
    await shot(one.page, "s24-10-sync-stopped")
    report("s24-sync-lock", { restored: true })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})

/** Latin words in a part of the screen. Names of devices, agents and models are cut out first. */
const latinWords = async (page: Page, selector: string) => {
  const text = await page.locator(selector).evaluate((el) => {
    const clone = el.cloneNode(true) as HTMLElement
    for (const skip of clone.querySelectorAll("[data-user-data], pre, textarea, input, select"))
      skip.remove()
    return clone.textContent ?? ""
  })
  const words = text
    .replace(/MacBook|Ada|Writer|mock-fast|Mock|ROBot|Tailscale|VPN|sudo/g, "")
    .replace(/\{\{\w+\}\}/g, "")
  return words.match(/[A-Za-z]{2,}/g) ?? []
}

test("linked agents: in Korean the new screens have no English left", async () => {
  test.setTimeout(240_000)
  const { mock, one, two } = await start(await freePortPair(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  try {
    await createAgent(two.page, "Ada")
    await pairOneWay(one, two, true)
    // Settings is still open on the server. The row of the device: the switch and its text.
    await expect(clientRow(two.page, "MacBook 1").getByTestId("client-can-change")).toBeVisible()
    expect(await latinWords(two.page, "[data-testid=devices-section]")).toEqual([])
    await closeSettings(two.page)

    // The profile with the switch on is a form.
    await tile(one.page, "MacBook 2").click()
    await expect(placeOf(one.page, "Ada")).toBeVisible()
    await placeOf(one.page, "Ada").click()
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.getByTestId("agent-form")).toBeVisible()
    expect(await latinWords(one.page, "[data-testid=agent-profile]")).toEqual([])
    await dismiss(one.page, "agent-profile")

    // A dialog to make an agent is open when the server turns the switch off: the error line.
    await one.page.getByTestId("new-agent").click()
    await one.page.getByTestId("agent-name").fill("Late")
    await openDevices(two.page)
    await clientRow(two.page, "MacBook 1").getByTestId("client-can-change").click()
    await closeSettings(two.page)
    await one.page.getByTestId("agent-submit").click()
    await expect(one.page.getByTestId("agent-error")).toContainText("MacBook 2")
    expect(await latinWords(one.page, "[data-testid=new-agent-dialog]")).toEqual([])
    await shot(one.page, "s24-11-korean-error")
    await dismiss(one.page, "new-agent-dialog")

    // The text-only profile.
    await one.page.getByTestId("chat-header-agent").click()
    await expect(one.page.getByTestId("agent-profile-view")).toBeVisible()
    expect(await latinWords(one.page, "[data-testid=agent-profile]")).toEqual([])
    await shot(one.page, "s24-12-korean-read-only")
    await one.page.getByTestId("agent-view-close").click()
    await expect(one.page.getByTestId("agent-profile")).toBeHidden()
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})
