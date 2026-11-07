import { expect, type Page, test } from "@playwright/test"
import { makeFakeRuntimes } from "./fake-runtimes.ts"
import { freshUserData, launch, shot } from "./harness.ts"

// Spec 006 ("Chat tools on a vendor runtime"): a turn of the chat on pi calls a tool of the app
// through the bridge, with its own tools off. The stand-in program calls what the test tells it.

test.setTimeout(90_000)

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()
}

const say = async (page: Page, text: string) => {
  await page.getByTestId("chat-input").fill(text)
  await page.getByTestId("chat-input").press("Enter")
}

test("chat on pi makes a workflow through the bridge, with one card", async () => {
  const fake = makeFakeRuntimes()
  fake.setPi({ ready: true, bridgeCall: { name: "create_workflow", args: { name: "Daily" } } })
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_PI_BIN: fake.pi,
  })
  await page.evaluate(async () => {
    await window.robot.invoke("providers.connect", { kind: "pi", name: "Pi" })
  })
  await newWorkflow(page, "Weekly")
  await say(page, "hello")
  // The bridge owns one card; the transcript does not add a second one.
  const card = page.getByTestId("tool-card")
  await expect(card).toHaveCount(1, { timeout: 30_000 })
  await expect(card).not.toHaveAttribute("data-state", "running", { timeout: 30_000 })
  await expect(card).toHaveAttribute("data-state", "done", { timeout: 30_000 })
  await expect(card).toContainText("Made workflow Daily")
  await expect(page.getByTestId("workflow-row")).toHaveCount(2)
  await expect(page.getByTestId("workflow-row").filter({ hasText: "Daily" })).toHaveCount(1)
  await expect(page.getByTestId("workflow-header")).toContainText("Weekly")
  // The program got the extension of the bridge, with its built-ins off.
  const turn = fake.piCalls().find((c) => "prompt" in c) as unknown as { args: string[] }
  expect(turn.args).toContain("--extension")
  expect(turn.args).toContain("--no-builtin-tools")
  await shot(page, "rt-01-pi-create")
  await app.close()
})
