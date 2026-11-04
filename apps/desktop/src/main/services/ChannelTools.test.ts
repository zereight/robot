import { describe, expect, test } from "bun:test"
import type { ToolConnectionInput } from "@robot/shared"
import { Effect } from "effect"
import type { McpOpener, McpTool } from "../connections/mcp.ts"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { ChannelTools } from "./ChannelTools.ts"
import { Connections } from "./Connections.ts"
import { Database } from "./Database.ts"
import { Servers } from "./Servers.ts"
import { Skills } from "./Skills.ts"
import { testRuntime } from "./testing.ts"

// The tools of a channel (spec 030, "Channel tools"): the switch is the list of the skill or the
// connection, a member and the members of its lower channels have the tool in every turn, a member
// that leaves loses it, and the profile lists it with the channel it comes from.

const tool = (name: string): McpTool => ({
  name,
  description: `The tool ${name}.`,
  readOnly: false,
  schema: { type: "object", properties: {} },
})
const open: McpOpener = async () => ({
  closed: new Promise<void>(() => {}),
  close: () => {},
  listTools: async () => ({ tools: [tool("echo")], more: false }),
  call: async () => ({ text: "ok", isError: false }),
})

const connectionForm = (over: Partial<ToolConnectionInput> = {}): ToolConnectionInput => ({
  name: "Notes",
  kind: "program",
  command: "notes-server",
  args: [],
  folder: "",
  env: [],
  address: "",
  headers: [],
  agents: "all",
  ...over,
})

const setup = async () => {
  const t = testRuntime({ connections: { open } })
  const run = t.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const agent = (name: string) =>
    run(Agents.use((a) => a.create({ serverId: local.id, name, role: "", instructions: "" })))
  const channel = (name: string, memberIds: string[], parentId?: string | null) =>
    run(
      Channels.use((c) =>
        c.create({
          serverId: local.id,
          name,
          topic: "",
          memberIds,
          leadId: null,
          ...(parentId !== undefined ? { parentId } : {}),
        }),
      ),
    )
  // A tool needs an agent or a channel in its list (spec 017, 018). A tool of these tests starts
  // with an owner, who is in no channel, so that a switch of a channel is the only change.
  const owner = await agent("Owner")
  const skill = (name: string, agentIds: readonly string[] | null = [owner.id]) =>
    run(
      Skills.use((s) =>
        s.create(local.id, { name, description: "", instructions: "Do the work." }, agentIds),
      ),
    )
  const skillsOf = (agentId: string) =>
    run(Skills.use((s) => s.forAgent(agentId))).then((list) => list.map((x) => x.name))
  const connection = async (name: string, agents: "all" | string[] = [owner.id]) => {
    const form = connectionForm({ name, agents })
    await run(Connections.use((c) => c.test({ connection: form })))
    return await run(Connections.use((c) => c.save({ connection: form, confirmed: true })))
  }
  const connectionsOf = async (agentId: string) => {
    const turn = await run(Connections.use((c) => c.forTurn(agentId)))
    return turn.defs().map((d) => d.name)
  }
  const rows = (channelId: string) => run(ChannelTools.use((c) => c.forChannel(channelId)))
  const set = (channelId: string, kind: "skill" | "connection", id: string, on: boolean) =>
    run(ChannelTools.use((c) => c.set(channelId, kind, id, on)))
  const profile = (agentId: string) => run(ChannelTools.use((c) => c.forAgent(agentId)))
  const setMembers = (id: string, memberIds: string[]) =>
    run(Channels.use((c) => c.update(id, { memberIds })))
  /** Puts an agent on a vendor runtime (spec 006): its account is of a kind that a program serves. */
  const onRuntime = (agentId: string) =>
    run(
      Database.use((d) =>
        Effect.sync(() => {
          d.run(
            "INSERT INTO provider_account (id, kind, name, base_url, created_at) VALUES ('rt', 'claude_code', 'Claude Code', '', 1)",
          )
          d.run("UPDATE agent SET model_account_id = 'rt' WHERE id = ?", agentId)
        }),
      ),
    )
  return {
    ...t,
    run,
    local,
    owner,
    agent,
    channel,
    skill,
    skillsOf,
    connection,
    connectionsOf,
    rows,
    set,
    profile,
    setMembers,
    onRuntime,
  }
}

describe("the part Tools of this channel", () => {
  test("it lists each skill and connection with a switch, and the switch is the list of the tool", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const product = await s.channel("Product", [ada.id])
    const notes = await s.skill("Release notes")
    await s.connection("Notes")

    const first = await s.rows(product.id)
    expect(first.map((r) => [r.kind, r.name, r.on, r.all])).toEqual([
      ["skill", "Release notes", false, false],
      ["connection", "Notes", false, false],
    ])

    const after = await s.set(product.id, "skill", notes.id, true)
    expect(after.find((r) => r.kind === "skill")?.on).toBe(true)
    // The skill form reads the same fact: its list holds the channel.
    const stored = (await s.run(Skills.use((x) => x.list(s.local.id)))).find(
      (x) => x.id === notes.id,
    )
    expect(stored?.channelIds).toEqual([product.id])
    expect(stored?.agentIds).toEqual([s.owner.id])

    // Off again, and a repeat of a switch changes nothing.
    await s.set(product.id, "skill", notes.id, false)
    await s.set(product.id, "skill", notes.id, false)
    expect(
      (await s.run(Skills.use((x) => x.list(s.local.id)))).find((x) => x.id === notes.id)
        ?.channelIds,
    ).toEqual([])
  })

  test("a tool for all agents shows on and stays as it is", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const product = await s.channel("Product", [ada.id])
    const everyone = await s.skill("Everyone", null)
    const rows = await s.rows(product.id)
    expect(rows).toMatchObject([{ name: "Everyone", on: true, all: true }])
    const same = await s.set(product.id, "skill", everyone.id, false)
    expect(same).toMatchObject([{ name: "Everyone", on: true, all: true }])
    const stored = (await s.run(Skills.use((x) => x.list(s.local.id)))).find(
      (x) => x.id === everyone.id,
    )
    expect(stored?.agentIds).toBeNull()
    expect(stored?.channelIds).toEqual([])
  })

  test("a switch keeps the agents of the list, and a channel of another server is no channel", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.channel("Product", [ada.id])
    const notes = await s.skill("Release notes", [bo.id])
    await s.set(product.id, "skill", notes.id, true)
    const stored = (await s.run(Skills.use((x) => x.list(s.local.id)))).find(
      (x) => x.id === notes.id,
    )
    expect(stored?.agentIds).toEqual([bo.id])
    expect(stored?.channelIds).toEqual([product.id])

    const lost = await s.run(ChannelTools.use((c) => c.set("nope", "skill", notes.id, true))).then(
      () => "ok",
      (e) => (e as { code: string }).code,
    )
    expect(lost).toBe("channel_not_found")
  })
})

describe("who has a tool of a channel", () => {
  test("a member of Site has the skill that Product gives, and so has a member of Product", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const cy = await s.agent("Cy")
    const product = await s.channel("Product", [ada.id])
    const docs = await s.channel("Docs", [], product.id)
    await s.channel("Site", [bo.id], docs.id)
    const notes = await s.skill("Release notes")

    // Before the switch nobody has it.
    expect(await s.skillsOf(ada.id)).toEqual([])
    expect(await s.skillsOf(bo.id)).toEqual([])

    await s.set(product.id, "skill", notes.id, true)
    expect(await s.skillsOf(ada.id)).toEqual(["Release notes"])
    expect(await s.skillsOf(bo.id)).toEqual(["Release notes"])
    // An agent in no channel of the tree does not have it.
    expect(await s.skillsOf(cy.id)).toEqual([])

    // The tool is usable in a turn, and an agent outside the tree is refused.
    await s.run(Skills.use((x) => x.usable(bo.id, notes.id)))
    const refused = await s
      .run(Skills.use((x) => x.usable(cy.id, notes.id)).pipe(Effect.flip))
      .then((e) => e.code)
    expect(refused).toBe("skill_unavailable")
  })

  test("a tool of a lower channel does not go up to a higher channel", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.channel("Product", [ada.id])
    const docs = await s.channel("Docs", [bo.id], product.id)
    const notes = await s.skill("Release notes")
    await s.set(docs.id, "skill", notes.id, true)
    expect(await s.skillsOf(bo.id)).toEqual(["Release notes"])
    expect(await s.skillsOf(ada.id)).toEqual([])
  })

  test("a skill that is off is not given, and a connection that a channel gives is in the turn", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.channel("Product", [ada.id])
    const notes = await s.skill("Release notes")
    await s.set(product.id, "skill", notes.id, true)
    await s.run(Skills.use((x) => x.setEnabled(notes.id, false)))
    expect(await s.skillsOf(ada.id)).toEqual([])
    expect(await s.profile(ada.id)).toEqual([])

    const conn = await s.connection("Notes")
    expect(await s.connectionsOf(ada.id)).toEqual([])
    await s.set(product.id, "connection", conn.id, true)
    const names = await s.connectionsOf(ada.id)
    expect(names).toHaveLength(1)
    expect(names[0]).toContain("echo")
    // Bo is in no channel, so the connection is not in the turn of Bo.
    expect(await s.connectionsOf(bo.id)).toEqual([])
  })

  test("the change counts from the next turn: a read before the change keeps its result", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const product = await s.channel("Product", [ada.id])
    const notes = await s.skill("Release notes")
    const before = await s.run(Skills.use((x) => x.forAgent(ada.id)))
    await s.set(product.id, "skill", notes.id, true)
    // The list that a turn started with is a value: the change does not edit it.
    expect(before).toEqual([])
    expect((await s.run(Skills.use((x) => x.forAgent(ada.id)))).map((x) => x.name)).toEqual([
      "Release notes",
    ])
  })

  test("an agent that leaves the channel loses its tools from the next turn", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.channel("Product", [ada.id])
    const site = await s.channel("Site", [bo.id], product.id)
    const notes = await s.skill("Release notes")
    const conn = await s.connection("Notes")
    await s.set(product.id, "skill", notes.id, true)
    await s.set(product.id, "connection", conn.id, true)
    expect(await s.skillsOf(bo.id)).toEqual(["Release notes"])
    expect(await s.connectionsOf(bo.id)).toHaveLength(1)

    await s.setMembers(site.id, [])
    expect(await s.skillsOf(bo.id)).toEqual([])
    expect(await s.connectionsOf(bo.id)).toEqual([])
    expect(await s.profile(bo.id)).toEqual([])
    // Ada is still a member of Product, so she keeps them.
    expect(await s.skillsOf(ada.id)).toEqual(["Release notes"])
  })

  test("a tool in the list of the agent and of a channel is one tool, with both ways in", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const product = await s.channel("Product", [ada.id])
    const notes = await s.skill("Release notes", [ada.id])
    await s.set(product.id, "skill", notes.id, true)
    expect(await s.skillsOf(ada.id)).toEqual(["Release notes"])
    // Leaving the channel keeps the skill: the list still names the agent.
    await s.setMembers(product.id, [])
    expect(await s.skillsOf(ada.id)).toEqual(["Release notes"])
  })
})

describe("the profile of the agent: From <channel>", () => {
  test("it lists each tool that comes from a channel, with the channel that gives it", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const bo = await s.agent("Bo")
    const product = await s.channel("Product", [ada.id])
    const site = await s.channel("Site", [bo.id], product.id)
    const notes = await s.skill("Release notes")
    const conn = await s.connection("Notes")
    const own = await s.skill("Own", [bo.id])
    await s.set(product.id, "skill", notes.id, true)
    await s.set(site.id, "connection", conn.id, true)

    const lines = await s.profile(bo.id)
    expect(lines.map((l) => [l.kind, l.name, l.channels.map((c) => c.name)])).toEqual([
      ["skill", "Release notes", ["Product"]],
      ["connection", "Notes", ["Site"]],
    ])
    // A skill of the own list is not from a channel.
    expect(lines.some((l) => l.id === own.id)).toBe(false)
    // Ada is in Product only, so she has the skill and not the connection.
    expect((await s.profile(ada.id)).map((l) => l.name)).toEqual(["Release notes"])
  })

  test("an agent on a vendor runtime gets the skills of a channel as 017 says, and no connection, as 018 says", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const product = await s.channel("Product", [ada.id])
    const notes = await s.skill("Release notes")
    const conn = await s.connection("Notes")
    await s.set(product.id, "skill", notes.id, true)
    await s.set(product.id, "connection", conn.id, true)
    expect((await s.profile(ada.id)).map((l) => l.name)).toEqual(["Release notes", "Notes"])

    await s.onRuntime(ada.id)
    // The message that uses a skill carries its instructions, so a runtime gets the skill. A
    // connection reaches only the agents that use the tools of the app: the line leaves with it.
    expect(await s.skillsOf(ada.id)).toEqual(["Release notes"])
    expect((await s.profile(ada.id)).map((l) => l.name)).toEqual(["Release notes"])
  })

  test("an agent in no channel has no line", async () => {
    const s = await setup()
    const cy = await s.agent("Cy")
    const notes = await s.skill("Everyone", null)
    expect(notes.enabled).toBe(true)
    expect(await s.profile(cy.id)).toEqual([])
  })
})
