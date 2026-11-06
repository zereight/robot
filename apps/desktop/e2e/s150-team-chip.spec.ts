import { expect, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// Spec 003, "Team chip": the chat of a lead shows the organization and its member count. The
// list shows the members, the lead first, and opens their chats and the org chart.

interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}

test("team chip: lead only, member list, open a member, show on the chart, archived member", async () => {
  test.setTimeout(180_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  const serverId = (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find(
    (s) => s.kind === "local",
  )?.id as string
  const list = () => rpc<AgentInfo[]>(page, "agents.list", { serverId, archived: false })
  const ada = (await list())[0] as AgentInfo
  const make = async (name: string) =>
    rpc<AgentInfo>(page, "agents.create", {
      serverId,
      name,
      role: "",
      instructions: "",
      model: ada.model,
    })
  const bo = await make("Bo")
  const cy = await make("Cy")
  const place = (name: string) => page.locator(`[data-place-row][data-place-name="${name}"]`)
  await rpc(page, "organizations.create", {
    serverId,
    name: "Docs",
    memberIds: [ada.id, bo.id, cy.id],
    leadId: ada.id,
  })

  await place("Ada").click()
  const chip = page.getByTestId("team-chip")
  await expect(chip).toContainText("Docs · 3")
  await chip.click()
  const members = page.getByTestId("team-member")
  await expect(members).toHaveCount(3)
  await expect(members.first()).toContainText("Ada · Lead")

  // Archive a member while the list is closed, then open it: the row is muted.
  await page.keyboard.press("Escape")
  await rpc(page, "agents.archive", { id: cy.id, archived: true })
  await chip.click()
  await expect(page.getByTestId("team-member").filter({ hasText: "Cy" })).toBeDisabled()
  await page.keyboard.press("Escape")

  // A member opens its chat. A member that is not a lead shows no chip.
  await chip.click()
  await page.getByTestId("team-member").filter({ hasText: "Bo" }).click()
  await expect(page.getByTestId("chat-header-agent")).toContainText("Bo")
  await expect(page.getByTestId("team-chip")).toHaveCount(0)

  // "Show on the org chart" opens the page with the organization in view.
  await place("Ada").click()
  await chip.click()
  await page.getByTestId("team-chart").click()
  await expect(page.locator('[data-node][data-key^="o:"]').first()).toBeFocused()
  await app.close()
  await mock.close()
})
