import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, type Page, test } from "@playwright/test"
import { migrations } from "../src/main/services/migrations.ts"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

// The channel has no parent channel (spec 004, 030 "Migration" > "What the channel loses", 002,
// 014, 019): the dialog of a channel has no field "Parent channel", the header has no line "In
// <parent channel>", and a database of an older version that holds parent channels starts, shows
// the organizations that the first start made from them, and shows no channel tree. The org chart
// still draws the organizations.

interface OrgInfo {
  id: string
  name: string
  parentId: string | null
  leadId: string | null
  memberIds: string[]
  dailyTokenLimit: number | null
}
interface ChannelInfo {
  id: string
  name: string
  memberIds: string[]
  leadId: string | null
}

const serverOf = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string

/**
 * A database as the version before the organizations left it: every step before the organizations,
 * with "Product" > "Docs" > "Site" as parent channels, a daily token limit on "Docs", one message
 * in "Docs", and "Chat" with no parent, no tool and no limit. The app is not started yet.
 */
const oldDatabase = (userData: string) => {
  mkdirSync(userData, { recursive: true })
  const db = new DatabaseSync(join(userData, "robot.db"))
  const step = migrations.findIndex((sql) => sql.includes("CREATE TABLE org_unit"))
  db.exec("PRAGMA foreign_keys = ON")
  for (const sql of migrations.slice(0, step)) db.exec(sql)
  db.exec(`PRAGMA user_version = ${step}`)
  db.exec(
    "INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'This computer', 'local', 0, 0)",
  )
  const agent = db.prepare(
    `INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
      workspace, section, created_at, updated_at) VALUES (?, 's', ?, ?, '', '', 0, 0, ?, '', 1, 1)`,
  )
  for (const name of ["Pia", "Dee", "Bo"])
    agent.run(name, name, name.toLowerCase(), join(userData, `w-${name}`))
  const channel = db.prepare(
    `INSERT INTO channel (id, server_id, name, name_key, topic, lead_agent_id, parent_channel_id,
      daily_token_limit, created_at, updated_at) VALUES (?, 's', ?, ?, '', ?, ?, ?, ?, ?)`,
  )
  const member = db.prepare(
    "INSERT INTO channel_member (channel_id, agent_id, position) VALUES (?, ?, ?)",
  )
  const make = (
    name: string,
    lead: string,
    members: string[],
    parent: string | null,
    limit: number | null,
    at: number,
  ) => {
    channel.run(name, name, name.toLowerCase(), lead, parent, limit, at, at)
    members.forEach((m, position) => {
      member.run(name, m, position)
    })
  }
  make("Product", "Pia", ["Pia"], null, null, 1)
  make("Docs", "Dee", ["Dee", "Bo"], "Product", 50_000, 2)
  make("Site", "Bo", ["Bo"], "Docs", null, 3)
  make("Chat", "Pia", ["Pia"], null, null, 4)
  db.prepare(
    `INSERT INTO channel_message (id, channel_id, author, agent_id, kind, parts, status, created_at, finished_at)
     VALUES ('m1', 'Docs', 'user', NULL, 'text', ?, 'done', 10, 10)`,
  ).run(JSON.stringify([{ kind: "text", text: "The docs are due on Friday." }]))
  db.close()
}

const openChannel = async (page: Page, id: string) => {
  await page.getByTestId("page-chats").click()
  await page.getByTestId(`place-channel-${id}`).click()
}

test("the dialog of a channel has no 'Parent channel', and the header has no parent line", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Ada", "Bo"]) await createAgent(page, name)
  const server = await serverOf(page)
  const agents = await rpc<{ id: string; name: string }[]>(page, "agents.list", {
    serverId: server,
    archived: false,
  })
  const ada = agents.find((a) => a.name === "Ada")?.id as string
  const channels: ChannelInfo[] = []
  for (const name of ["Product", "Docs"])
    channels.push(
      await rpc<ChannelInfo>(page, "channels.create", {
        serverId: server,
        name,
        topic: "",
        memberIds: [ada],
        leadId: ada,
      }),
    )
  await page.getByTestId("page-chats").click()

  // The new channel dialog: no field for a parent.
  await page.getByTestId("new-channel").click()
  await expect(page.getByTestId("channel-dialog")).toBeVisible()
  await expect(page.getByTestId("channel-name")).toBeVisible()
  await expect(page.getByTestId("channel-parent")).toHaveCount(0)
  await expect(page.getByTestId("channel-dialog")).not.toContainText("Parent channel")
  await expect(page.getByTestId("channel-dialog")).not.toContainText("sub-channel")
  await shot(page, "s121-parent-01-new-channel-dialog")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("channel-dialog")).toBeHidden()

  // The dialog of a channel that exists, and its header.
  const docs = channels[1] as ChannelInfo
  await openChannel(page, docs.id)
  await expect(page.getByTestId("channel-header-name")).toHaveText("Docs")
  await expect(page.getByTestId("channel-header-parent")).toHaveCount(0)
  await page.getByTestId("channel-settings").click()
  await expect(page.getByTestId("channel-dialog")).toBeVisible()
  await expect(page.getByTestId("channel-parent")).toHaveCount(0)
  await expect(page.getByTestId("channel-dialog")).not.toContainText("Parent channel")
  // The fields that stay are still there.
  for (const id of ["channel-name", "channel-topic", "channel-lead", "channel-instructions"])
    await expect(page.getByTestId(id)).toBeVisible()
  await shot(page, "s121-parent-02-channel-dialog")

  // The narrowest window: the dialog has no cut field.
  await resizeWindow(app, 480, 700)
  await expect(page.getByTestId("channel-dialog")).toBeVisible()
  await expect(page.getByTestId("channel-parent")).toHaveCount(0)
  await shot(page, "s121-parent-03-channel-dialog-narrow")
  await page.keyboard.press("Escape")

  // The service does not know a parent channel any more: a field of that name changes nothing, and
  // no channel has it.
  await rpc(page, "channels.update", {
    id: docs.id,
    patch: { topic: "Docs of the site", parentId: channels[0]?.id },
  })
  const after = await rpc<ChannelInfo[]>(page, "channels.list", { serverId: server })
  expect(after.find((c) => c.id === docs.id)).toMatchObject({ name: "Docs" })
  for (const channel of after) expect("parentId" in channel).toBe(false)
  expect(await rpc<OrgInfo[]>(page, "organizations.list", { serverId: server })).toEqual([])
  await app.close()
})

test("an old database with parent channels starts: the organizations show the tree, the channels show none", async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  oldDatabase(userData)
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 900)
  const server = await serverOf(page)
  expect(server).toBe("s")

  // The first start made one organization for each channel with a parent, a sub-channel or a
  // limit; "Chat" has none of these and makes none. The tree is in the organizations.
  const orgs = await rpc<OrgInfo[]>(page, "organizations.list", { serverId: server })
  const byName = (name: string) => orgs.find((o) => o.name === name) as OrgInfo
  expect(orgs.map((o) => o.name).sort()).toEqual(["Docs", "Product", "Site"])
  expect(byName("Product").parentId).toBeNull()
  expect(byName("Docs").parentId).toBe(byName("Product").id)
  expect(byName("Site").parentId).toBe(byName("Docs").id)
  expect(byName("Docs").dailyTokenLimit).toBe(50_000)
  expect(byName("Docs").memberIds).toHaveLength(2)

  // The channels keep their members, leads and messages, and have no parent field.
  const channels = await rpc<ChannelInfo[]>(page, "channels.list", { serverId: server })
  expect(channels.map((c) => c.name).sort()).toEqual(["Chat", "Docs", "Product", "Site"])
  for (const channel of channels) expect("parentId" in channel).toBe(false)
  const docs = channels.find((c) => c.name === "Docs") as ChannelInfo
  expect(docs.memberIds).toHaveLength(2)
  await openChannel(page, docs.id)
  await expect(page.getByTestId("channel-header-name")).toHaveText("Docs")
  await expect(page.getByTestId("channel-header-parent")).toHaveCount(0)
  await expect(page.getByText("The docs are due on Friday.")).toBeVisible()
  await shot(page, "s121-parent-04-old-database-channel")

  // The place list shows the four channels as places: no tree, no indent, no parent line.
  for (const channel of channels)
    await expect(page.getByTestId(`place-channel-${channel.id}`)).toBeVisible()
  await expect(page.getByTestId("channel-header-parent")).toHaveCount(0)

  // The org chart draws the organizations of the first start, with the tree.
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-canvas")).toBeVisible()
  for (const name of ["Product", "Docs", "Site"])
    await expect(page.getByTestId("org-unit").filter({ hasText: name }).first()).toBeVisible()
  await shot(page, "s121-parent-05-old-database-org-chart")
  await app.close()

  // The second start changes nothing: the migration runs once.
  const again = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  const second = await rpc<OrgInfo[]>(again.page, "organizations.list", { serverId: server })
  expect(second.map((o) => o.id).sort()).toEqual(orgs.map((o) => o.id).sort())
  await again.app.close()

  // The column of the old tree stays in the table, and the migration cleared it.
  const db = new DatabaseSync(join(userData, "robot.db"), { readOnly: true })
  expect(
    db.prepare("SELECT COUNT(*) AS n FROM channel WHERE parent_channel_id IS NOT NULL").get(),
  ).toEqual({ n: 0 })
  db.close()
})

test("the words are Korean in the Korean interface: no 'Parent channel' (상위 채널) in the dialog", async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  oldDatabase(userData)
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 900)
  await rpc(page, "settings.update", { language: "ko" })
  const server = await serverOf(page)
  const channels = await rpc<ChannelInfo[]>(page, "channels.list", { serverId: server })
  const docs = channels.find((c) => c.name === "Docs") as ChannelInfo
  await openChannel(page, docs.id)
  await expect(page.getByTestId("channel-header-parent")).toHaveCount(0)
  await page.getByTestId("channel-settings").click()
  await expect(page.getByTestId("channel-dialog")).toBeVisible()
  await expect(page.getByTestId("channel-parent")).toHaveCount(0)
  await expect(page.getByTestId("channel-dialog")).not.toContainText("상위 채널")
  await expect(page.getByTestId("channel-dialog")).not.toContainText("하위 채널")
  await shot(page, "s121-parent-06-korean-dialog")
  await resizeWindow(app, 480, 700)
  await expect(page.getByTestId("channel-dialog")).toBeVisible()
  await shot(page, "s121-parent-07-korean-dialog-narrow")
  await app.close()
})
