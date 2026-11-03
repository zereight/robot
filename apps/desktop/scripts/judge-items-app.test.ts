import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Agents } from "../src/main/services/Agents.ts"
import { Channels } from "../src/main/services/Channels.ts"
import { Database } from "../src/main/services/Database.ts"
import { Providers } from "../src/main/services/Providers.ts"
import { Servers } from "../src/main/services/Servers.ts"
import { Tasks } from "../src/main/services/Tasks.ts"
import { Effect, testRuntime } from "../src/main/services/testing.ts"
import { exportItems, itemsToJsonl } from "./judge-items-lib.ts"
import { callsFor, parseItems } from "./judge-replay-lib.ts"

// The strongest check of the export: a real channel job runs through the real services of the app
// with a stand-in model, the lead gets a check text, and the database of that run is copied. The
// items that the export makes from the copy must give, through the replay, the SAME instruction
// text and the SAME state text that the lead really got. All data is made for this test.

const temp = mkdtempSync(join(tmpdir(), "judge-items-app-"))
afterAll(() => rmSync(temp, { recursive: true, force: true }))

const sse = (text: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const enc = new TextEncoder()
        const send = (data: unknown) =>
          controller.enqueue(
            enc.encode(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`),
          )
        send({ choices: [{ delta: { content: text } }] })
        send({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } })
        send("[DONE]")
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

const LONG = `START-${"z".repeat(1800)}-END`
const seen: { system: string; content: string }[] = []
let plan = ""
let check = ""
/** The answers of the next checks, one for each check. When it is empty, `check` answers. */
const checks: string[] = []
/** The member that gets this word in its instruction answers late (see the nudge test). */
const SLOW = "SLOWNUDGE"
const SLOW_MS = 1200

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    const body = (await req.json()) as { messages: { role: string; content: string }[] }
    const system = body.messages.find((m) => m.role === "system")?.content ?? ""
    const content = body.messages.at(-1)?.content ?? ""
    const last = content.split("\n").at(-1) ?? ""
    if (system.includes("The work in the channel has stopped")) {
      seen.push({ system, content })
      return sse(checks.shift() ?? check)
    }
    if (content.includes("All parts have ended")) return sse("Summary done.")
    if (system.includes("Read the job of the user")) return sse(plan)
    if (last.includes("LONGREPLY")) return sse(LONG)
    if (last.includes(SLOW)) await Bun.sleep(SLOW_MS)
    return sse(`Echo: ${last}`)
  },
})
afterAll(() => server.stop())

const until = async (check: () => Promise<boolean> | boolean, ms = 20000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error("timed out")
}

/** A channel Launch with the lead Lia, and the members Bo and Cy, on a made account. */
const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-items-test-key",
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const made = await Promise.all(
    [
      ["Lia", "Leads the launch"],
      ["Bo", "Writes text"],
      ["Cy", "Checks facts"],
    ].map(([name, role]) =>
      run(
        Agents.use((a) =>
          a.create({
            serverId: local.id,
            name: name ?? "",
            role: role ?? "",
            instructions: `You are ${name}.`,
            model: { accountId: account.id, model: "mock", effort: null },
          }),
        ),
      ),
    ),
  )
  const channel = await run(
    Channels.use((c) =>
      c.create({
        serverId: local.id,
        name: "Launch",
        topic: "Ship the launch",
        memberIds: made.map((m) => m.id),
        leadId: made[0]?.id ?? "",
      }),
    ),
  )
  return { run, local, channel }
}

describe("the export against a real run of the app", () => {
  test("the check text of the replay equals the check text that the lead really got", async () => {
    seen.length = 0
    checks.length = 0
    plan = JSON.stringify({
      plan: "Split in parts",
      parts: [
        { member: "Bo", label: "Intro", prompt: "Write the intro", doneTest: "Holds a title" },
        {
          member: "Bo",
          label: "Facts",
          prompt: "List the facts LONGREPLY",
          doneTest: "Lists five facts",
        },
      ],
    })
    check = JSON.stringify({
      verdicts: [
        { part: 1, verdict: "met" },
        { part: 2, verdict: "not_met", reason: "SECRET-REASON only two facts" },
      ],
      action: "nothing",
    })
    const { run, local, channel } = await setup()
    await run(Channels.use((c) => c.send(channel.id, "split it")))
    // The check ran, both verdicts are saved, and the job has ended (the summary is written).
    await until(() => seen.length >= 1)
    await until(async () => {
      const all = await run(Tasks.use((x) => x.list(local.id)))
      const parts = all.filter((x) => x.parentId !== null)
      const job = all.find((x) => x.parentId === null && x.source === "channel")
      return parts.length === 2 && parts.every((p) => p.verdict !== null) && job?.state === "done"
    })
    expect(seen).toHaveLength(1)

    // The copy: a clean file with the data of the run.
    const copy = join(temp, "copy.db")
    await run(Database.use((db) => Effect.sync(() => db.run("VACUUM INTO ?", copy))))

    const { items, summary } = exportItems(copy, { since: null, limit: null })
    expect(summary).toMatchObject({
      found: 2,
      written: 2,
      jobs: 1,
      checkGroups: 1,
      unjudgedGroups: 0,
    })
    // One check judged both parts: one group.
    expect(items.map((i) => i.group)).toEqual(["check-0001", "check-0001"])
    // The verdict and its reason are in the database, and never in the items.
    expect(itemsToJsonl(items)).not.toContain("SECRET-REASON")
    expect(itemsToJsonl(items)).not.toMatch(/not_met|verdict/)
    // The full reply is written, also past 1500 characters.
    expect(items.map((i) => i.reply)).toEqual(["Echo: Write the intro", LONG])

    const labeled = items.map((item) => JSON.stringify({ ...item, human: "pass" })).join("\n")
    const parsed = parseItems(labeled)
    expect(parsed.problems).toEqual([])
    const [call] = callsFor("v1", parsed.items, 0, () => true)
    expect(call?.system).toBe(seen[0]?.system as string)
    expect(call?.user).toBe(seen[0]?.content as string)
  }, 60_000)

  test("a job with one nudge gives two check groups, and the replay builds a call for each", async () => {
    seen.length = 0
    checks.length = 0
    plan = JSON.stringify({
      plan: "Split in parts",
      parts: [
        { member: "Bo", label: "Intro", prompt: "Write the intro", doneTest: "Holds a title" },
        { member: "Cy", label: "Facts", prompt: "List the facts", doneTest: "Lists five facts" },
      ],
    })
    // The first check judges both parts and nudges part 2. The nudge starts part 3, and the
    // second check judges part 3 alone. The nudged member answers late, so that the two checks are
    // far apart in time, as they are in real use.
    checks.push(
      JSON.stringify({
        verdicts: [
          { part: 1, verdict: "met" },
          { part: 2, verdict: "not_met", reason: "SECRET-REASON only two facts" },
        ],
        action: "nudge",
        part: 2,
        instruction: `Finish the list of five facts. ${SLOW}`,
      }),
      JSON.stringify({ verdicts: [{ part: 3, verdict: "met" }], action: "nothing" }),
    )
    const { run, local, channel } = await setup()
    await run(Channels.use((c) => c.send(channel.id, "split it")))
    await until(() => seen.length >= 2)
    await until(async () => {
      const all = await run(Tasks.use((x) => x.list(local.id)))
      const parts = all.filter((x) => x.parentId !== null)
      const job = all.find((x) => x.parentId === null && x.source === "channel")
      return parts.length === 3 && parts.every((p) => p.verdict !== null) && job?.state === "done"
    })
    expect(seen).toHaveLength(2)

    const copy = join(temp, "nudged.db")
    await run(Database.use((db) => Effect.sync(() => db.run("VACUUM INTO ?", copy))))

    // A gap between the two checks of the run (about 1.2 seconds) and the loop of verdicts of one
    // check (a few milliseconds): 0.6 seconds separates them.
    const options = { since: null, limit: null, gapSeconds: 0.6 }
    const { items, summary } = exportItems(copy, options)
    expect(summary).toMatchObject({ found: 3, written: 3, jobs: 1, checkGroups: 2 })
    expect(items.map((i) => [i.group, i.label])).toEqual([
      ["check-0001", "Intro"],
      ["check-0001", "Facts"],
      ["check-0002", "Facts"],
    ])
    expect(itemsToJsonl(items)).not.toContain("SECRET-REASON")
    // A gap larger than the time between the checks makes one group of the three parts.
    const wide = exportItems(copy, { ...options, gapSeconds: 60 })
    expect(wide.items.map((i) => i.group)).toEqual(["check-0001", "check-0001", "check-0001"])

    const labeled = items.map((item) => JSON.stringify({ ...item, human: "pass" })).join("\n")
    const parsed = parseItems(labeled)
    expect(parsed.problems).toEqual([])
    const calls = callsFor("v1", parsed.items, 0, () => true)
    expect(calls.map((c) => [c.group, c.reads.map((r) => r.id)])).toEqual([
      ["check-0001", ["real-0001", "real-0002"]],
      ["check-0002", ["real-0003"]],
    ])
    // Both calls have the instruction that the lead really got.
    expect(calls[0]?.system).toBe(seen[0]?.system as string)
    expect(calls[1]?.system).toBe(seen[1]?.system as string)
    // The first check: the same state text, byte for byte.
    expect(calls[0]?.user).toBe(seen[0]?.content as string)
    // The second check: the real text lists all three parts and judges "Part 3". The replay shows
    // the one part of its group as "Part 1". This is the known limit of the export.
    expect(seen[1]?.content).toContain("Part 3: Facts")
    expect(calls[1]?.user).toContain("Part 1: Facts")
    expect(calls[1]?.user).not.toContain("Part 3:")
    // The last messages of the second check are rebuilt from the data, and they equal the real ones.
    const lastMessages = (text: string) =>
      text.slice(text.indexOf("Last messages:"), text.indexOf("Parts to judge:"))
    expect(lastMessages(calls[1]?.user ?? "")).toBe(lastMessages(seen[1]?.content ?? ""))
    expect(lastMessages(calls[1]?.user ?? "")).toContain("Finish the list of five facts.")
  }, 60_000)
})
