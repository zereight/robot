import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// The settings part "Organization" (spec 030, 013): the hand-off rule, "Any agent" by default.
// With "Along the channels" a send of one agent to another that no channel links fails with a
// reason, makes no task, and the legend of the org chart says that hand-offs follow the channels.

test("organization: the hand-off rule is set in settings and kept after a restart", async () => {
  test.setTimeout(90_000)
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  const first = await launch(userData, env)
  await resizeWindow(first.app, 1300, 860)
  await first.page.getByTestId("open-settings").click()
  await first.page.getByTestId("settings-nav-organization").click()

  const rule = (page: typeof first.page, value: string) =>
    page.getByTestId("organization-hand-off").locator(`label[data-value="${value}"] input`)

  // The default is "Any agent", and the part says what that means.
  await expect(rule(first.page, "any")).toBeChecked()
  await expect(first.page.getByTestId("organization-hand-off-now")).toContainText(
    "Every agent can send a message to every other agent.",
  )
  // This computer changes the rule, so no read-only line shows.
  await expect(first.page.getByTestId("organization-readonly")).toHaveCount(0)

  await first.page
    .getByTestId("organization-hand-off")
    .locator('label[data-value="channels"]')
    .click()
  await expect(rule(first.page, "channels")).toBeChecked()
  await expect(first.page.getByTestId("organization-hand-off-now")).toContainText(
    "An agent can send a message to the agents of its channels",
  )
  await first.app.close()

  // The rule stays after the app starts again.
  const second = await launch(userData, env)
  await resizeWindow(second.app, 1300, 860)
  await second.page.getByTestId("open-settings").click()
  await second.page.getByTestId("settings-nav-organization").click()
  await expect(rule(second.page, "channels")).toBeChecked()
  await second.app.close()
})

test("organization: the hand-off options stay on one line in a narrow window", async () => {
  test.setTimeout(90_000)
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 560, 860)
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-organization").click()
  const control = page.getByTestId("organization-hand-off")
  await expect(control).toBeVisible()
  // Each option keeps its label on one line: a wrapped label fills more than one line box.
  // A label is a flex item, so its own box is one rectangle; the range over its text follows
  // the line boxes. The hidden radio button is not text, so it is skipped.
  const lines = await control.locator("label").evaluateAll((els) =>
    els.map((el) => {
      const range = document.createRange()
      let count = 0
      for (const node of el.childNodes) {
        if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) {
          range.selectNodeContents(node)
          count += range.getClientRects().length
        }
      }
      return count
    }),
  )
  expect(lines).toEqual([1, 1])
  await shot(page, "organization-narrow-ko")
  await app.close()
})

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}

test("organization: with Along the channels a send that no channel links is refused with its reason, in English and Korean", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await createAgent(page, "Cy")
  const server = (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string
  const tasks = () => rpc<{ source: string }[]>(page, "tasks.list", { serverId: server })

  // The legend of the org chart says nothing of the rule while the rule is "Any agent".
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-legend")).toBeVisible()
  await expect(page.getByTestId("org-legend-channels")).toHaveCount(0)

  // Turn the rule on in the settings. The legend shows the line at once.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-organization").click()
  await page.getByTestId("organization-hand-off").locator('label[data-value="channels"]').click()
  await expect(
    page.getByTestId("organization-hand-off").locator('label[data-value="channels"] input'),
  ).toBeChecked()
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("org-legend-channels")).toHaveText("Hand-offs follow the channels.")

  // Ada and Cy share no channel, and no main agent exists: the send fails, and no agent can pass
  // it on. The step shows the reason, and the turn of Ada goes on to its end.
  await page.getByTestId("page-chats").click()
  await page.locator("[data-testid^=place-agent-]").filter({ hasText: "Ada" }).click()
  await send(page, 'TOOL send_message {"to":"Cy","text":"Please check the facts"}')
  const card = page.getByTestId("tool-card").last()
  await expect(card.getByTestId("tool-reason")).toHaveText(
    "Cy is not on your path, and no agent can pass it on. Tell the user.",
    { timeout: 30_000 },
  )
  await expect(card.getByTestId("tool-reason")).toHaveAttribute("data-code", "hand_off_none")
  await expect(card).toContainText("Failed")
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 30_000,
  })
  // No task started for Cy, and the chart has no hand-off line.
  expect((await tasks()).filter((t) => t.source === "agent")).toHaveLength(0)
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-legend")).toBeVisible()
  await expect(page.locator('[data-testid="org-line"][data-kind="handoff"]')).toHaveCount(0)

  // The words are Korean in the Korean interface: the legend and the reason of the step.
  await rpc(page, "settings.update", { language: "ko" })
  await expect(page.getByTestId("org-legend-channels")).toHaveText("전달은 채널을 따라가요.")
  await page.getByTestId("page-chats").click()
  await expect(page.getByTestId("tool-card").last().getByTestId("tool-reason")).toHaveText(
    "Cy는 보낼 수 있는 경로에 없고, 대신 전달해 줄 에이전트도 없어요. 사용자에게 알리세요.",
  )

  // With the rule back to "Any agent" the same send starts a task for Cy.
  await rpc(page, "organization.setHandOff", { rule: "any" })
  await send(page, 'TOOL send_message {"to":"Cy","text":"Please check the facts"}')
  await expect
    .poll(async () => (await tasks()).filter((t) => t.source === "agent").length, {
      timeout: 30_000,
    })
    .toBeGreaterThanOrEqual(1)
  await app.close()
})
