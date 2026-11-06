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
import { closeSettings, envFor, openDevices, rpc, setName } from "./sync-helpers.ts"

// Spec 002, flow 7 ("Main agent"), and spec 012. The switch "Main agent" is in the profile of an
// agent. At most one agent has it; the old one loses it in the same step. A linked computer sees the
// state and cannot change it. The screenshots start
// with "s21-main-" so that they do not meet the screenshots of the other specs that start with s21.

interface AgentInfo {
  id: string
  name: string
  isMain: boolean
}

const localServerId = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
const agentsOf = async (page: Page) =>
  rpc<AgentInfo[]>(page, "agents.list", { serverId: await localServerId(page), archived: false })
const idOf = async (page: Page, name: string) =>
  (await agentsOf(page)).find((a) => a.name === name)?.id as string
/** The names of the agents that have the switch on. */
const mains = async (page: Page) =>
  (await agentsOf(page))
    .filter((a) => a.isMain)
    .map((a) => a.name)
    .sort()

const placeOf = (page: Page, name: string) =>
  page.locator("[data-testid^=place-agent-]", { hasText: new RegExp(`^${name}`) })
const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)

const openProfile = async (page: Page, name: string) => {
  await placeOf(page, name).click()
  await expect(page.getByTestId("chat-start").locator("h2")).toHaveText(name)
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
}
const saveProfile = async (page: Page) => {
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toBeHidden()
}
test("main agent: the switch in the profile, one main agent, archive, off", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  try {
    await resizeWindow(app, 1300, 860)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    for (const name of ["Ada", "Bo", "Cy"]) await createAgent(page, name)
    const bo = await idOf(page, "Bo")

    // No main agent at the start: every profile has the switch off.
    expect(await mains(page)).toEqual([])
    await openProfile(page, "Ada")
    await expect(page.getByTestId("agent-main")).toHaveAttribute("aria-checked", "false")
    await expect(page.getByTestId("agent-main")).toBeEnabled()
    await expect(page.getByTestId("agent-main-server")).toHaveCount(0)
    await shot(page, "s21-main-01-profile-off")

    // Turn it on for Ada and save: Ada is the main agent.
    await page.getByTestId("agent-main").click()
    await expect(page.getByTestId("agent-main")).toHaveAttribute("aria-checked", "true")
    await saveProfile(page)
    expect(await mains(page)).toEqual(["Ada"])
    await shot(page, "s21-main-02-ada-is-main")

    // Turn it on for Bo while Ada has it: only Bo has it, and the profile of Ada shows it off.
    await openProfile(page, "Bo")
    await page.getByTestId("agent-main").click()
    await saveProfile(page)
    expect(await mains(page)).toEqual(["Bo"])
    await openProfile(page, "Ada")
    await expect(page.getByTestId("agent-main")).toHaveAttribute("aria-checked", "false")
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("agent-profile")).toBeHidden()

    // A save of another field leaves the switch as it was (Bo keeps it).
    await openProfile(page, "Bo")
    await expect(page.getByTestId("agent-main")).toHaveAttribute("aria-checked", "true")
    await page.getByTestId("agent-instructions").fill("Split the work.")
    await saveProfile(page)
    expect(await mains(page)).toEqual(["Bo"])

    // Archive the main agent: no agent that is not archived has it. Restore it: it is the main
    // agent again.
    await openProfile(page, "Bo")
    await page.getByTestId("agent-archive").click()
    await expect(page.getByTestId("agent-profile")).toBeHidden()
    await expect.poll(() => mains(page)).toEqual([])
    await rpc(page, "agents.restore", { id: bo })
    await expect.poll(() => mains(page)).toEqual(["Bo"])

    // Turn it off: no agent has it.
    await openProfile(page, "Bo")
    await page.getByTestId("agent-main").click()
    await expect(page.getByTestId("agent-main")).toHaveAttribute("aria-checked", "false")
    await saveProfile(page)
    expect(await mains(page)).toEqual([])

    // A copy of the main agent is not the main agent.
    await openProfile(page, "Ada")
    await page.getByTestId("agent-main").click()
    await saveProfile(page)
    await openProfile(page, "Ada")
    await page.getByTestId("agent-duplicate").click()
    await expect(page.getByTestId("agent-profile")).toBeHidden()
    expect(await mains(page)).toEqual(["Ada"])
    expect((await agentsOf(page)).map((a) => a.name)).toContain("Ada copy")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("main agent: the texts are in Korean", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  try {
    await resizeWindow(app, 1300, 860)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    await openProfile(page, "Ada")
    await expect(page.getByTestId("agent-main")).toHaveAttribute("aria-label", "메인 에이전트")
    await expect(page.getByTestId("agent-profile")).toContainText("메인 에이전트는 하나뿐이에요.")
    await shot(page, "s21-main-04-ko-profile")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

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
  await expect(two.page.getByTestId("join-can-change")).toHaveAttribute("aria-checked", "true")
  if (!canChange) await two.page.getByTestId("join-can-change").click()
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

/** A request for the linked server as the window of MacBook 1 makes it. Never throws. */
const ask = (page: Page, serverId: string, method: string, input?: unknown) =>
  page.evaluate(
    async ([m, i, s]) => {
      // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
      const r = await (window as any).robot.invoke(m, i, s)
      return r.ok ? "ok" : (r.error.code as string)
    },
    [method, input, serverId] as [string, unknown, string],
  )

/**
 * MacBook 2 holds Ada (the main agent) and Bo. MacBook 1 opens MacBook 2 over the link, with or
 * without the switch "Can create and change agents" (012).
 */
const linked = async (
  canChange: boolean,
  body: (one: Launched, two: Launched) => Promise<void>,
) => {
  const [PORT_1, PORT_2] = await freePortPair()
  const mock = await startMockProvider()
  const two = await launch(freshUserData(), envFor(PORT_2))
  const one = await launch(freshUserData(), envFor(PORT_1))
  try {
    await resizeWindow(two.app, 1300, 860)
    await resizeWindow(one.app, 1300, 860)
    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(two.page, "Ada")
    await createAgent(two.page, "Bo")
    await rpc(two.page, "agents.update", {
      id: await idOf(two.page, "Ada"),
      patch: { isMain: true },
    })
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await closeSettings(two.page)
    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await closeSettings(one.page)
    await pairOneWay(one, two, canChange)
    await closeSettings(two.page)
    await tile(one.page, "MacBook 2").click()
    await body(one, two)
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
}

test("a linked computer with the switch sees the state of the main agent and cannot change it", async () => {
  test.setTimeout(300_000)
  await linked(true, async (one, two) => {
    const server = await one.page.evaluate(async () => {
      // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
      const r = await (window as any).robot.invoke("servers.list")
      return (r.value as { id: string; kind: string }[]).find((s) => s.kind === "linked")?.id
    })
    // The profile shows the switch, on for Ada and off for Bo, and both are disabled.
    await openProfile(one.page, "Ada")
    await expect(one.page.getByTestId("agent-main")).toHaveAttribute("aria-checked", "true")
    await expect(one.page.getByTestId("agent-main")).toBeDisabled()
    await expect(one.page.getByTestId("agent-main-server")).toHaveText("Change this on MacBook 2.")
    await shot(one.page, "s21-main-05-linked-profile")
    await one.page.keyboard.press("Escape")
    await expect(one.page.getByTestId("agent-profile")).toBeHidden()
    await openProfile(one.page, "Bo")
    await expect(one.page.getByTestId("agent-main")).toHaveAttribute("aria-checked", "false")
    await expect(one.page.getByTestId("agent-main")).toBeDisabled()
    // A save from the client leaves the switch as it was.
    await one.page.getByTestId("agent-instructions").fill("Write short notes.")
    await saveProfile(one.page)
    expect(await mains(two.page)).toEqual(["Ada"])
    // A request that names the switch is refused by MacBook 2, and nothing changes.
    expect(
      await ask(one.page, server as string, "agents.update", {
        id: await idOf(two.page, "Bo"),
        patch: { isMain: true },
      }),
    ).toBe("invalid_input")
    expect(await mains(two.page)).toEqual(["Ada"])
    // The user of MacBook 2 moves the flag: the client follows.
    await rpc(two.page, "agents.update", {
      id: await idOf(two.page, "Bo"),
      patch: { isMain: true },
    })
    await openProfile(one.page, "Bo")
    await expect(one.page.getByTestId("agent-main")).toHaveAttribute("aria-checked", "true")
  })
})

test("a linked computer without the switch sees the profile as text, with the main agent shown", async () => {
  test.setTimeout(300_000)
  await linked(false, async (one) => {
    await openProfile(one.page, "Ada")
    await expect(one.page.getByTestId("agent-profile-view")).toBeVisible()
    await expect(one.page.getByTestId("agent-view-main")).toHaveText("On")
    await expect(one.page.getByTestId("agent-main")).toHaveCount(0)
    await shot(one.page, "s21-main-06-linked-view")
    await one.page.keyboard.press("Escape")
    await expect(one.page.getByTestId("agent-profile")).toBeHidden()
    await openProfile(one.page, "Bo")
    await expect(one.page.getByTestId("agent-profile-view")).toBeVisible()
    await expect(one.page.getByTestId("agent-view-main")).toHaveCount(0)
  })
})
