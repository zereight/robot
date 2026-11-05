import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { OrgChart } from "./OrgChart.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

// The parent channel of a channel (spec 030, "Channel tree"): the server keeps the rules of the
// tree for each change, from the settings and from a linked computer. A removed
// parent clears the field. The chart draws no channel (029).

const setup = async () => {
  const t = testRuntime({ name: "This Mac" })
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
  const setParent = (id: string, parentId: string | null) =>
    run(Channels.use((c) => c.update(id, { parentId })))
  const codeOf = (id: string, parentId: string | null) =>
    run(
      Channels.use((c) => c.update(id, { parentId })).pipe(
        Effect.match({ onFailure: (e) => (e as { code?: string }).code, onSuccess: () => "ok" }),
      ),
    )
  const get = (id: string) => run(Channels.use((c) => c.get(id)))
  return { run, local, agent, channel, setParent, codeOf, get }
}

describe("the parent channel", () => {
  test("Product > Docs > Site: the rules of the tree hold for each change", async () => {
    const s = await setup()
    const ada = await s.agent("Ada")
    const product = await s.channel("Product", [ada.id])
    const docs = await s.channel("Docs", [ada.id])
    const site = await s.channel("Site", [ada.id], null)
    expect(docs.parentId).toBeNull()
    expect((await s.setParent(docs.id, product.id)).parentId).toBe(product.id)
    await s.setParent(site.id, docs.id)

    // A loop, also its own parent, and a fourth level are refused; nothing changes.
    expect(await s.codeOf(product.id, docs.id)).toBe("parent_loop")
    expect(await s.codeOf(product.id, site.id)).toBe("parent_loop")
    expect(await s.codeOf(docs.id, docs.id)).toBe("parent_loop")
    expect(await s.codeOf(product.id, "nope")).toBe("parent_not_found")
    const run = s.run
    const fourth = await run(
      Channels.use((c) =>
        c.create({
          serverId: s.local.id,
          name: "Deep",
          topic: "",
          memberIds: [],
          leadId: null,
          parentId: site.id,
        }),
      ).pipe(
        Effect.match({ onFailure: (e) => (e as { code?: string }).code, onSuccess: () => "ok" }),
      ),
    )
    expect(fourth).toBe("parent_levels")
    expect((await s.get(product.id)).parentId).toBeNull()

    // A change of another field keeps the parent. "None" makes a top channel again.
    const renamed = await run(Channels.use((c) => c.update(site.id, { topic: "Pages" })))
    expect(renamed.parentId).toBe(docs.id)
    expect((await s.setParent(site.id, null)).parentId).toBeNull()
  })

  test("a removed parent clears the field of its sub-channels", async () => {
    const s = await setup()
    const product = await s.channel("Product", [])
    const docs = await s.channel("Docs", [], product.id)
    expect(docs.parentId).toBe(product.id)
    await s.run(Channels.use((c) => c.remove(product.id)))
    expect((await s.get(docs.id)).parentId).toBeNull()
  })

  test("the chart draws no channel, also a channel with a parent (spec 029, 031)", async () => {
    const s = await setup()
    const [ada, bo, cy] = [await s.agent("Ada"), await s.agent("Bo"), await s.agent("Cy")]
    const product = await s.channel("Product", [])
    const docs = await s.channel("Docs", [ada.id, bo.id], product.id)
    await s.channel("Site", [cy.id], docs.id)
    const model = await s.run(OrgChart.use((o) => o.model()))
    // Only the node "No organization" holds the three agents: no node for a channel.
    expect(model.orgs.map((o) => [o.key, o.memberCount])).toEqual([["o:none", 3]])
    expect(JSON.stringify(model)).not.toContain("Product")
  })
})
