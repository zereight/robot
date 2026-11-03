import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

const OR_KEY = "sk-or-e2e-0123456789abcdef"

interface Asked {
  readonly auth: string | undefined
  readonly path: string
  readonly body: {
    model?: string
    state?: { job?: string }
    questions?: { pick?: { criteria?: Record<string, string> } }
  }
}

/** A stand-in for the Decisions API of OpenRouter. */
const startDecisionService = async () => {
  const asked: Asked[] = []
  // What it answers: the option, its probability, or a status code for a refusal.
  const mode = { choice: "member_3", probability: 0.92, status: 200 }
  const server = createServer((req, res) => {
    let data = ""
    req.on("data", (chunk) => {
      data += chunk
    })
    req.on("end", () => {
      const body = data ? (JSON.parse(data) as Asked["body"]) : {}
      asked.push({ auth: req.headers.authorization, path: req.url ?? "", body })
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" })
        res.end(JSON.stringify(payload))
      }
      if (req.headers.authorization !== `Bearer ${OR_KEY}`)
        return send(401, { error: { code: 401, message: "No auth credentials found" } })
      if (mode.status !== 200) return send(mode.status, { error: { code: mode.status } })
      const keys = Object.keys(body.questions?.pick?.criteria ?? {})
      const rest = (1 - mode.probability) / Math.max(1, keys.length - 1)
      send(200, {
        answers: {
          pick: {
            type: "choice",
            choice: mode.choice,
            confidence: mode.probability,
            probabilities: Object.fromEntries(
              keys.map((k) => [k, k === mode.choice ? mode.probability : rest]),
            ),
          },
        },
        usage: { input_tokens: 100, output_tokens: 5, cost: 0 },
      })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    asked,
    mode,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const post = async (page: Page, text: string) => {
  await page.getByTestId("channel-input").fill(text)
  await page.getByTestId("channel-input").press("Enter")
}
const msgs = (page: Page) => page.getByTestId("channel-message")
const choose = (page: Page, value: string) =>
  page.getByTestId("setting-decision-choice").locator(`label[data-value="${value}"]`).click()

test("decision model: Jev through OpenRouter in settings, Test, and the fast pick in a channel", async () => {
  test.setTimeout(150_000)
  const mock = await startMockProvider()
  const service = await startDecisionService()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US", ROBOT_TEST_DECISION_URL: service.url }
  const { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Lia", "Bo", "Cy"]) await createAgent(page, name)

  // Off by default: the lead's model decides, and nothing is sent.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-decision").click()
  await expect(
    page.getByTestId("setting-decision-choice").locator('label[data-value="off"] input'),
  ).toBeChecked()
  await expect(page.getByTestId("setting-decision-key")).toHaveCount(0)
  await shot(page, "decision-00-off")

  // Jev through OpenRouter asks for a key and a model name, and the model starts with a default.
  await choose(page, "openrouter")
  await expect(page.getByTestId("setting-decision-model")).toHaveValue("typesafe/jev-1.14")
  await expect(page.getByTestId("setting-decision-key-row")).toContainText("No key is saved.")
  await expect(page.getByTestId("setting-decision-sends")).toContainText("OpenRouter")

  // Test without a key: not set up, and nothing is sent.
  await page.getByTestId("setting-decision-test").click()
  await expect(page.getByTestId("setting-decision-result")).toHaveAttribute(
    "data-reason",
    "not_set_up",
  )
  expect(service.asked).toHaveLength(0)

  // A wrong key: the error code of the service shows.
  await page.getByTestId("setting-decision-key").fill("sk-or-wrong-key-0000000000")
  await page.getByTestId("setting-decision-key-save").click()
  await expect(page.getByTestId("setting-decision-key-row")).toContainText("A key is saved")
  await page.getByTestId("setting-decision-test").click()
  await expect(page.getByTestId("setting-decision-result")).toContainText("error code 401")
  await shot(page, "decision-01-wrong-key")

  // The right key. The field is empty after a save, and the page never shows the key. The made-up
  // members are Ada, Ben and Cleo, in this order.
  service.mode.choice = "member_1"
  await page.getByTestId("setting-decision-key").fill(OR_KEY)
  await page.getByTestId("setting-decision-key-save").click()
  await expect(page.getByTestId("setting-decision-key")).toHaveValue("")
  await page.getByTestId("setting-decision-test").click()
  await expect(page.getByTestId("setting-decision-result")).toContainText("Chose Ada (92%)")
  const last = service.asked.at(-1)
  expect(last?.path).toBe("/api/alpha/decisions")
  expect(last?.auth).toBe(`Bearer ${OR_KEY}`)
  expect(last?.body.model).toBe("typesafe/jev-1.14")
  expect(Object.keys(last?.body.questions?.pick?.criteria ?? {})).toEqual([
    "member_1",
    "member_2",
    "member_3",
    "none",
  ])
  await shot(page, "decision-02-test-ok")

  // Close and open the settings again: the page says "saved" and shows no key.
  await page.getByTestId("settings-close").click()
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-decision").click()
  await expect(page.getByTestId("setting-decision-key-row")).toContainText("A key is saved")
  expect(await page.content()).not.toContain(OR_KEY)
  await page.getByTestId("settings-close").click()

  // A channel with a lead and three members. A job that names nobody goes to the member that the
  // model chose, not to the lead.
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Launch")
  await page.getByTestId("channel-topic").fill("Ship the first release")
  for (const name of ["Lia", "Bo", "Cy"]) await page.getByTestId(`channel-member-${name}`).check()
  await page.getByTestId("channel-lead").selectOption({ label: "Lia" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")

  service.mode.choice = "member_3"
  await post(page, "Please check the budget numbers")
  await expect(msgs(page)).toHaveCount(2, { timeout: 15_000 })
  await expect(msgs(page).last()).toContainText("Cy")
  const job = service.asked.at(-1)
  expect(job?.body.state?.job).toBe("Please check the budget numbers")
  await shot(page, "decision-03-fast-pick")

  // An unsure answer: the lead reads the job as if the pick did not exist.
  service.mode.probability = 0.4
  await post(page, "Now plan the next step")
  await expect(msgs(page)).toHaveCount(4, { timeout: 15_000 })
  await expect(msgs(page).last()).toContainText("Lia")

  // A failing service, and no lead: the user picks.
  service.mode.status = 503
  await page.getByTestId("channel-settings").click()
  await page
    .getByTestId("channel-lead")
    .selectOption({ label: "No lead: ask me who takes each job" })
  await page.getByTestId("channel-submit").click()
  await post(page, "Who takes this one")
  await expect(page.getByTestId("pick-member")).toBeVisible({ timeout: 15_000 })
  await page.getByTestId("pick-Bo").click()
  await expect(msgs(page).last()).toContainText("Bo", { timeout: 15_000 })

  // Korean works.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("setting-language").locator('label[data-value="ko"]').click()
  await page.getByTestId("settings-nav-decision").click()
  await expect(page.getByTestId("setting-decision-choice-row")).toContainText("결정 모델")
  await expect(page.getByTestId("setting-decision-sends")).toContainText("OpenRouter")
  await shot(page, "decision-04-korean")

  await app.close()
  await service.close()
  await mock.close()
})
