import { expect, type Page, test } from "@playwright/test"
import { connectMock, freshUserData, type Launched, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { freePortPair } from "./ports.ts"
import { closeSettings, envFor, openDevices, rpc, setName } from "./sync-helpers.ts"

// Spec 012, "Workflows". MacBook 1 (the client) opens the Workflows page of MacBook 2 (the
// server). Two copies of the app run side by side, each with its own data folder.

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const clientRow = (page: Page, name: string) =>
  page.locator(`[data-testid=client-row][data-name="${name}"]`)

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
  if (!canChange) await two.page.getByTestId("join-can-change").click()
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

const localServerId = (page: Page) =>
  page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
    const result = await (window as any).robot.invoke("servers.list")
    return (result.value as { id: string; kind: string }[]).find((s) => s.kind === "local")?.id
  }) as Promise<string>

interface Flow {
  readonly id: string
  readonly steps: readonly unknown[]
}
interface Run {
  readonly startedBy: string | null
}

test("linked workflows: a client sees, runs and answers, and edits only with the switch", async () => {
  test.setTimeout(240_000)
  const ports = await freePortPair()
  const mock = await startMockProvider()
  const two = await launch(freshUserData(), envFor(ports[1]))
  const one = await launch(freshUserData(), envFor(ports[0]))
  try {
    await resizeWindow(two.app, 1400, 900)
    await resizeWindow(one.app, 1400, 900)
    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await closeSettings(two.page)
    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await closeSettings(one.page)

    // A workflow on MacBook 2: an approval step, then a notification.
    const serverId = await localServerId(two.page)
    const flow = await rpc<Flow>(two.page, "workflows.create", {
      serverId,
      name: "Gate",
      trigger: { kind: "manual" },
      steps: [
        { id: "s1", kind: "approval", name: "Check", x: 40, y: 40, message: "Go?" },
        { id: "s2", kind: "notify", name: "Tell", x: 300, y: 40, title: "Done" },
      ],
      edges: [{ id: "e1", from: "s1", to: "s2" }],
    })

    await pairOneWay(one, two, false)
    await closeSettings(two.page)
    await tile(one.page, "MacBook 2").click()

    // The page opens. Routines stay on the server.
    await one.page.getByTestId("page-workflows").click()
    await expect(one.page.getByTestId("workflows-page")).toBeVisible()
    await expect(one.page.getByTestId("page-open-on-server")).toHaveText("Open this on MacBook 2.")
    await one.page.getByTestId("wf-tabs").getByText("Workflows", { exact: true }).click()

    // Without the switch: the list shows, with no edit controls.
    await expect(one.page.getByTestId("wf-card")).toHaveCount(1)
    await expect(one.page.getByTestId("wf-card")).toContainText("Gate")
    await expect(one.page.getByTestId("wf-new")).toHaveCount(0)
    await expect(one.page.getByTestId("wf-delete-card")).toHaveCount(0)
    await expect(one.page.getByTestId("wf-enabled")).toBeDisabled()
    // The workflow file stays on the server.
    await one.page.getByTestId("wf-menu").click()
    await expect(one.page.getByTestId("wf-menu-open-on-server")).toHaveText(
      "Open this on MacBook 2.",
    )
    await one.page.keyboard.press("Escape")
    await shot(one.page, "s56-01-client-list")

    // The canvas is read only, and Run works.
    await one.page.getByTestId("wf-open").click()
    await expect(one.page.getByTestId("wf-node")).toHaveCount(2)
    await expect(one.page.getByTestId("wf-add-agent")).toHaveCount(0)
    await expect(one.page.getByTestId("wf-save")).toHaveCount(0)
    await expect(one.page.getByTestId("wf-name")).toBeDisabled()
    await one.page.getByTestId("wf-run").click()
    await expect(one.page.locator("[data-testid=wf-node][data-state=waiting]")).toHaveCount(1, {
      timeout: 15_000,
    })
    await expect(one.page.getByTestId("wf-run-started-by")).toHaveText("Started by MacBook 1")
    const runs = await rpc<Run[]>(two.page, "workflows.runs", { workflowId: flow.id })
    expect(runs[0]?.startedBy).toBe("MacBook 1")

    // The client answers the approval step.
    await one.page.getByTestId("wf-node").first().click()
    await shot(one.page, "s56-02-client-approval")
    await one.page.getByTestId("wf-approve").click()
    await expect(one.page.locator("[data-testid=wf-node][data-state=done]")).toHaveCount(2, {
      timeout: 15_000,
    })
    await one.page.getByTestId("wf-run-step").first().locator("summary").click()
    await expect(one.page.getByTestId("wf-step-decided-by")).toHaveText("Allowed by MacBook 1")

    // MacBook 2 turns the switch on: the client gets the edit controls and adds a step.
    await openDevices(two.page)
    await clientRow(two.page, "MacBook 1").getByTestId("client-can-change").click()
    await expect(clientRow(two.page, "MacBook 1").getByTestId("client-can-change")).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await closeSettings(two.page)
    await expect(one.page.getByTestId("wf-add-notify")).toBeVisible({ timeout: 15_000 })
    await one.page.getByTestId("wf-add-notify").click()
    await one.page.getByTestId("wf-save").click()
    await expect
      .poll(async () => (await rpc<Flow[]>(two.page, "workflows.list", { serverId }))[0]?.steps)
      .toHaveLength(3)
    await one.page.getByTestId("wf-back").click()
    await expect(one.page.getByTestId("wf-new")).toBeVisible()
    await shot(one.page, "s56-03-client-can-change")

    // MacBook 2 quits: the page says that it is offline.
    await two.app.close()
    await expect(one.page.getByTestId("wf-offline")).toHaveText("MacBook 2 is offline.", {
      timeout: 30_000,
    })
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})
