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
      return sse(check)
    }
    if (content.includes("All parts have ended")) return sse("Summary done.")
    if (system.includes("Read the job of the user")) return sse(plan)
    if (last.includes("LONGREPLY")) return sse(LONG)
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

describe("the export against a real run of the app", () => {
  test("the check text of the replay equals the check text that the lead really got", async () => {
    seen.length = 0
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
    expect(summary).toMatchObject({ found: 2, written: 2, jobs: 1 })
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
})
