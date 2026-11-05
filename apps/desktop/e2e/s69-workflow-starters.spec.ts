import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

// Spec 010, "Starters": the menu choice "New from a starter", the dialog with the field "Agent",
// and the starter "TLA+ check". The window is 1100 px wide, the smallest width that the page of
// workflows is checked at.
const WIDTH = 1100
const HEIGHT = 820

const openWorkflows = async (page: Page) => {
  await page.getByTestId("page-workflows").click()
  await expect(page.getByTestId("wf-list")).toBeVisible()
}

interface Notice {
  title: string
  body: string
}
/** The notices that the steps of the starter showed. The agent's own task notices are not these. */
const readNotices = (log: string): Notice[] =>
  existsSync(log)
    ? readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Notice)
        .filter((notice) => notice.title.startsWith("TLA+ check"))
    : []

interface Recorded {
  readonly path: string
  readonly body: unknown
}
interface ChatBody {
  readonly messages: { role: string; content: unknown }[]
  readonly tools?: { function?: { name?: string } }[]
}

/** The text of the last user message of each request to the model, with the tools it offered. */
const asked = (requests: readonly Recorded[]) =>
  requests
    .filter((r) => r.path === "/v1/chat/completions")
    .map((r) => {
      const body = r.body as ChatBody
      return {
        text: String(body.messages.findLast((m) => m.role === "user")?.content ?? ""),
        tools: (body.tools ?? []).map((t) => t.function?.name ?? ""),
      }
    })

/** Opens the menu, picks "New from a starter" and waits for the dialog. */
const openDialog = async (page: Page) => {
  await page.getByTestId("wf-menu").click()
  await page.getByTestId("wf-menu-starter").click()
  await expect(page.getByTestId("wf-starter-dialog")).toBeVisible()
}

/** The canvas of the new workflow: the numbers, the names, the connections and the note. */
const expectCanvas = async (
  page: Page,
  names: readonly string[],
  noteStart: string,
  agentName: string,
) => {
  await expect(page.getByTestId("wf-editor")).toBeVisible()
  await expect(page.getByTestId("wf-node")).toHaveCount(6)
  await expect(page.getByTestId("wf-node-number")).toHaveText(["1", "2", "3", "4", "5", "6"])
  for (const [i, name] of names.entries())
    await expect(page.getByTestId("wf-node").nth(i)).toContainText(name)
  await expect(page.getByTestId("wf-edge")).toHaveCount(5)
  await expect(page.getByTestId("wf-note")).toHaveCount(1)
  await expect(page.getByTestId("wf-note-text")).toHaveCount(0)
  await expect(page.getByTestId("wf-note")).toContainText(noteStart)
  await expect(page.getByTestId("wf-trigger-kind")).toHaveValue("manual")
  // Every agent step names the agent that the user picked: nodes 1, 2 and 5.
  for (const index of [0, 1, 4]) {
    await page.getByTestId("wf-node").nth(index).click()
    await expect(page.getByTestId("wf-step-agent")).toBeVisible()
    await expect(page.getByTestId("wf-step-agent").locator("option:checked")).toHaveText(agentName)
  }
}

test("workflow starters, English: the choice is off with no agent, the dialog, the new workflow, a second one, and three runs", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const log = join(userData, "notices.jsonl")
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_NOTIFY_LOG: log,
    ROBOT_TEST_UNFOCUSED: "1",
  })
  try {
    await resizeWindow(app, WIDTH, HEIGHT)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)

    // With no agent the choice is off, and it says why.
    await openWorkflows(page)
    await page.getByTestId("wf-menu").click()
    await expect(page.getByTestId("wf-menu-starter")).toBeDisabled()
    await expect(page.getByTestId("wf-menu-starter-reason")).toHaveText("Make an agent first.")
    await expect(page.getByTestId("wf-menu-starter")).toHaveAttribute(
      "aria-describedby",
      "wf-menu-starter-reason",
    )
    await shot(page, "s69-01-en-menu-no-agent")
    await page.keyboard.press("Escape")
    await expect(page.getByTestId("wf-menu-starter")).toHaveCount(0)

    // Two agents. The default of the field is the first agent of the list.
    await createAgent(page, "Ada")
    await createAgent(page, "Reviewer")
    await openWorkflows(page)
    await page.getByTestId("wf-menu").click()
    await expect(page.getByTestId("wf-menu-starter")).toBeEnabled()
    await expect(page.getByTestId("wf-menu-starter-reason")).toHaveCount(0)
    await shot(page, "s69-02-en-menu")
    await page.getByTestId("wf-menu-starter").click()

    const dialog = page.getByTestId("wf-starter-dialog")
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId("wf-starter-tla")).toContainText("TLA+ check")
    await expect(dialog.getByTestId("wf-starter-tla")).toContainText(
      "An agent writes a TLA+ model of a spec, runs TLC on it, and explains what TLC finds.",
    )
    await expect(dialog.getByTestId("wf-starter-tla-needs")).toContainText(
      "Needs Java 17 or later and the file tla2tools.jar",
    )
    await expect(dialog.getByTestId("wf-starter-agent")).toHaveValue(/.+/)
    await expect(dialog.getByTestId("wf-starter-agent").locator("option:checked")).toHaveText("Ada")
    await expect(dialog.getByTestId("wf-starter-agent").locator("option")).toHaveText([
      "Ada",
      "Reviewer",
    ])
    await shot(page, "s69-03-en-dialog")

    // Escape closes the dialog and makes nothing.
    await page.keyboard.press("Escape")
    await expect(dialog).toHaveCount(0)
    await expect(page.getByTestId("wf-card")).toHaveCount(0)

    // Pick "Reviewer" and press Create: the canvas of the new workflow opens.
    await openDialog(page)
    await dialog.getByTestId("wf-starter-agent").selectOption({ label: "Reviewer" })
    await dialog.getByTestId("wf-starter-create").click()
    await expect(page.getByTestId("wf-name")).toHaveValue("TLA+ check")
    await expectCanvas(
      page,
      [
        "Write model",
        "Run TLC",
        "TLC passed?",
        "No error found",
        "Explain the finding",
        "Possible gap",
      ],
      "This workflow needs Java 17 or later",
      "Reviewer",
    )
    await page.getByTestId("wf-node").nth(2).click()
    await expect(page.getByTestId("wf-step-contains")).toHaveValue("TLC_RESULT: PASS")
    await expect(page.getByTestId("wf-step-mode")).toHaveValue("contains")
    await page.getByTestId("wf-node").nth(1).click()
    await expect(page.getByTestId("wf-step-prompt")).toHaveValue(/TLC_RESULT: PASS/)
    await expect(page.getByTestId("wf-step-prompt")).toHaveValue(/Blocked:/)
    await page.getByTestId("wf-node").nth(3).click()
    await expect(page.getByTestId("wf-step-title")).toHaveValue("TLA+ check: no error found")
    await page.getByTestId("wf-node").nth(5).click()
    await expect(page.getByTestId("wf-step-title")).toHaveValue("TLA+ check: possible gap")
    await page.getByTestId("wf-node").nth(1).click()
    await shot(page, "s69-04-en-canvas")

    // The workflow is an ordinary one: the list shows it, and a second one gets a number.
    await page.getByTestId("wf-back").click()
    await expect(page.getByTestId("wf-card")).toHaveCount(1)
    await expect(page.getByTestId("wf-card")).toContainText("TLA+ check")
    await expect(page.getByTestId("wf-card")).toContainText("6 steps")
    await shot(page, "s69-05-en-list")
    await openDialog(page)
    await dialog.getByTestId("wf-starter-agent").selectOption({ label: "Reviewer" })
    await dialog.getByTestId("wf-starter-create").click()
    await expect(page.getByTestId("wf-name")).toHaveValue("TLA+ check 2")
    await page.getByTestId("wf-back").click()
    await openDialog(page)
    await dialog.getByTestId("wf-starter-create").click()
    await expect(page.getByTestId("wf-name")).toHaveValue("TLA+ check 3")
    await page.getByTestId("wf-back").click()
    await expect(page.getByTestId("wf-card")).toHaveCount(3)

    // Run 1 (nothing changed): the stand-in agent answers each agent step with a line of its own,
    // so the reply of node 2 has no PASS line. Node 4 does not run; nodes 5 and 6 do.
    await page
      .locator('[data-testid=wf-card]:has-text("TLA+ check") >> nth=0')
      .getByTestId("wf-open")
      .click()
    await page.getByTestId("wf-run").click()
    await expect(page.getByTestId("wf-run-row")).toHaveCount(1, { timeout: 30_000 })
    await expect(page.getByTestId("wf-run-row")).toContainText("Done", { timeout: 30_000 })
    const states = () =>
      page
        .getByTestId("wf-node")
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-state")))
    await expect.poll(states).toEqual(["done", "done", "done", "skipped", "done", "done"])
    expect(readNotices(log).map((n) => n.title)).toEqual(["TLA+ check: possible gap"])
    // The run view holds the whole explanation: the notify step shows its whole input.
    await page.getByTestId("wf-run-step").nth(5).locator("summary").click()
    await expect(page.getByTestId("wf-run-step").nth(5)).toContainText("Hello! You said:")
    await shot(page, "s69-06-en-run-fail-path")

    // The prompts reached the model: node 1 offers "ask_user" and tells the agent about "Blocked:",
    // node 2 got the reply of node 1, and node 5 got the reply of node 2.
    const requests = asked(mock.requests)
    const first = requests.find((r) => r.text.startsWith("You write a TLA+ model of a spec."))
    expect(first?.tools).toContain("ask_user")
    expect(first?.text).toContain('Use the tool "ask_user"')
    expect(first?.text).toContain('"Blocked:"')
    const second = requests.find((r) => r.text.startsWith("You run the TLC model checker"))
    expect(second?.tools).toContain("run_command")
    expect(second?.text).toContain("Hello! You said:")
    expect(second?.text).toContain("last 30 lines")
    const third = requests.find((r) => r.text.startsWith("TLC reported an error on a TLA+ model"))
    expect(third?.text).toContain("Hello! You said:")
    expect(third?.text).toContain("at most 12 lines")

    // Run 2: the reply of node 2 holds the PASS line. Node 4 shows its notice; 5 and 6 do not run.
    await page.getByTestId("wf-back").click()
    await page
      .locator('[data-testid=wf-card]:has-text("TLA+ check 2") >> nth=0')
      .getByTestId("wf-open")
      .click()
    await page.getByTestId("wf-node").nth(1).click()
    // The stand-in model answers with the last line of the prompt. A prompt without the input in it
    // gets the input after it, so the input goes first.
    await page.getByTestId("wf-step-prompt").fill("{{input}}\nTLC_RESULT: PASS")
    await page.getByTestId("wf-run").click()
    await expect(page.getByTestId("wf-run-row")).toContainText("Done", { timeout: 30_000 })
    await expect.poll(states).toEqual(["done", "done", "done", "done", "skipped", "skipped"])
    expect(readNotices(log).map((n) => n.title)).toEqual([
      "TLA+ check: possible gap",
      "TLA+ check: no error found",
    ])
    await shot(page, "s69-07-en-run-pass-path")

    // Run 3: node 2 ends with "Blocked:". The run fails at node 2 with the reason; 3 to 6 do not run.
    await page.getByTestId("wf-back").click()
    await page
      .locator('[data-testid=wf-card]:has-text("TLA+ check 3") >> nth=0')
      .getByTestId("wf-open")
      .click()
    await page.getByTestId("wf-node").nth(1).click()
    await page.getByTestId("wf-step-prompt").fill("{{input}}\nBLOCKEDPART Java is missing")
    await page.getByTestId("wf-run").click()
    await expect(page.getByTestId("wf-run-row")).toContainText("Failed", { timeout: 30_000 })
    const after = await states()
    expect(after.slice(0, 2)).toEqual(["done", "failed"])
    expect(after.slice(2)).not.toContain("done")
    await page.getByTestId("wf-run-step").nth(1).locator("summary").click()
    await expect(page.getByTestId("wf-run-step").nth(1)).toContainText(
      "no access to the repository",
    )
    // Only the two notices of the earlier runs exist: the blocked run sent none.
    expect(readNotices(log)).toHaveLength(2)
    await shot(page, "s69-08-en-run-blocked")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("workflow starters, Korean: the texts, the name, the steps and the note are Korean; the two lines stay English", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  try {
    await resizeWindow(app, WIDTH, HEIGHT)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await openWorkflows(page)

    await page.getByTestId("wf-menu").click()
    await expect(page.getByTestId("wf-menu-starter")).toBeDisabled()
    await expect(page.getByTestId("wf-menu-starter")).toHaveText("스타터로 새로 만들기")
    await expect(page.getByTestId("wf-menu-starter-reason")).toHaveText("먼저 에이전트를 만드세요.")
    await shot(page, "s69-10-ko-menu-no-agent")
    await page.keyboard.press("Escape")

    await createAgent(page, "Reviewer")
    await openWorkflows(page)
    await openDialog(page)
    const dialog = page.getByTestId("wf-starter-dialog")
    await expect(dialog).toContainText("TLA+ 검사")
    await expect(dialog).toContainText("에이전트가 스펙의 TLA+ 모델을 쓰고")
    await expect(dialog).toContainText("필요한 것: Java 17 이상")
    await expect(dialog.getByTestId("wf-starter-create")).toHaveText("만들기")
    await shot(page, "s69-11-ko-dialog")
    await dialog.getByTestId("wf-starter-create").click()

    await expect(page.getByTestId("wf-name")).toHaveValue("TLA+ 검사")
    await expectCanvas(
      page,
      ["모델 작성", "TLC 실행", "TLC 통과?", "오류 없음", "결과 설명", "빈틈 가능성"],
      "이 워크플로우를 쓰려면 Java 17 이상",
      "Reviewer",
    )
    // The two lines that the app reads stay English in the Korean prompts and in the condition.
    await page.getByTestId("wf-node").nth(2).click()
    await expect(page.getByTestId("wf-step-contains")).toHaveValue("TLC_RESULT: PASS")
    await page.getByTestId("wf-node").nth(1).click()
    await expect(page.getByTestId("wf-step-prompt")).toHaveValue(/TLC_RESULT: PASS/)
    await expect(page.getByTestId("wf-step-prompt")).toHaveValue(/TLC_RESULT: FAIL/)
    await expect(page.getByTestId("wf-step-prompt")).toHaveValue(/"Blocked:"/)
    await page.getByTestId("wf-node").nth(3).click()
    await expect(page.getByTestId("wf-step-title")).toHaveValue("TLA+ 검사: 오류를 찾지 못했어요")
    await page.getByTestId("wf-node").nth(5).click()
    await expect(page.getByTestId("wf-step-title")).toHaveValue("TLA+ 검사: 빈틈일 수 있어요")
    await page.getByTestId("wf-node").nth(1).click()
    // No particle pair is left open anywhere on the screen.
    const screen =
      ((await page.locator("body").textContent()) ?? "") +
      (await page.getByTestId("wf-step-prompt").inputValue())
    expect(screen).not.toMatch(/\(으\)로|을\(를\)|이\(가\)|은\(는\)/)
    await shot(page, "s69-12-ko-canvas")

    await page.getByTestId("wf-back").click()
    await expect(page.getByTestId("wf-card")).toContainText("TLA+ 검사")
    await shot(page, "s69-13-ko-list")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("workflow starters: the file of the new workflow imports into an empty app with nothing left out", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-s69-"))
  const workflowFile = join(work, "workflows.json")
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }

  let { app, page } = await launch(freshUserData(), {
    ...env,
    ROBOT_TEST_WORKFLOW_FILE_SAVE: workflowFile,
  })
  try {
    await resizeWindow(app, WIDTH, HEIGHT)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Reviewer")
    await openWorkflows(page)
    await openDialog(page)
    await page.getByTestId("wf-starter-create").click()
    await expect(page.getByTestId("wf-name")).toHaveValue("TLA+ check")
    await page.getByTestId("wf-back").click()
    await page.getByTestId("wf-menu").click()
    await page.getByTestId("wf-menu-export").click()
    await page.getByTestId("workflow-export-submit").click()
    await expect(page.getByTestId("workflow-export-saved")).toBeVisible()
    await app.close()

    const file = JSON.parse(readFileSync(workflowFile, "utf8")) as {
      workflows: { name: string; steps: { kind: string; agent?: string }[]; notes: unknown[] }[]
    }
    expect(file.workflows).toHaveLength(1)
    expect(file.workflows[0]?.steps.map((s) => s.kind)).toEqual([
      "agent",
      "agent",
      "condition",
      "notify",
      "agent",
      "notify",
    ])
    expect(file.workflows[0]?.notes).toHaveLength(1)

    // An empty app with an agent of the same name: the review screen lists nothing under "Not imported".
    ;({ app, page } = await launch(freshUserData(), {
      ...env,
      ROBOT_TEST_WORKFLOW_FILE_OPEN: workflowFile,
    }))
    await resizeWindow(app, WIDTH, HEIGHT)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Reviewer")
    await openWorkflows(page)
    await page.getByTestId("wf-menu").click()
    await page.getByTestId("wf-menu-import-file").click()
    const review = page.getByTestId("workflow-import-dialog")
    await expect(review.getByTestId("workflow-import-item")).toHaveCount(1)
    await expect(review).toContainText("TLA+ check")
    await expect(review).toContainText("6 steps, 1 notes")
    await expect(review.getByTestId("workflow-import-missing")).toHaveCount(0)
    await expect(review.getByTestId("not-imported-item")).toHaveCount(0)
    await expect(review.getByTestId("workflow-import-not-imported")).toContainText(
      "The file holds nothing that ROBot cannot make.",
    )
    await shot(page, "s69-14-en-import-review")
    await review.getByTestId("workflow-import-submit").click()
    await expect(review).toHaveCount(0)
    await expect(page.getByTestId("wf-card")).toHaveCount(1)
    await page.getByTestId("wf-open").click()
    await expectCanvas(
      page,
      [
        "Write model",
        "Run TLC",
        "TLC passed?",
        "No error found",
        "Explain the finding",
        "Possible gap",
      ],
      "This workflow needs Java 17 or later",
      "Reviewer",
    )
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

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
  await one.page.getByTestId("connect-two-way").click()
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
  readonly name: string
  readonly steps: readonly { kind: string; agentId?: string }[]
  readonly notes: readonly unknown[]
}
interface AgentRow {
  readonly id: string
  readonly name: string
}

test("workflow starters on a linked computer: off with the reason without the switch, on with it, and the workflow is made on the server", async () => {
  test.setTimeout(240_000)
  const ports = await freePortPair()
  const mock = await startMockProvider()
  const two = await launch(freshUserData(), envFor(ports[1]))
  const one = await launch(freshUserData(), envFor(ports[0]))
  try {
    await resizeWindow(two.app, 1400, 900)
    await resizeWindow(one.app, WIDTH, HEIGHT)
    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    await createAgent(two.page, "Reviewer")
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await closeSettings(two.page)
    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await closeSettings(one.page)

    const serverId = await localServerId(two.page)
    await pairOneWay(one, two, false)
    await closeSettings(two.page)
    await tile(one.page, "MacBook 2").click()
    await one.page.getByTestId("page-workflows").click()
    await expect(one.page.getByTestId("wf-list")).toBeVisible()

    // Without the switch: the choice is off and says why. The file choices stay on the server.
    await one.page.getByTestId("wf-menu").click()
    await expect(one.page.getByTestId("wf-menu-starter")).toBeDisabled()
    await expect(one.page.getByTestId("wf-menu-starter-reason")).toHaveText(
      "MacBook 2 must turn on “Can create and change agents” for this device.",
    )
    await expect(one.page.getByTestId("wf-menu-open-on-server")).toBeDisabled()
    await shot(one.page, "s69-20-client-menu-off")
    await one.page.keyboard.press("Escape")

    // MacBook 2 turns the switch on: the choice is on. The field lists the agents of the server.
    await openDevices(two.page)
    await clientRow(two.page, "MacBook 1").getByTestId("client-can-change").click()
    await expect(clientRow(two.page, "MacBook 1").getByTestId("client-can-change")).toHaveAttribute(
      "aria-checked",
      "true",
    )
    await closeSettings(two.page)
    await expect(async () => {
      await one.page.getByTestId("wf-menu").click()
      await expect(one.page.getByTestId("wf-menu-starter")).toBeEnabled({ timeout: 1500 })
    }).toPass({ timeout: 20_000 })
    await one.page.getByTestId("wf-menu-starter").click()
    const dialog = one.page.getByTestId("wf-starter-dialog")
    await expect(dialog.getByTestId("wf-starter-agent").locator("option")).toHaveText(["Reviewer"])
    await shot(one.page, "s69-21-client-dialog")
    await dialog.getByTestId("wf-starter-create").click()
    await expect(one.page.getByTestId("wf-name")).toHaveValue("TLA+ check")
    await expect(one.page.getByTestId("wf-node")).toHaveCount(6)

    // The workflow is on the server, with the agent of the server.
    const agents = await rpc<AgentRow[]>(two.page, "agents.list", { serverId, archived: false })
    const reviewer = agents.find((a) => a.name === "Reviewer")
    const made = await rpc<Flow[]>(two.page, "workflows.list", { serverId })
    expect(made.map((w) => w.name)).toEqual(["TLA+ check"])
    expect(made[0]?.steps).toHaveLength(6)
    expect(made[0]?.notes).toHaveLength(1)
    expect(made[0]?.steps.filter((s) => s.kind === "agent").map((s) => s.agentId)).toEqual([
      reviewer?.id,
      reviewer?.id,
      reviewer?.id,
    ])
    await shot(one.page, "s69-22-client-canvas")
  } finally {
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await mock.close()
  }
})
