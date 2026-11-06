import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow } from "./harness.ts"
import { rpc } from "./sync-helpers.ts"

// Slice S150: the goal dialog (spec 031): the match, the Product channel starter, and the saved
// starters.

interface Named {
  id: string
  name: string
  leadId?: string | null
}

const serverOf = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string

const openDialog = async (page: Page) => {
  await page.getByTestId("new-agent").click()
  await page.getByTestId("starter-goal").click()
  await expect(page.getByTestId("goal-dialog")).toBeVisible()
}

test("goal dialog: Product makes a channel with a lead, and a saved starter does too", async () => {
  test.setTimeout(120_000)
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1200, 900)

  await openDialog(page)
  await expect(page.getByTestId("goal-recommended")).toHaveCount(0)
  await page.getByTestId("goal-text").fill("ship the new feature next sprint")
  await expect(page.getByTestId("goal-recommended")).toContainText("Product")
  await page.getByTestId("goal-text").fill("encode a video")
  await expect(page.getByTestId("goal-recommended")).toContainText("No starter fits this goal.")

  // Product: PM leads, five members.
  await page.getByTestId("goal-all").getByTestId("goal-product").click()
  await expect(page.getByTestId("goal-lead-mark")).toHaveCount(1)
  await page.getByTestId("goal-create").click()
  await expect(page.getByTestId("goal-dialog")).toHaveCount(0)
  const serverId = await serverOf(page)
  const agents = await rpc<Named[]>(page, "agents.list", { serverId, archived: false })
  expect(agents.map((a) => a.name)).toEqual(
    expect.arrayContaining(["PM", "Planner", "Designer", "Developer", "QA", "Reviewer"]),
  )
  const channels = await rpc<Named[]>(page, "channels.list", { serverId })
  const product = channels.find((c) => c.name === "Product")
  expect(product?.leadId).toBe(agents.find((a) => a.name === "PM")?.id)

  // A saved starter: made, listed under "My starters", and used.
  await page.getByTestId("new-agent").click()
  await page.getByTestId("starter-goal").click()
  await page.getByTestId("goal-new").click()
  await page.getByTestId("goal-edit-name").fill("Mobile squad")
  await page.getByTestId("goal-edit-agent-name-0").fill("Lead A")
  await page.getByTestId("goal-edit-agent-role-0").fill("Leads.")
  await page.getByTestId("goal-edit-agent-name-1").fill("Helper A")
  await page.getByTestId("goal-edit-save").click()
  await expect(page.getByTestId("goal-mine")).toContainText("Mobile squad")
  await expect(page.getByTestId("goal-all")).not.toContainText("Mobile squad")
  await page
    .getByTestId("goal-mine")
    .getByRole("button", { name: /Mobile squad/ })
    .first()
    .click()
  await page.getByTestId("goal-create").click()
  await expect(page.getByTestId("goal-dialog")).toHaveCount(0)
  const after = await rpc<Named[]>(page, "channels.list", { serverId })
  expect(after.some((c) => c.name === "Mobile squad")).toBe(true)
  await app.close()
})
