import { describe, expect, test } from "bun:test"
import { DatabaseSync } from "node:sqlite"
import { migrate } from "./Database.ts"
import { dataSteps, migrations } from "./migrations.ts"

// Spec 030, "Migration": the first start makes an organization from each channel that has a parent
// channel, a sub-channel, a tool or a daily token limit. The channel keeps its fields (the later
// steps clear them). The id of an organization comes from the id of its channel.

const STEP = migrations.findIndex((sql) => sql.includes("CREATE TABLE org_unit"))

/** A database that holds every step before the organizations, with the old channel data. */
const before = (setup: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(":memory:")
  db.exec("PRAGMA foreign_keys = ON")
  for (const sql of migrations.slice(0, STEP)) db.exec(sql)
  db.exec(`PRAGMA user_version = ${STEP}`)
  db.exec(
    "INSERT INTO server (id, name, kind, position, created_at) VALUES ('s', 'S', 'local', 0, 0)",
  )
  setup(db)
  return db
}

/** Runs the steps from the version of the database up to and with the step at `index`. */
const migrateThrough = (db: DatabaseSync, index: number) => {
  const { user_version } = db.prepare("PRAGMA user_version").get() as { user_version: number }
  for (let version = user_version; version <= index; version++) {
    db.exec("BEGIN")
    db.exec(migrations[version] ?? "")
    dataSteps[version]?.(db)
    db.exec(`PRAGMA user_version = ${version + 1}`)
    db.exec("COMMIT")
  }
}

const agent = (db: DatabaseSync, id: string) =>
  db
    .prepare(
      `INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
        workspace, section, created_at, updated_at) VALUES (?, 's', ?, ?, '', '', 0, 0, '/w', '', 1, 1)`,
    )
    .run(id, id, id.toLowerCase())

const channel = (
  db: DatabaseSync,
  id: string,
  options: {
    parent?: string
    lead?: string
    limit?: number
    members?: string[]
    created?: number
  } = {},
) => {
  db.prepare(
    `INSERT INTO channel (id, server_id, name, name_key, topic, lead_agent_id, parent_channel_id,
      daily_token_limit, created_at, updated_at) VALUES (?, 's', ?, ?, '', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    id,
    id.toLowerCase(),
    options.lead ?? null,
    options.parent ?? null,
    options.limit ?? null,
    options.created ?? 1,
    options.created ?? 1,
  )
  for (const [position, agentId] of (options.members ?? []).entries())
    db.prepare("INSERT INTO channel_member (channel_id, agent_id, position) VALUES (?, ?, ?)").run(
      id,
      agentId,
      position,
    )
}

const orgs = (db: DatabaseSync) =>
  db
    .prepare(
      `SELECT id, name, lead_agent_id AS lead, parent_id AS parent, hand_off_range AS range,
        daily_token_limit AS limit_ FROM org_unit ORDER BY name`,
    )
    .all() as Record<string, unknown>[]
const columns = (db: DatabaseSync, table: string) =>
  (db.prepare(`SELECT name FROM pragma_table_info('${table}')`).all() as { name: string }[]).map(
    (c) => c.name,
  )
const dirty = (db: DatabaseSync) =>
  db.prepare("SELECT kind, id FROM sync_dirty WHERE kind = 'orgunit'").all()
const members = (db: DatabaseSync, orgId: string) =>
  (
    db.prepare("SELECT agent_id FROM org_member WHERE org_id = ? ORDER BY position").all(orgId) as {
      agent_id: string
    }[]
  ).map((m) => m.agent_id)

describe("the step of organizations", () => {
  test("it comes once, and it creates the tables, the triggers and the two list columns", () => {
    expect(STEP).toBeGreaterThan(0)
    expect(migrations.filter((sql) => sql.includes("CREATE TABLE org_unit"))).toHaveLength(1)
    const sql = migrations[STEP] ?? ""
    expect(sql).toContain("CREATE TABLE org_member")
    expect(sql).toContain("ALTER TABLE skill ADD COLUMN organizations TEXT NOT NULL DEFAULT '[]'")
    expect(sql).toContain(
      "ALTER TABLE tool_connection ADD COLUMN organizations TEXT NOT NULL DEFAULT '[]'",
    )
    expect(sql).not.toMatch(/DROP |DELETE FROM/i)
  })

  test("a change of an organization or of its members marks it for sync, in a sync pair", () => {
    const db = before((d) => {
      agent(d, "A")
    })
    migrate(db)
    db.exec(`
      INSERT INTO sync_pair (id, peer_id, peer_name, role, mode, phase, started_at)
        VALUES (1, 'p', 'P', 'a', 'merge', 'copy', 1);
      INSERT INTO org_unit (id, server_id, name, name_key, created_at, updated_at)
        VALUES ('o', 's', 'Docs', 'docs', 1, 1);
    `)
    expect(dirty(db)).toEqual([{ kind: "orgunit", id: "o" }])
    db.exec("DELETE FROM sync_dirty")
    db.exec("INSERT INTO org_member (org_id, agent_id, position) VALUES ('o', 'A', 0)")
    expect(dirty(db)).toEqual([{ kind: "orgunit", id: "o" }])
    db.exec("DELETE FROM sync_dirty")
    // A deleted agent leaves every organization, and that marks the organization.
    db.exec("DELETE FROM agent WHERE id = 'A'")
    expect(members(db, "o")).toEqual([])
    expect(dirty(db)).toEqual([{ kind: "orgunit", id: "o" }])
  })
})

describe("the migration of channels (spec 030, Migration)", () => {
  test('acceptance: "Docs" has the parent channel "Product", a tool and a limit; "Chat" has none', () => {
    const db = before((d) => {
      for (const a of ["P", "D", "M"]) agent(d, a)
      channel(d, "Product", { members: ["P"], lead: "P", created: 1 })
      channel(d, "Docs", {
        parent: "Product",
        members: ["P", "D"],
        lead: "D",
        limit: 50_000,
        created: 2,
      })
      channel(d, "Chat", { members: ["P", "M"], created: 3 })
      d.exec(`
        INSERT INTO skill (id, server_id, name, name_key, instructions, agents, channels, enabled, created_at)
          VALUES ('sk', 's', 'Notes', 'notes', 'x', '[]', '["Docs"]', 1, 1),
                 ('sk2', 's', 'Plain', 'plain', 'x', NULL, '[]', 1, 1);
        INSERT INTO tool_connection (id, server_id, name, name_key, kind, agents, channels, enabled, created_at)
          VALUES ('cn', 's', 'Wiki', 'wiki', 'program', '["P"]', '["Docs"]', 0, 1);
      `)
    })
    migrate(db)

    expect(orgs(db)).toEqual([
      {
        id: "org-Docs",
        name: "Docs",
        lead: "D",
        parent: "org-Product",
        range: "inherit",
        limit_: 50_000,
      },
      {
        id: "org-Product",
        name: "Product",
        lead: "P",
        parent: null,
        range: "inherit",
        limit_: null,
      },
    ])
    expect(members(db, "org-Docs")).toEqual(["P", "D"])
    expect(members(db, "org-Product")).toEqual(["P"])
    // The tool of a channel is the value "On" of its organization, in the list of the skill and
    // of the connection. "Chat" has no tool and no limit, so it makes no organization.
    expect(db.prepare("SELECT organizations FROM skill WHERE id = 'sk'").get()).toEqual({
      organizations: '[{"id":"org-Docs","value":"on"}]',
    })
    expect(db.prepare("SELECT organizations FROM tool_connection WHERE id = 'cn'").get()).toEqual({
      organizations: '[{"id":"org-Docs","value":"on"}]',
    })
    expect(db.prepare("SELECT organizations FROM skill WHERE id = 'sk2'").get()).toEqual({
      organizations: "[]",
    })
    // The channels keep their fields and their members; the later steps move each rule.
    expect(
      db
        .prepare(
          "SELECT parent_channel_id AS p, daily_token_limit AS l FROM channel WHERE id = 'Docs'",
        )
        .get(),
    ).toEqual({ p: "Product", l: 50_000 })
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM channel_member WHERE channel_id = 'Docs'").get(),
    ).toEqual({ n: 2 })
    // The list columns of channels are gone once the organizations hold their value (spec 030,
    // "Tools", S120): see "the step that removes the channels from the agent lists".
    expect(columns(db, "skill")).not.toContain("channels")
    expect(columns(db, "tool_connection")).not.toContain("channels")
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length })
  })

  test('with the hand-off rule "Along the channels", a channel with 2 members makes an organization', () => {
    const db = before((d) => {
      for (const a of ["A", "B", "C"]) agent(d, a)
      channel(d, "Chat", { members: ["A", "B"] })
      channel(d, "Solo", { members: ["C"] })
      d.exec("UPDATE organization SET hand_off = 'channels'")
    })
    migrate(db)
    expect(orgs(db).map((o) => o.name)).toEqual(["Chat"])
    expect(members(db, "org-Chat")).toEqual(["A", "B"])
    // The rule itself stays: the step that moves the hand-off rule renames the value.
    expect(db.prepare("SELECT hand_off FROM organization").get()).toEqual({ hand_off: "channels" })
  })

  test('with the hand-off rule "Any agent", a plain channel makes none', () => {
    const db = before((d) => {
      for (const a of ["A", "B"]) agent(d, a)
      channel(d, "Chat", { members: ["A", "B"] })
    })
    migrate(db)
    expect(orgs(db)).toEqual([])
  })

  test("a lead that is no member is dropped", () => {
    const db = before((d) => {
      agent(d, "A")
      channel(d, "Docs", { members: ["A"], lead: "Gone", limit: 10_000 })
    })
    migrate(db)
    expect(orgs(db)[0]).toMatchObject({ lead: null })
  })

  test("a database with no channel migrates to no organization", () => {
    const db = before(() => {})
    migrate(db)
    expect(orgs(db)).toEqual([])
  })

  test("two computers with the same old data make the same organizations", () => {
    const setup = (d: DatabaseSync) => {
      for (const a of ["A", "B"]) agent(d, a)
      channel(d, "Product", { members: ["A"], created: 5 })
      channel(d, "Docs", { parent: "Product", members: ["A", "B"], created: 6 })
    }
    const one = before(setup)
    const two = before(setup)
    migrate(one)
    migrate(two)
    expect(orgs(one)).toEqual(orgs(two))
    expect(
      orgs(one)
        .map((o) => o.id)
        .sort(),
    ).toEqual(["org-Docs", "org-Product"])
  })

  test("it gives the same result when it runs again", async () => {
    const { migrateChannelsToOrganizations } = await import("./orgMigration.ts")
    const db = before((d) => {
      agent(d, "A")
      channel(d, "Product", { members: ["A"] })
      channel(d, "Docs", { parent: "Product", members: ["A"] })
      d.exec(`INSERT INTO skill (id, server_id, name, name_key, instructions, agents, channels, enabled, created_at)
        VALUES ('sk', 's', 'Notes', 'notes', 'x', '[]', '["Docs"]', 1, 1)`)
    })
    // Only up to the step of the organizations: the next step removes the column that it reads.
    migrateThrough(db, STEP)
    const snapshot = JSON.stringify([
      orgs(db),
      members(db, "org-Docs"),
      db.prepare("SELECT organizations FROM skill").all(),
    ])
    migrateChannelsToOrganizations(db)
    migrateChannelsToOrganizations(db)
    expect(
      JSON.stringify([
        orgs(db),
        members(db, "org-Docs"),
        db.prepare("SELECT organizations FROM skill").all(),
      ]),
    ).toBe(snapshot)
    expect(orgs(db)).toHaveLength(2)
  })
})

describe("the step that removes the channels from the agent lists (spec 030, 'Tools')", () => {
  const AFTER = migrations.findIndex((sql) => sql.includes("DROP COLUMN channels"))

  test("it comes after the step that makes the organizations", () => {
    expect(AFTER).toBeGreaterThan(STEP)
  })

  test("an old database: the organizations hold the tools first, then the channels leave the lists", () => {
    const db = before((d) => {
      for (const a of ["P", "D"]) agent(d, a)
      channel(d, "Product", { members: ["P"], lead: "P", created: 1 })
      channel(d, "Docs", { parent: "Product", members: ["P", "D"], created: 2 })
      d.exec(`
        INSERT INTO skill (id, server_id, name, name_key, instructions, agents, channels, enabled, created_at)
          VALUES ('sk', 's', 'Notes', 'notes', 'x', '["P"]', '["Docs","Product"]', 1, 1),
                 ('sk2', 's', 'Plain', 'plain', 'x', NULL, '[]', 1, 1);
        INSERT INTO tool_connection (id, server_id, name, name_key, kind, agents, channels, enabled, created_at)
          VALUES ('cn', 's', 'Wiki', 'wiki', 'program', '["P"]', '["Docs"]', 0, 1);
      `)
    })
    // Run the step that makes the organizations, and stop before the removal.
    migrateThrough(db, STEP)
    const list = (table: string, id: string) =>
      db.prepare(`SELECT organizations FROM ${table} WHERE id = ?`).get(id) as {
        organizations: string
      }
    // The tool of each channel is now the value "On" of its organization.
    expect(JSON.parse(list("skill", "sk").organizations)).toEqual([
      { id: "org-Docs", value: "on" },
      { id: "org-Product", value: "on" },
    ])
    expect(JSON.parse(list("tool_connection", "cn").organizations)).toEqual([
      { id: "org-Docs", value: "on" },
    ])
    expect(columns(db, "skill")).toContain("channels")

    migrate(db)

    expect(columns(db, "skill")).not.toContain("channels")
    expect(columns(db, "tool_connection")).not.toContain("channels")
    // The organizations keep their value, "All agents" stays as it was, and the rows stay.
    expect(JSON.parse(list("skill", "sk").organizations)).toHaveLength(2)
    expect(JSON.parse(list("tool_connection", "cn").organizations)).toHaveLength(1)
    expect(db.prepare("SELECT COUNT(*) AS n FROM skill").get()).toEqual({ n: 2 })
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: migrations.length })
  })
})
