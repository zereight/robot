import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// S62: "Ask when unsure" (spec 007, 013). The model of the agent and the decision model are
// stand-ins. The scenario runs once in English and once in Korean, at 1100 px wide.

const OR_KEY = "sk-or-e2e-0123456789abcdef"
/** A command that the risk rules call an install, and that changes nothing when it runs. */
const INSTALL = 'echo "npm install left-pad"'
const REQUEST = `install the package left-pad. TOOL run_command ${JSON.stringify({ command: INSTALL })}`

interface Asked {
  readonly auth: string | undefined
  readonly body: {
    state?: { words_of_the_user?: string; step?: { kind?: string; command?: string } }
  }
}

/** A stand-in for the Decisions API: it answers "The user asked for this" at the probability set. */
const startDecisionService = async () => {
  const asked: Asked[] = []
  const mode = { probability: 0.95 }
  const server = createServer((req, res) => {
    let data = ""
    req.on("data", (chunk) => {
      data += chunk
    })
    req.on("end", () => {
      asked.push({
        auth: req.headers.authorization,
        body: data ? (JSON.parse(data) as Asked["body"]) : {},
      })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          answers: {
            ask: {
              type: "choice",
              choice: "asked",
              confidence: mode.probability,
              probabilities: { asked: mode.probability, not_asked: 1 - mode.probability },
            },
          },
          usage: { input_tokens: 100, output_tokens: 5, cost: 0 },
        }),
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    mode,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

interface Words {
  readonly locale: string
  readonly shots: string
  readonly askUnsure: string
  readonly levelOffChecks: string
  readonly needsSetup: RegExp
  readonly lineOff: string
  readonly allowed: string
  readonly notSure: string
  readonly logSure: string
  readonly logSent: string
}

const EN: Words = {
  locale: "en-US",
  shots: "en",
  askUnsure: "Ask when unsure",
  levelOffChecks: "Turn on permission checks in Settings, Decision model.",
  needsSetup: /choose Jev through OpenRouter/,
  lineOff: 'Permission checks are off, so this agent works as "Ask for risky steps".',
  allowed: "Allowed by the check",
  notSure: "The check was not sure.",
  logSure: "The check was sure: 95%",
  logSent: "The check sent the step to you: it was not sure",
}
const KO: Words = {
  locale: "ko-KR",
  shots: "ko",
  askUnsure: "확실하지 않을 때만 확인",
  levelOffChecks: "설정의 결정 모델에서 권한 판단을 켜세요.",
  needsSetup: /OpenRouter의 Jev를 고르고/,
  lineOff: '권한 판단이 꺼져 있어서 이 에이전트는 "위험한 작업만 확인"처럼 동작해요.',
  allowed: "권한 판단으로 허용됨",
  notSure: "권한 판단이 확실하지 않았어요.",
  logSure: "권한 판단이 확신했어요: 95%",
  logSent: "권한 판단이 이 작업을 나에게 넘겼어요: 확신하지 못했어요",
}

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
const checksSwitch = (page: Page) => page.getByTestId("setting-permission-checks")

const openProfile = async (page: Page) => {
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
}
const closeProfile = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("agent-profile")).toBeHidden()
}
/** The dialog scrolls: the picture must show the picker and the line under it. */
const showPicker = async (page: Page) => {
  await page.getByTestId("agent-permission-line").scrollIntoViewIfNeeded()
  await page.getByTestId("agent-permission").scrollIntoViewIfNeeded()
}
const unsureInput = (page: Page) =>
  page.getByTestId("agent-permission").locator('label[data-value="ask_unsure"] input')

const openDecision = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-decision").click()
  await expect(page.getByTestId("setting-permission-checks-row")).toBeVisible()
}
const closeSettings = async (page: Page) => {
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings-close")).toBeHidden()
}

const scenario = (words: Words) => async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const service = await startDecisionService()
  const userData = freshUserData()
  const { app, page } = await launch(userData, {
    ROBOT_SYSTEM_LOCALE: words.locale,
    ROBOT_TEST_DECISION_URL: service.url,
  })
  try {
    await resizeWindow(app, 1100, 800)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")

    // ---- the switch is off, and the decision model is not set up: the level is off in the picker ----
    await openProfile(page)
    await expect(unsureInput(page)).toBeDisabled()
    await expect(page.getByTestId("agent-permission-unsure-off")).toHaveText(words.levelOffChecks)
    await showPicker(page)
    await shot(page, `s62-01-picker-off-${words.shots}`)
    await closeProfile(page)

    // ---- settings: the switch cannot turn on until a key and a model name are saved ----
    await openDecision(page)
    await expect(checksSwitch(page)).toBeDisabled()
    await expect(checksSwitch(page)).toHaveAttribute("aria-checked", "false")
    await expect(page.getByTestId("setting-permission-checks-needs")).toContainText(
      words.needsSetup,
    )
    await shot(page, `s62-02-switch-needs-setup-${words.shots}`)

    await page
      .getByTestId("setting-decision-choice")
      .locator('label[data-value="openrouter"]')
      .click()
    await page.getByTestId("setting-decision-key").fill(OR_KEY)
    await page.getByTestId("setting-decision-key-save").click()
    await expect(page.getByTestId("setting-decision-key")).toHaveValue("")
    await expect(checksSwitch(page)).toBeEnabled()
    await expect(page.getByTestId("setting-permission-checks-needs")).toHaveCount(0)
    await checksSwitch(page).click()
    await expect(checksSwitch(page)).toHaveAttribute("aria-checked", "true")
    await shot(page, `s62-03-switch-on-${words.shots}`)
    await closeSettings(page)

    // ---- the picker now has the level: pick it and save ----
    await openProfile(page)
    await expect(unsureInput(page)).toBeEnabled()
    await expect(page.getByTestId("agent-permission-unsure-off")).toHaveCount(0)
    await page.getByTestId("agent-permission").getByText(words.askUnsure).click()
    await expect(page.getByTestId("agent-permission-line")).not.toHaveText(words.lineOff)
    await showPicker(page)
    await shot(page, `s62-04-picker-on-${words.shots}`)
    await page.getByTestId("agent-submit").click()
    await expect(page.getByTestId("agent-profile")).toBeHidden()

    // ---- a sure check (0.95): the step runs with no card, and the tool card says so ----
    service.mode.probability = 0.95
    await send(page, REQUEST)
    await settled(page)
    await expect(page.getByTestId("tool-check-allowed")).toHaveText(words.allowed)
    await expect(page.getByTestId("ask-card")).toHaveCount(0)
    expect(service.asked).toHaveLength(1)
    expect(service.asked[0]?.auth).toBe(`Bearer ${OR_KEY}`)
    expect(service.asked[0]?.body.state?.words_of_the_user).toContain(
      "install the package left-pad",
    )
    expect(service.asked[0]?.body.state?.step?.command).toBe(INSTALL)
    await shot(page, `s62-05-allowed-by-check-${words.shots}`)

    // ---- an unsure check (0.6): the normal approval card, with the line of the check ----
    service.mode.probability = 0.6
    await send(page, REQUEST)
    await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId("ask-unsure")).toHaveText(words.notSure)
    expect(service.asked).toHaveLength(2)
    await shot(page, `s62-06-check-not-sure-${words.shots}`)
    await page.getByTestId("ask-deny").click()
    await settled(page)

    // ---- the action log: the check and its probability, and the reason it sent the step to you ----
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-permissions").click()
    await expect(page.getByTestId("rules")).toBeVisible()
    const checks = page.getByTestId("action-log-check")
    await expect(checks).toHaveCount(2)
    await expect(checks.filter({ hasText: words.logSure })).toHaveAttribute("data-allowed", "true")
    await expect(checks.filter({ hasText: words.logSent })).toHaveAttribute("data-allowed", "false")
    await checks.last().scrollIntoViewIfNeeded()
    await shot(page, `s62-07-action-log-${words.shots}`)
    await closeSettings(page)

    // ---- the switch goes off: the agent keeps its level, works as "Ask for risky steps", says so ----
    await openDecision(page)
    await checksSwitch(page).click()
    await expect(checksSwitch(page)).toHaveAttribute("aria-checked", "false")
    await closeSettings(page)
    await openProfile(page)
    await expect(page.getByTestId("agent-permission-line")).toHaveText(words.lineOff)
    await showPicker(page)
    await shot(page, `s62-08-switch-off-line-${words.shots}`)
    await closeProfile(page)

    service.mode.probability = 0.95
    await send(page, REQUEST)
    await expect(page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    // The decision model got no request: the step asked the user at once.
    expect(service.asked).toHaveLength(2)
    await shot(page, `s62-09-asks-with-switch-off-${words.shots}`)
    await page.getByTestId("ask-deny").click()
    await settled(page)
  } finally {
    await app.close()
    await service.close()
    await mock.close()
  }
}

test("ask when unsure: the switch, the picker, the cards and the log", scenario(EN))
test("ask when unsure: the same in Korean", scenario(KO))
