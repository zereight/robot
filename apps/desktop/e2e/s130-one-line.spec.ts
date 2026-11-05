import { expect, type Locator, type Page, test } from "@playwright/test"
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

// Spec 030, "One line" (the part without the repair), flow 4 and "Organization tree" (delete), and
// 029, "Edit on the chart" (the lists, the drag, "Refusals"): an agent is a member of more than one
// organization only when all of them are on one line. The form, the menus, the drag and a linked
// computer (012) use the same rule. A deleted organization gives its sub-organizations to its parent.

interface OrgInfo {
  id: string
  name: string
  parentId: string | null
  memberIds: string[]
  leadId: string | null
}

const serverIdOf = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
const orgsOf = async (page: Page) =>
  rpc<OrgInfo[]>(page, "organizations.list", { serverId: await serverIdOf(page) })
const orgByName = async (page: Page, name: string) =>
  (await orgsOf(page)).find((o) => o.name === name) as OrgInfo
const agentIdOf = async (page: Page, name: string) =>
  (
    await rpc<{ id: string; name: string }[]>(page, "agents.list", {
      serverId: await serverIdOf(page),
      archived: false,
    })
  ).find((a) => a.name === name)?.id as string
const makeOrg = async (page: Page, name: string, members: string[], parent?: string) =>
  rpc<OrgInfo>(page, "organizations.create", {
    serverId: await serverIdOf(page),
    name,
    memberIds: await Promise.all(members.map((m) => agentIdOf(page, m))),
    leadId: null,
    ...(parent ? { parentId: (await orgByName(page, parent)).id } : {}),
  })
/** The members of each organization by name: "Docs: Ada, Cy". */
const teams = async (page: Page) => {
  const names = new Map(
    (
      await rpc<{ id: string; name: string }[]>(page, "agents.list", {
        serverId: await serverIdOf(page),
        archived: false,
      })
    ).map((a) => [a.id, a.name]),
  )
  return (await orgsOf(page))
    .map(
      (o) =>
        `${o.name}: ${o.memberIds
          .map((m) => names.get(m))
          .sort()
          .join(", ")}`,
    )
    .sort()
}
const parentsOf = async (page: Page) => {
  const orgs = await orgsOf(page)
  const name = (id: string | null) => orgs.find((o) => o.id === id)?.name ?? "-"
  return orgs.map((o) => `${o.name}>${name(o.parentId)}`).sort()
}

const startOne = async (locale = "en-US") => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: locale })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  return { mock, app, page }
}

/**
 * Product, with Docs and Press under it, and Ops at the top. Ada and Cy are in Docs and Product.
 * Bo and Dee are in no organization.
 */
const world = async (page: Page) => {
  for (const name of ["Ada", "Bo", "Cy", "Dee"]) await createAgent(page, name)
  await makeOrg(page, "Product", [])
  await makeOrg(page, "Docs", ["Ada", "Cy"], "Product")
  await makeOrg(page, "Press", [], "Product")
  await makeOrg(page, "Ops", [])
  const product = await orgByName(page, "Product")
  await rpc(page, "organizations.update", {
    id: product.id,
    patch: { memberIds: [await agentIdOf(page, "Ada"), await agentIdOf(page, "Cy")] },
  })
}

const openChart = async (page: Page) => {
  const close = page.getByTestId("settings-close")
  if (await close.isVisible().catch(() => false)) await close.click()
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-page")).toBeVisible()
  await expect(page.getByTestId("org-canvas")).toBeVisible()
}
const dialog = (page: Page) => page.getByTestId("org-dialog")
const closeDialog = async (page: Page) => {
  await page.keyboard.press("Escape")
  await expect(dialog(page)).toHaveCount(0)
}
const unit = (page: Page, orgId: string) =>
  page.locator(`[data-testid=org-unit][data-key="o:${orgId}"]`)
const copyOf = (page: Page, agentId: string, orgId: string) =>
  page.locator(`[data-testid=org-node][data-agent-id="${agentId}"][data-key^="o:${orgId}"]`)
/** Opens the form of an organization with a click on its node. */
const openForm = async (page: Page, name: string) => {
  await unit(page, (await orgByName(page, name)).id)
    .getByTestId("org-unit-name")
    .click()
  await expect(dialog(page)).toBeVisible()
}
const parentOption = (page: Page, name: string) =>
  page.getByTestId("org-parent").locator("option").filter({ hasText: name })
const menu = (page: Page) => page.getByTestId("org-menu")
const notice = (page: Page) => page.getByTestId("org-notice-text")

const center = async (target: Locator) => {
  const box = await target.boundingBox()
  if (!box) throw new Error("no box")
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
const drag = async (
  page: Page,
  from: Locator,
  to: { x: number; y: number },
  during?: () => Promise<void>,
) => {
  const start = await center(from)
  await page.mouse.move(start.x, start.y)
  await page.mouse.down()
  await page.mouse.move(start.x + 10, start.y + 10, { steps: 3 })
  await page.mouse.move(to.x, to.y, { steps: 8 })
  await during?.()
  await page.mouse.up()
}

/** The box of the form fits the window, and nothing in it scrolls sideways. */
const fits = async (page: Page, box: Locator) => {
  const width = await page.evaluate(() => window.innerWidth)
  const rect = (await box.boundingBox()) as { x: number; width: number }
  expect(rect.x).toBeGreaterThanOrEqual(0)
  expect(rect.x + rect.width).toBeLessThanOrEqual(width)
  const shell = page.locator("[role=dialog]").last()
  expect(await shell.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
}

test("one line in the form: an agent that cannot be added is muted with 'In <other>.', the parent field mutes what splits a line, and a save is checked as one change", async () => {
  test.setTimeout(240_000)
  const { mock, app, page } = await startOne()
  try {
    await world(page)
    await openChart(page)
    const ops = await orgByName(page, "Ops")
    const docs = await orgByName(page, "Docs")

    // --- The field "Members" of Ops: Ada and Cy are in Docs, which is not on one line with Ops ---
    await openForm(page, "Ops")
    for (const name of ["Ada", "Cy"]) {
      await expect(page.getByTestId(`org-member-${name}`)).toBeDisabled()
      await expect(page.getByTestId(`org-member-line-${name}`)).toHaveText("In Docs.")
    }
    // Bo is in no organization: it can be ticked, and it has no line.
    await expect(page.getByTestId("org-member-Bo")).toBeEnabled()
    await expect(page.getByTestId("org-member-line-Bo")).toHaveCount(0)
    await shot(page, "s130-01-form-members-muted")

    // --- A save of a form that went stale shows the long line, and nothing changes ---------------
    await page.getByTestId("org-member-Dee").check()
    // Dee joins Press behind the open form, so "Ops" is off the line of Dee now.
    await rpc(page, "organizations.update", {
      id: (await orgByName(page, "Press")).id,
      patch: { memberIds: [await agentIdOf(page, "Dee")] },
    })
    await page.getByTestId("org-submit").click()
    await expect(page.getByTestId("org-error")).toHaveText(
      "Dee is in Press, which is not on one line with Ops.",
    )
    await expect(dialog(page)).toBeVisible()
    expect((await orgByName(page, "Ops")).memberIds).toEqual([])
    await shot(page, "s130-02-form-save-refused")
    await closeDialog(page)

    // --- The field "Parent organization" of Docs: Ops would split the line of Ada ---------------
    await openForm(page, "Docs")
    const opsOption = parentOption(page, "Ops")
    await expect(opsOption).toHaveAttribute("disabled", "")
    await expect(opsOption).toHaveAttribute("data-refusal", "line")
    await expect(opsOption).toContainText("Would split the line of Ada.")
    // Press is not muted: Docs under Press keeps Ada on one line (Product > Press > Docs).
    await expect(parentOption(page, "Press")).not.toHaveAttribute("disabled", "")
    await shot(page, "s130-03-form-parent-muted")
    await closeDialog(page)

    // --- A save is one change: the new parent and the member together ----------------------------
    await page.getByTestId("org-new").click()
    await expect(dialog(page)).toBeVisible()
    await page.getByTestId("org-form").getByTestId("org-name").fill("Site")
    // With no parent yet, Ada is muted. With the parent Docs, Ada can be ticked.
    await expect(page.getByTestId("org-member-Ada")).toBeDisabled()
    await page.getByTestId("org-parent").selectOption({ label: "Docs" })
    await expect(page.getByTestId("org-member-Ada")).toBeEnabled()
    await page.getByTestId("org-member-Ada").check()
    await page.getByTestId("org-submit").click()
    await expect(dialog(page)).toHaveCount(0)
    const site = await orgByName(page, "Site")
    expect(site.parentId).toBe(docs.id)
    expect(site.memberIds).toEqual([await agentIdOf(page, "Ada")])
    expect(ops.memberIds).toEqual([])
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("one line on the chart: the lists mute what the line refuses, a move is checked after the agent left, a refused parent shows the long line, a drag shows no ring", async () => {
  test.setTimeout(300_000)
  const { mock, app, page } = await startOne()
  try {
    await world(page)
    await openChart(page)
    const [ada, bo, cy] = await Promise.all(["Ada", "Bo", "Cy"].map((n) => agentIdOf(page, n)))
    const docs = await orgByName(page, "Docs")
    const press = await orgByName(page, "Press")
    const ops = await orgByName(page, "Ops")
    const product = await orgByName(page, "Product")
    const reason = (testId: string) => page.getByTestId(`${testId}-reason`)

    // --- "Add to organization…" of Cy: Press and Ops are muted with the short reason ------------
    await copyOf(page, cy as string, docs.id).click({ button: "right" })
    await menu(page).getByTestId("org-menu-add").click()
    for (const id of [press.id, ops.id]) {
      await expect(menu(page).getByTestId(`org-menu-add-to-${id}`)).toBeDisabled()
      await expect(reason(`org-menu-add-to-${id}`)).toHaveText("Not on one line with Docs.")
    }
    await shot(page, "s130-04-menu-add-muted")
    await page.keyboard.press("Escape")
    await expect(menu(page)).toHaveCount(0)

    // --- "Move to organization…" of Cy from Docs: checked after Cy has left Docs -----------------
    // Press is allowed (Cy stays in Product, and Press is under Product). Ops is not (Product).
    await copyOf(page, cy as string, docs.id).click({ button: "right" })
    await menu(page).getByTestId("org-menu-move").click()
    await expect(menu(page).getByTestId(`org-menu-move-to-${press.id}`)).toBeEnabled()
    await expect(menu(page).getByTestId(`org-menu-move-to-${ops.id}`)).toBeDisabled()
    await expect(reason(`org-menu-move-to-${ops.id}`)).toHaveText("Not on one line with Product.")
    await menu(page).getByTestId(`org-menu-move-to-${press.id}`).click()
    await expect(notice(page)).toHaveText("Moved Cy to Press.")
    await expect
      .poll(() => teams(page))
      .toEqual(["Docs: Ada", "Ops: ", "Press: Cy", "Product: Ada, Cy"])
    await shot(page, "s130-05-moved-after-leave")

    // --- "Add member…" of Ops: Ada is muted with 'In Docs.', Bo is not -------------------------
    await unit(page, ops.id).click({ button: "right" })
    await menu(page).getByTestId("org-menu-add-member").click()
    await expect(menu(page).getByTestId(`org-menu-member-${ada}`)).toBeDisabled()
    await expect(reason(`org-menu-member-${ada}`)).toHaveText("In Docs.")
    await expect(menu(page).getByTestId(`org-menu-member-${bo}`)).toBeEnabled()
    await page.keyboard.press("Escape")
    await expect(menu(page)).toHaveCount(0)

    // --- "Put under…" of Docs: Ops would split the line of Ada; Press is allowed -----------------
    await unit(page, docs.id).click({ button: "right" })
    await menu(page).getByTestId("org-menu-put-under").click()
    await expect(menu(page).getByTestId(`org-menu-under-${ops.id}`)).toBeDisabled()
    await expect(reason(`org-menu-under-${ops.id}`)).toHaveText("Would split the line of Ada.")
    await expect(menu(page).getByTestId(`org-menu-under-${press.id}`)).toBeEnabled()
    await shot(page, "s130-06-menu-put-under-muted")
    await page.keyboard.press("Escape")
    await expect(menu(page)).toHaveCount(0)

    // --- "Move to the top" of Docs is refused with the long line at the bottom of the canvas -------
    await unit(page, docs.id).click({ button: "right" })
    await menu(page).getByTestId("org-menu-to-top").click()
    await expect(notice(page)).toHaveText(
      "Ada is in Docs and Product, which would not be on one line.",
    )
    await expect(page.getByTestId("org-notice")).toHaveAttribute("data-kind", "refused")
    await expect(page.getByTestId("org-undo")).toHaveCount(0)
    await shot(page, "s130-07-refused-line")
    expect((await orgByName(page, "Docs")).parentId).toBe(product.id)

    // --- A stale menu: the entry was allowed when the menu opened; the server refuses it ---------
    await unit(page, ops.id).click({ button: "right" })
    await menu(page).getByTestId("org-menu-add-member").click()
    await expect(menu(page).getByTestId(`org-menu-member-${bo}`)).toBeEnabled()
    // Behind the open menu Bo joins Docs, so Ops is off the line of Bo.
    await rpc(page, "organizations.update", {
      id: docs.id,
      patch: { memberIds: [ada, bo] },
    })
    await menu(page).getByTestId(`org-menu-member-${bo}`).click()
    await expect(notice(page)).toHaveText("Bo is in Docs, which is not on one line with Ops.")
    await expect(page.getByTestId("org-notice")).toHaveAttribute("data-kind", "refused")
    expect((await orgByName(page, "Ops")).memberIds).toEqual([])
    await rpc(page, "organizations.update", { id: docs.id, patch: { memberIds: [ada] } })

    // --- A drag of Docs onto Ops shows no ring and changes nothing; onto Press it does -----------
    const docsHandle = unit(page, docs.id).getByTestId("org-unit-name")
    await drag(page, docsHandle, await center(unit(page, ops.id)), async () => {
      await expect(unit(page, ops.id)).toHaveAttribute("data-ring", "false")
      await expect(unit(page, press.id)).toHaveAttribute("data-ring", "true")
      await shot(page, "s130-08-drag-no-ring")
    })
    expect((await orgByName(page, "Docs")).parentId).toBe(product.id)
    // An agent drag: Bo from "No organization" onto Ops is allowed (Bo is in no organization).
    // Ada, dragged with Option from Docs onto Ops, shows no ring.
    await page.keyboard.down("Alt")
    await drag(
      page,
      copyOf(page, ada as string, docs.id),
      await center(unit(page, ops.id)),
      async () => {
        await expect(unit(page, ops.id)).toHaveAttribute("data-ring", "false")
        await expect(unit(page, product.id)).toHaveAttribute("data-ring", "false")
      },
    )
    await page.keyboard.up("Alt")
    expect((await teams(page)).join("|")).toBe("Docs: Ada|Ops: |Press: Cy|Product: Ada, Cy")

    // --- Remove Ada from Product: the move of Docs under Ops works now -----------------------------
    await copyOf(page, ada as string, product.id).click({ button: "right" })
    await menu(page).getByTestId("org-menu-remove").click()
    await expect(notice(page)).toHaveText("Removed Ada from Product.")
    await unit(page, docs.id).click({ button: "right" })
    await menu(page).getByTestId("org-menu-put-under").click()
    await expect(menu(page).getByTestId(`org-menu-under-${ops.id}`)).toBeEnabled()
    await menu(page).getByTestId(`org-menu-under-${ops.id}`).click()
    await expect(notice(page)).toHaveText("Put Docs under Ops.")
    expect((await orgByName(page, "Docs")).parentId).toBe(ops.id)
    await shot(page, "s130-09-put-under-works")
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("delete: the confirm counts the direct sub-organizations and names the parent, they move up, and the members keep both organizations", async () => {
  test.setTimeout(240_000)
  const { mock, app, page } = await startOne()
  try {
    for (const name of ["Ada", "Bo"]) await createAgent(page, name)
    // Product > Docs > Site and Blog; Product > Press. Ada is in Product and Site.
    await makeOrg(page, "Product", [])
    await makeOrg(page, "Docs", ["Bo"], "Product")
    await makeOrg(page, "Site", ["Ada"], "Docs")
    await makeOrg(page, "Blog", [], "Docs")
    await makeOrg(page, "Press", [], "Product")
    await rpc(page, "organizations.update", {
      id: (await orgByName(page, "Product")).id,
      patch: { memberIds: [await agentIdOf(page, "Ada")] },
    })
    await openChart(page)

    // --- Delete Docs (under Product, with Site and Blog): two move up to Product -------------------
    await openForm(page, "Docs")
    await page.getByTestId("org-delete").click()
    await expect(page.getByTestId("org-delete-lower")).toHaveText(
      "2 sub-organizations move up to Product.",
    )
    await expect(page.getByTestId("org-delete-confirm")).toContainText(
      "The access that this organization gives is gone.",
    )
    await shot(page, "s130-10-delete-moves-up")
    await page.getByTestId("org-delete-go").click()
    await expect(dialog(page)).toHaveCount(0)
    await expect
      .poll(() => parentsOf(page))
      .toEqual(["Blog>Product", "Press>Product", "Product>-", "Site>Product"])
    // Ada is still a member of Product and Site, and Bo is still an agent.
    expect((await teams(page)).join("|")).toBe("Blog: |Press: |Product: Ada|Site: Ada")
    expect(await agentIdOf(page, "Bo")).toBeTruthy()

    // --- Delete Product (no parent): three sub-organizations become top organizations ---------------
    await openForm(page, "Product")
    await page.getByTestId("org-delete").click()
    await expect(page.getByTestId("org-delete-lower")).toHaveText(
      "3 sub-organizations become top organizations.",
    )
    await shot(page, "s130-11-delete-becomes-top")
    await page.getByTestId("org-delete-go").click()
    await expect(dialog(page)).toHaveCount(0)
    await expect.poll(() => parentsOf(page)).toEqual(["Blog>-", "Press>-", "Site>-"])

    // --- A delete with no sub-organization has no line --------------------------------------------
    await openForm(page, "Press")
    await page.getByTestId("org-delete").click()
    await expect(page.getByTestId("org-delete-confirm")).toBeVisible()
    await expect(page.getByTestId("org-delete-lower")).toHaveCount(0)
    // Escape goes back from the confirm; a second Escape closes the form.
    await page.keyboard.press("Escape")
    await closeDialog(page)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

test("one line in Korean and in the narrowest window: the lines, the reasons and the confirm are Korean and fit", async () => {
  test.setTimeout(240_000)
  const { mock, app, page } = await startOne("ko-KR")
  try {
    for (const name of ["Ada", "Bo"]) await createAgent(page, name)
    await makeOrg(page, "Product", [])
    await makeOrg(page, "Docs", ["Ada"], "Product")
    await makeOrg(page, "Site", [], "Docs")
    await makeOrg(page, "Ops", [])
    const product = await orgByName(page, "Product")
    await rpc(page, "organizations.update", {
      id: product.id,
      patch: { memberIds: [await agentIdOf(page, "Ada")] },
    })
    await openChart(page)
    const docs = await orgByName(page, "Docs")
    const ops = await orgByName(page, "Ops")

    // The form of Ops: Ada is muted with the Korean line.
    await openForm(page, "Ops")
    await expect(page.getByTestId("org-member-Ada")).toBeDisabled()
    await expect(page.getByTestId("org-member-line-Ada")).toHaveText("Docs에 속해 있어요.")
    await closeDialog(page)
    // The parent field of Docs: Ops is muted with the Korean reason.
    await openForm(page, "Docs")
    await expect(parentOption(page, "Ops")).toContainText("Ada의 한 줄이 나뉘어요.")
    await closeDialog(page)

    // The menu: the short reason and the long line are Korean.
    await unit(page, docs.id).click({ button: "right" })
    await menu(page).getByTestId("org-menu-put-under").click()
    await expect(page.getByTestId(`org-menu-under-${ops.id}-reason`)).toHaveText(
      "Ada의 한 줄이 나뉘어요.",
    )
    await page.keyboard.press("Escape")
    await unit(page, docs.id).click({ button: "right" })
    await menu(page).getByTestId("org-menu-to-top").click()
    await expect(notice(page)).toHaveText(
      "Ada는 Docs과(와) Product에 속해 있어서 한 줄에 있지 않게 돼요.",
    )
    await shot(page, "s130-12-korean-refused-line")

    // The confirm of a delete: the sub-organization moves up to the parent.
    await openForm(page, "Docs")
    await page.getByTestId("org-delete").click()
    await expect(page.getByTestId("org-delete-lower")).toHaveText(
      "하위 조직 1개가 Product 아래로 올라가요.",
    )
    await shot(page, "s130-13-korean-delete-confirm")
    await page.keyboard.press("Escape")
    await closeDialog(page)

    // The narrowest window: the form of Ops keeps the muted rows and their lines inside.
    await openForm(page, "Ops")
    await resizeWindow(app, 480, 600)
    await expect(page.getByTestId("org-member-line-Ada")).toBeVisible()
    await fits(page, dialog(page))
    await fits(page, page.getByTestId("org-submit"))
    const row = page.getByTestId("org-member-line-Ada")
    const width = await page.evaluate(() => window.innerWidth)
    const box = (await row.boundingBox()) as { x: number; width: number }
    expect(box.x + box.width).toBeLessThanOrEqual(width)
    await shot(page, "s130-14-narrow-korean")
    await closeDialog(page)
  } finally {
    await app.close().catch(() => {})
    await mock.close()
  }
})

// --- A linked computer (spec 012) --------------------------------------------------------------

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const linkedServerId = (page: Page) =>
  page.evaluate(async () => {
    // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
    const result = await (window as any).robot.invoke("servers.list")
    return (result.value as { id: string; kind: string }[]).find((s) => s.kind === "linked")?.id
  }) as Promise<string>
const ask = (page: Page, serverId: string, method: string, input?: unknown) =>
  page.evaluate(
    async ([m, i, s]) => {
      // biome-ignore lint/suspicious/noExplicitAny: the bridge is typed in the app
      const r = await (window as any).robot.invoke(m, i, s)
      return r.ok ? "ok" : (r.error.code as string)
    },
    [method, input, serverId] as [string, unknown, string],
  )

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
  await expect(two.page.getByTestId("join-can-change")).toHaveAttribute("aria-checked", "true")
  if (!canChange) await two.page.getByTestId("join-can-change").click()
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

const startPair = async () => {
  const ports = await freePortPair()
  const mock = await startMockProvider()
  const two = await launch(freshUserData(), envFor(ports[1]))
  const one = await launch(freshUserData(), envFor(ports[0]))
  await resizeWindow(two.app, 1200, 860)
  await resizeWindow(one.app, 1200, 860)
  await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
  await openDevices(two.page)
  await setName(two.page, "MacBook 2")
  await closeSettings(two.page)
  await openDevices(one.page)
  await setName(one.page, "MacBook 1")
  await closeSettings(one.page)
  return { mock, one, two }
}

for (const canChange of [true, false]) {
  test(`one line on a linked computer ${canChange ? "with" : "without"} the switch 'Can create and change agents': ${canChange ? "the same refusal as the form" : "the form is read only and the server refuses a change"}`, async () => {
    test.setTimeout(300_000)
    const { mock, one, two } = await startPair()
    try {
      for (const name of ["Ada", "Bo"]) await createAgent(two.page, name)
      await makeOrg(two.page, "Product", [])
      await makeOrg(two.page, "Docs", ["Ada"], "Product")
      await makeOrg(two.page, "Ops", [])
      const product = await orgByName(two.page, "Product")
      const docs = await orgByName(two.page, "Docs")
      const ops = await orgByName(two.page, "Ops")
      const ada = await agentIdOf(two.page, "Ada")
      await rpc(two.page, "organizations.update", { id: product.id, patch: { memberIds: [ada] } })
      await pairOneWay(one, two, canChange)
      await closeSettings(two.page)
      await tile(one.page, "MacBook 2").click()
      await openChart(one.page)
      const serverId = await linkedServerId(one.page)

      // The form of Ops shows Ada muted with 'In Docs.', with or without the switch.
      await unit(one.page, ops.id).getByTestId("org-unit-name").click()
      await expect(dialog(one.page)).toBeVisible()
      await expect(one.page.getByTestId("org-member-Ada")).toBeDisabled()
      await expect(one.page.getByTestId("org-member-line-Ada")).toHaveText("In Docs.")
      await shot(one.page, `s130-15-linked-${canChange ? "with" : "without"}-switch`)
      await closeDialog(one.page)

      if (canChange) {
        // The server gives the same refusal as the form, to the chart of MacBook 1.
        expect(
          await ask(one.page, serverId, "organizations.update", {
            id: ops.id,
            patch: { memberIds: [ada] },
          }),
        ).toBe("org_line_member")
        await unit(one.page, docs.id).click({ button: "right" })
        await menu(one.page).getByTestId("org-menu-to-top").click()
        await expect(notice(one.page)).toHaveText(
          "Ada is in Docs and Product, which would not be on one line.",
        )
        await expect(one.page.getByTestId("org-notice")).toHaveAttribute("data-kind", "refused")
        // A move that keeps the line works.
        await unit(one.page, docs.id).click({ button: "right" })
        await menu(one.page).getByTestId("org-menu-put-under").click()
        await expect(menu(one.page).getByTestId(`org-menu-under-${ops.id}`)).toBeDisabled()
        await one.page.keyboard.press("Escape")
        await expect(menu(one.page)).toHaveCount(0)
        expect((await orgByName(two.page, "Docs")).parentId).toBe(product.id)
      } else {
        // No edit on the chart, and the server refuses a change with the name of the switch.
        expect(
          await ask(one.page, serverId, "organizations.update", {
            id: ops.id,
            patch: { memberIds: [ada] },
          }),
        ).toBe("change_off")
        expect(
          await ask(one.page, serverId, "organizations.update", {
            id: docs.id,
            patch: { parentId: null },
          }),
        ).toBe("change_off")
        expect((await orgByName(two.page, "Docs")).parentId).toBe(product.id)
      }
    } finally {
      await one.app.close().catch(() => {})
      await two.app.close().catch(() => {})
      await mock.close()
    }
  })
}
