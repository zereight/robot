import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, type Page, test } from "@playwright/test"
import { unzipSync, zipSync } from "fflate"
import { migrations } from "../src/main/services/migrations.ts"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { freePortPair } from "./ports.ts"
import { closeSettings, rpc, synced, turnOnSync } from "./sync-helpers.ts"

// Spec 030, "One line" > "Repair" and "Migration" > "Agents in channels that do not make one line"
// (S122b), with 019 (one line of organizations), 014 (the organization log) and 029 (the line at
// the bottom of the canvas): an agent that two computers added to two organizations that are not on
// one line while apart leaves the organization that it joined last, on both computers, with a line on
// the open chart and a line in the log. An import and the migration of two channels repair the same
// way, with the tie order.

interface OrgInfo {
  id: string
  name: string
  parentId: string | null
  memberIds: string[]
  leadId: string | null
}
interface LogLine {
  event: string
  organization: string
  agent: string
  kind: string
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

/** The members of each organization by name: "Docs: Ada". */
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
    .map((o) => `${o.name}: ${o.memberIds.map((id) => names.get(id) ?? id).join(", ")}`)
    .sort()
}
const leadsOf = async (page: Page) =>
  Object.fromEntries((await orgsOf(page)).map((o) => [o.name, o.leadId]))

/** The lines of the organization log of one data folder. */
const logLines = (userData: string): LogLine[] => {
  try {
    return readFileSync(join(userData, "logs", "organizations.log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as LogLine)
  } catch {
    return []
  }
}

const noticeText = async (page: Page) => {
  const notice = page.getByTestId("org-notice-text")
  return (await notice.count()) > 0 ? ((await notice.first().textContent()) ?? "") : null
}

const pausedPair = async (a: Page, b: Page, work: () => Promise<void>) => {
  const linkId = (await rpc<{ linkId: string }[]>(a, "sync.list"))[0]?.linkId
  await rpc(a, "sync.pause", { linkId })
  // The other computer holds the pause too, so nothing crosses while the two work apart.
  await expect
    .poll(async () => (await rpc<{ state: string }[]>(b, "sync.list"))[0]?.state, {
      timeout: 20_000,
    })
    .toBe("paused")
  try {
    await work()
  } finally {
    await rpc(a, "sync.resume", { linkId })
  }
}

// --- Two computers (spec 030 acceptance, 019) -------------------------------------------------------

for (const language of ["en", "ko"] as const) {
  test(`two computers add the same agent to Docs and Ops while apart: both end with the agent in Docs, the chart and the log say so (${language})`, async () => {
    test.setTimeout(300_000)
    const s = await synced(await freePortPair())
    const { one, two } = s
    const expected =
      language === "en"
        ? "Ada was removed from Ops. It is in Docs, which is not on one line with it."
        : "Ada를 Ops에서 뺐어요. Docs에 속해 있는데, 그 두 조직이 한 줄에 있지 않아요."
    try {
      const serverId = await serverIdOf(one.page)
      await rpc(one.page, "agents.create", { serverId, name: "Ada", role: "", instructions: "" })
      for (const name of ["Docs", "Ops"])
        await rpc(one.page, "organizations.create", {
          serverId,
          name,
          memberIds: [],
          leadId: null,
        })
      await turnOnSync(one, two)
      await closeSettings(one.page)
      await closeSettings(two.page)
      await expect
        .poll(async () => (await teams(two.page)).join("|"), { timeout: 30_000 })
        .toBe("Docs: |Ops: ")
      expect(await agentIdOf(two.page, "Ada")).toBeTruthy()
      if (language === "ko") {
        await rpc(one.page, "settings.update", { language: "ko" })
        await rpc(two.page, "settings.update", { language: "ko" })
      }
      for (const side of [one, two]) {
        await resizeWindow(side.app, 1300, 900)
        await side.page.getByTestId("page-orgchart").click()
        await expect(side.page.getByTestId("org-canvas")).toBeVisible()
      }

      // Apart: computer 1 adds Ada to "Docs"; a little later, computer 2 adds her to "Ops" as its
      // lead. Each change is right alone.
      const ada = await agentIdOf(one.page, "Ada")
      const docs = await orgByName(one.page, "Docs")
      const ops = await orgByName(two.page, "Ops")
      await pausedPair(one.page, two.page, async () => {
        await rpc(one.page, "organizations.update", { id: docs.id, patch: { memberIds: [ada] } })
        await new Promise((resolve) => setTimeout(resolve, 700))
        await rpc(two.page, "organizations.update", {
          id: ops.id,
          patch: { memberIds: [ada], leadId: ada },
        })
      })

      // The computer that found the break shows the line on its open chart: 10 seconds, no Undo.
      await expect
        .poll(async () => (await noticeText(one.page)) ?? (await noticeText(two.page)), {
          timeout: 60_000,
        })
        .toBe(expected)
      const shown = [one.page, two.page]
      const texts = await Promise.all(shown.map((p) => noticeText(p)))
      for (const [i, text] of texts.entries()) {
        if (text === null) continue
        expect(text).toBe(expected)
        await expect(
          shown[i]?.getByTestId("org-notice") as ReturnType<Page["getByTestId"]>,
        ).toHaveAttribute("data-kind", "refused")
        await expect(
          shown[i]?.getByTestId("org-undo") as ReturnType<Page["getByTestId"]>,
        ).toHaveCount(0)
        await shot(shown[i] as Page, `s122b-01-${language}-${i === 0 ? "one" : "two"}-notice`)
      }
      // Both computers end with the agent in "Docs" only, where she was added first, and "Ops" has
      // no lead.
      for (const page of [one.page, two.page])
        await expect
          .poll(async () => (await teams(page)).join("|"), { timeout: 60_000 })
          .toBe("Docs: Ada|Ops: ")
      for (const page of [one.page, two.page])
        expect(await leadsOf(page)).toEqual({ Docs: null, Ops: null })

      // The line goes after 10 seconds.
      await expect
        .poll(async () => (await noticeText(one.page)) ?? (await noticeText(two.page)), {
          timeout: 20_000,
        })
        .toBeNull()
      // The chart draws Ada once, in "Docs".
      await expect(one.page.getByTestId("org-unit").filter({ hasText: "Docs" })).toBeVisible()
      await shot(one.page, `s122b-02-${language}-chart-after`)

      // One line in the organization log for each computer that made the removal. It holds the
      // agent, the organization and the kind, and no text.
      const lines = [logLines(s.data1), logLines(s.data2)]
      const written = lines.flat()
      expect(written.length).toBeGreaterThanOrEqual(1)
      expect(lines.every((l) => l.length <= 1)).toBe(true)
      for (const line of written)
        expect(line).toMatchObject({
          event: "line_repaired",
          organization: "Ops",
          agent: "Ada",
          kind: "line",
        })
      // A computer that showed the line wrote its line.
      for (const [i, text] of texts.entries()) if (text !== null) expect(lines[i]).toHaveLength(1)

      // It is stable: later nothing changes, and the other computer repairs nothing more.
      await new Promise((resolve) => setTimeout(resolve, 4000))
      for (const page of [one.page, two.page])
        expect((await teams(page)).join("|")).toBe("Docs: Ada|Ops: ")
      expect([logLines(s.data1).length, logLines(s.data2).length]).toEqual(
        lines.map((l) => l.length),
      )
    } finally {
      await one.app.close().catch(() => {})
      await two.app.close().catch(() => {})
      await s.mock.close()
    }
  })
}

// --- An import (spec 030, 014) ----------------------------------------------------------------------

test("an archive that holds an agent in two organizations that are not on one line comes back repaired, with a line in the log", async () => {
  test.setTimeout(180_000)
  const work = mkdtempSync(join(tmpdir(), "robot-s122b-"))
  const archive = join(work, "export.zip")
  const broken = join(work, "broken.zip")
  const source = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_SAVE_PATH: archive,
  })
  try {
    const serverId = await serverIdOf(source.page)
    await rpc(source.page, "agents.create", { serverId, name: "Ada", role: "", instructions: "" })
    await rpc(source.page, "agents.create", { serverId, name: "Bo", role: "", instructions: "" })
    const ada = await agentIdOf(source.page, "Ada")
    const bo = await agentIdOf(source.page, "Bo")
    const product = await rpc<OrgInfo>(source.page, "organizations.create", {
      serverId,
      name: "Product",
      memberIds: [ada],
      leadId: null,
    })
    const docs = await rpc<OrgInfo>(source.page, "organizations.create", {
      serverId,
      name: "Docs",
      memberIds: [ada, bo],
      leadId: null,
      parentId: product.id,
    })
    const ops = await rpc<OrgInfo>(source.page, "organizations.create", {
      serverId,
      name: "Ops",
      memberIds: [],
      leadId: null,
    })
    expect((await rpc<{ path: string | null }>(source.page, "data.export")).path).toBe(archive)

    // The app refuses this state, but a file can hold it: put Ada into "Ops" (she is in "Product"
    // and "Docs", which are on one line), and make "Ops" the organization that was made last.
    const entries = unzipSync(readFileSync(archive))
    const dbFile = join(work, "robot.db")
    writeFileSync(dbFile, entries["robot.db"] as Uint8Array)
    const db = new DatabaseSync(dbFile)
    db.prepare("INSERT INTO org_member (org_id, agent_id, position) VALUES (?, ?, 1)").run(
      ops.id,
      ada,
    )
    db.prepare("UPDATE org_unit SET lead_agent_id = ? WHERE id = ?").run(ada, ops.id)
    db.prepare("UPDATE org_unit SET created_at = ? WHERE id = ?").run(1000, product.id)
    db.prepare("UPDATE org_unit SET created_at = ? WHERE id = ?").run(2000, docs.id)
    db.prepare("UPDATE org_unit SET created_at = ? WHERE id = ?").run(3000, ops.id)
    db.exec("VACUUM")
    db.close()
    writeFileSync(broken, zipSync({ ...entries, "robot.db": new Uint8Array(readFileSync(dbFile)) }))
  } finally {
    await source.app.close().catch(() => {})
  }

  const target = freshUserData()
  const empty = await launch(target, {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_OPEN_PATH: broken,
  })
  try {
    await resizeWindow(empty.app, 1300, 900)
    expect(await rpc(empty.page, "data.restore")).toMatchObject({ agents: 2 })
    // Ada leaves "Ops", the organization that was made last. Bo is on one line already.
    expect(await teams(empty.page)).toEqual(["Docs: Ada, Bo", "Ops: ", "Product: Ada"])
    // Ada was the lead of "Ops" in the file: a member that is removed is no longer the lead.
    expect(await leadsOf(empty.page)).toEqual({ Docs: null, Ops: null, Product: null })
    expect(logLines(target)).toEqual([
      expect.objectContaining({
        event: "line_repaired",
        organization: "Ops",
        agent: "Ada",
        kind: "line",
      }),
    ])
    await empty.page.getByTestId("page-orgchart").click()
    await expect(empty.page.getByTestId("org-canvas")).toBeVisible()
    await shot(empty.page, "s122b-03-import-chart")
  } finally {
    await empty.app.close().catch(() => {})
  }
})

// --- The migration of two channels (spec 030, "Migration") ---------------------------------------------

/**
 * A database as the version before the organizations left it: the channels "Docs" (made first) and
 * "Ops", each in the channel list of a skill (a tool), with no parent, and the member Ann in both.
 * The app is not started yet.
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
  for (const name of ["Ann", "Cy"]) agent.run(name, name, name.toLowerCase(), join(userData, name))
  const channel = db.prepare(
    `INSERT INTO channel (id, server_id, name, name_key, topic, lead_agent_id, parent_channel_id,
      daily_token_limit, created_at, updated_at) VALUES (?, 's', ?, ?, '', ?, NULL, NULL, ?, ?)`,
  )
  const member = db.prepare(
    "INSERT INTO channel_member (channel_id, agent_id, position) VALUES (?, ?, ?)",
  )
  // "Docs" was made first. "Ops" has Ann as its lead.
  channel.run("Docs", "Docs", "docs", "Ann", 1, 1)
  member.run("Docs", "Ann", 0)
  channel.run("Ops", "Ops", "ops", "Ann", 2, 2)
  member.run("Ops", "Cy", 0)
  member.run("Ops", "Ann", 1)
  db.exec(`INSERT INTO skill (id, server_id, name, name_key, instructions, agents, channels, enabled, created_at)
    VALUES ('sk', 's', 'Notes', 'notes', 'x', '[]', '["Docs","Ops"]', 1, 1)`)
  db.close()
}

test("an old database with two channels that do not make one line: the agent stays in the organization of the channel made first and in both channels", async () => {
  test.setTimeout(120_000)
  const userData = freshUserData()
  oldDatabase(userData)
  const { app, page } = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 900)
  const server = await serverIdOf(page)
  expect(server).toBe("s")

  // The first start made the organizations "Docs" and "Ops". Ann is a member of "Docs" and not of
  // "Ops"; Cy stays in "Ops". "Ops" lost its lead, because Ann was its lead.
  expect(await teams(page)).toEqual(["Docs: Ann", "Ops: Cy"])
  expect(await leadsOf(page)).toEqual({ Docs: await agentIdOf(page, "Ann"), Ops: null })
  // The channel "Ops" still has Ann, and "Docs" too.
  const channels = await rpc<{ name: string; memberIds: string[] }[]>(page, "channels.list", {
    serverId: server,
  })
  const ann = await agentIdOf(page, "Ann")
  for (const name of ["Docs", "Ops"])
    expect(channels.find((c) => c.name === name)?.memberIds).toContain(ann)
  // The log has one line for the removal.
  expect(logLines(userData)).toEqual([
    expect.objectContaining({
      event: "line_repaired",
      organization: "Ops",
      agent: "Ann",
      kind: "line",
    }),
  ])
  await page.getByTestId("page-orgchart").click()
  await expect(page.getByTestId("org-canvas")).toBeVisible()
  await shot(page, "s122b-04-migration-chart")
  await app.close()

  // The second start repairs nothing more, and writes no second line.
  const again = await launch(userData, { ROBOT_SYSTEM_LOCALE: "en-US" })
  expect(await teams(again.page)).toEqual(["Docs: Ann", "Ops: Cy"])
  expect(logLines(userData)).toHaveLength(1)
  await again.app.close()
})
