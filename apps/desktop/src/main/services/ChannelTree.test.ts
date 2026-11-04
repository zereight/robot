import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { OrgChart } from "./OrgChart.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

// The parent channel of a channel (spec 030, "Channel tree"): the server keeps the rules of the
// tree for each change, from the settings, from the chart and from a linked computer. A removed
// parent clears the field, and the chart draws the tree.

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

  test("the chart draws the tree: a sub-channel under its parent, in the order of the page", async () => {
    const s = await setup()
    const [ada, bo, cy] = [await s.agent("Ada"), await s.agent("Bo"), await s.agent("Cy")]
    // "Product" has no member, but a sub-channel with a member: it has a channel node.
    const product = await s.channel("Product", [])
    const docs = await s.channel("Docs", [ada.id, bo.id], product.id)
    const site = await s.channel("Site", [cy.id], docs.id)
    const art = await s.channel("Art", [cy.id])
    const model = await s.run(OrgChart.use((o) => o.model()))
    expect(model.channels.map((c) => [c.name, c.parentKey, c.level])).toEqual([
      ["Art", null, 1],
      ["Product", null, 1],
      ["Docs", `c:${product.id}`, 2],
      ["Site", `c:${docs.id}`, 3],
    ])
    const structure = model.lines.filter((l) => l.kind === "structure").map((l) => l.id)
    expect(structure).toContain(`s:root>c:${art.id}`)
    expect(structure).toContain(`s:root>c:${product.id}`)
    expect(structure).toContain(`s:c:${product.id}>c:${docs.id}`)
    expect(structure).toContain(`s:c:${docs.id}>c:${site.id}`)
    // The root has no line to a sub-channel.
    expect(structure).not.toContain(`s:root>c:${docs.id}`)
  })
})
