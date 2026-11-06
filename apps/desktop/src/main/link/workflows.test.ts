import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  type Agent,
  buildTlaStarter,
  type RpcResult,
  type Workflow,
  type WorkflowInput,
  type WorkflowRun,
  type WorkflowRunDetail,
  workflowStarterText,
} from "@robot/shared"
import { Effect } from "effect"
import { runRequest } from "../rpc.ts"
import { Database } from "../services/Database.ts"
import { Devices } from "../services/Devices.ts"
import { Providers } from "../services/Providers.ts"
import { Remote } from "../services/Remote.ts"
import { testRuntime } from "../services/testing.ts"
import { pairRuntimes } from "./pairing.testing.ts"

/** Workflows of a server on a linked computer (spec 012, "Workflows"). */

type Rt = ReturnType<typeof testRuntime>

const model = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  fetch(req) {
    if (new URL(req.url).pathname === "/v1/models") {
      return Response.json({ data: [{ id: "model-b" }] })
    }
    return new Response("not found", { status: 404 })
  },
})

const sides: Rt[] = []
const side = (name: string) => {
  const s = testRuntime({ name })
  sides.push(s)
  return s
}

const waitFor = async <T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 8000) => {
  const end = Date.now() + ms
  let last = await read()
  while (!ok(last) && Date.now() < end) {
    await new Promise((r) => setTimeout(r, 40))
    last = await read()
  }
  return last
}

beforeAll(() => {
  process.env.ROBOT_LINK_ADDRESSES = "127.0.0.1"
  process.env.ROBOT_LINK_RETRY_MAX_MS = "300"
  process.env.ROBOT_LINK_NEARBY_WAIT_MS = "80"
})
afterAll(async () => {
  model.stop()
  for (const s of sides) await s.runtime.dispose()
  delete process.env.ROBOT_LINK_ADDRESSES
  delete process.env.ROBOT_LINK_RETRY_MAX_MS
  delete process.env.ROBOT_LINK_NEARBY_WAIT_MS
})

/** A server and a client that is paired with it. `canChange` is the switch of the Allow dialog. */
const pair = async (canChange: boolean) => {
  const server = side("MacBook 2")
  const client = side("MacBook 1")
  const { entry } = await pairRuntimes(server, client, { canChange })
  const serverId = entry.serverId
  const clientName = (
    await client.runtime.runPromise(Devices.use((d) => Effect.sync(() => d.self())))
  ).name
  /** A request of the client over the link, as the window of the client makes it. */
  const ask = (method: string, input: unknown): Promise<RpcResult<unknown>> =>
    client.runtime.runPromise(
      Remote.use((r) => Effect.promise(() => r.invoke(serverId, method, input))),
    )
  /** A request of the window of the server. */
  const onServer = (method: string, input: unknown) => runRequest(server.runtime, method, input)
  return { server, client, serverId, clientName, ask, onServer }
}

const value = <T>(result: RpcResult<unknown>) => {
  if (!result.ok) throw new Error(`request failed: ${result.error.code}`)
  return result.value as T
}
const codeOf = (result: RpcResult<unknown>) => (result.ok ? "ok" : result.error.code)

/** A workflow with one approval step: a run waits until someone answers it. */
const gated = (serverId: string, name = "Gate"): WorkflowInput => ({
  serverId,
  name,
  trigger: { kind: "manual" },
  steps: [{ id: "s1", kind: "approval", name: "Check", x: 0, y: 0, message: "Go?" }],
  edges: [],
})

const stepOf = (detail: WorkflowRunDetail) => detail.steps.find((s) => s.stepId === "s1")

describe("a linked device and the workflows of the server (spec 012)", () => {
  test("without the switch it sees, runs, answers and stops, but cannot change", async () => {
    const p = await pair(false)
    const made = value<Workflow>(await p.onServer("workflows.create", gated(p.serverId)))

    // It sees the list and the runs.
    const list = value<Workflow[]>(await p.ask("workflows.list", { serverId: p.serverId }))
    expect(list.map((w) => w.id)).toEqual([made.id])
    expect(value<WorkflowRun[]>(await p.ask("workflows.runs", { workflowId: made.id }))).toEqual([])

    // Every change gets "Not allowed", and nothing changes.
    expect(codeOf(await p.ask("workflows.create", gated(p.serverId, "New")))).toBe("change_off")
    expect(
      codeOf(await p.ask("workflows.update", { id: made.id, patch: { name: "Renamed" } })),
    ).toBe("change_off")
    expect(
      codeOf(await p.ask("workflows.update", { id: made.id, patch: { enabled: false } })),
    ).toBe("change_off")
    expect(codeOf(await p.ask("workflows.delete", { id: made.id }))).toBe("change_off")
    const after = value<Workflow[]>(await p.onServer("workflows.list", { serverId: p.serverId }))
    expect(after.map((w) => [w.name, w.enabled])).toEqual([["Gate", true]])

    // It runs the workflow. The run names the device on both computers.
    const run = value<WorkflowRun>(await p.ask("workflows.run", { id: made.id }))
    expect(run.startedBy).toBe(p.clientName)
    const here = value<WorkflowRun[]>(await p.onServer("workflows.runs", { workflowId: made.id }))
    expect(here[0]?.startedBy).toBe(p.clientName)

    // It answers the approval step. The step names the device.
    await waitFor(
      async () => value<WorkflowRunDetail>(await p.ask("workflows.runDetail", { runId: run.id })),
      (d) => stepOf(d)?.state === "waiting",
    )
    value(await p.ask("workflows.approve", { runId: run.id, stepId: "s1", approved: true }))
    const finished = await waitFor(
      async () =>
        value<WorkflowRunDetail>(await p.onServer("workflows.runDetail", { runId: run.id })),
      (d) => d.run.state === "done",
    )
    expect(finished.run.state).toBe("done")
    expect(stepOf(finished)?.decidedBy).toBe(p.clientName)

    // It stops a run.
    const second = value<WorkflowRun>(await p.ask("workflows.run", { id: made.id }))
    await waitFor(
      async () =>
        value<WorkflowRunDetail>(await p.ask("workflows.runDetail", { runId: second.id })),
      (d) => stepOf(d)?.state === "waiting",
    )
    value(await p.ask("workflows.stop", { runId: second.id }))
    const stopped = await waitFor(
      async () =>
        value<WorkflowRunDetail>(await p.onServer("workflows.runDetail", { runId: second.id })),
      (d) => d.run.state === "cancelled",
    )
    expect(stopped.run.state).toBe("cancelled")
  })

  test("a run and an answer from the window of the server name no device", async () => {
    const p = await pair(false)
    const made = value<Workflow>(await p.onServer("workflows.create", gated(p.serverId)))
    const run = value<WorkflowRun>(await p.onServer("workflows.run", { id: made.id }))
    expect(run.startedBy).toBeNull()
    await waitFor(
      async () =>
        value<WorkflowRunDetail>(await p.onServer("workflows.runDetail", { runId: run.id })),
      (d) => stepOf(d)?.state === "waiting",
    )
    value(await p.onServer("workflows.approve", { runId: run.id, stepId: "s1", approved: false }))
    const done = await waitFor(
      async () =>
        value<WorkflowRunDetail>(await p.onServer("workflows.runDetail", { runId: run.id })),
      (d) => d.run.state !== "running",
    )
    expect(stepOf(done)?.decidedBy).toBeNull()
    expect(stepOf(done)?.error).toBe("rejected")
  })

  test("with the switch it creates, edits, turns off and deletes, and the client hears of it", async () => {
    const p = await pair(true)
    const made = value<Workflow>(await p.ask("workflows.create", gated(p.serverId)))
    expect(made.enabled).toBe(true)
    const edited = value<Workflow>(
      await p.ask("workflows.update", {
        id: made.id,
        patch: {
          name: "Morning",
          steps: [
            ...made.steps,
            { id: "s2", kind: "notify", name: "Tell", x: 200, y: 0, title: "Done" },
          ],
          edges: [{ id: "e1", from: "s1", to: "s2" }],
          enabled: false,
        },
      }),
    )
    expect(edited.name).toBe("Morning")
    expect(edited.steps).toHaveLength(2)
    expect(edited.enabled).toBe(false)
    // The window of the server shows the change.
    const here = value<Workflow[]>(await p.onServer("workflows.list", { serverId: p.serverId }))
    expect(here[0]?.name).toBe("Morning")
    // The client hears that the workflows of the server changed.
    const heard = await waitFor(
      () => p.client.events.filter((e) => e.event === "workflows.changed"),
      (list) => list.some((e) => (e.payload as { serverId: string }).serverId === p.serverId),
    )
    expect(heard.length).toBeGreaterThan(0)

    // A workflow cannot change while it runs.
    value(await p.ask("workflows.update", { id: made.id, patch: { enabled: true } }))
    const run = value<WorkflowRun>(await p.ask("workflows.run", { id: made.id }))
    expect(codeOf(await p.ask("workflows.update", { id: made.id, patch: { name: "X" } }))).toBe(
      "workflow_running",
    )
    expect(codeOf(await p.ask("workflows.delete", { id: made.id }))).toBe("workflow_running")
    value(await p.ask("workflows.stop", { runId: run.id }))
    await waitFor(
      async () => value<Workflow[]>(await p.ask("workflows.list", { serverId: p.serverId })),
      (list) => list.every((w) => !w.running),
    )
    value(await p.ask("workflows.delete", { id: made.id }))
    expect(value<Workflow[]>(await p.onServer("workflows.list", { serverId: p.serverId }))).toEqual(
      [],
    )
  })

  test("a workflow from a starter is made over the link with the switch, in either language, and refused without it (spec 010)", async () => {
    /** The server gets one agent. The graph of the starter names it, in the language asked for. */
    const agentOf = async (p: Awaited<ReturnType<typeof pair>>) =>
      value<Agent>(
        await p.onServer("agents.create", {
          serverId: p.serverId,
          name: "Reviewer",
          role: "",
          instructions: "",
        }),
      )
    const make = (p: Awaited<ReturnType<typeof pair>>, agent: Agent, locale: "en" | "ko") => {
      const text = workflowStarterText(locale, "tla")
      return buildTlaStarter({ serverId: p.serverId, name: text.name, agentId: agent.id, text })
    }

    const on = await pair(true)
    const reviewer = await agentOf(on)
    for (const locale of ["en", "ko"] as const) {
      const input = make(on, reviewer, locale)
      const made = value<Workflow>(await on.ask("workflows.create", input))
      expect(made.name).toBe(input.name)
      expect(made.steps.map((s) => s.kind)).toEqual([
        "agent",
        "agent",
        "condition",
        "notify",
        "agent",
        "notify",
      ])
      expect(made.notes).toHaveLength(1)
      expect(made.trigger).toEqual({ kind: "manual" })
    }
    // The server holds both, and they are its own workflows.
    const here = value<Workflow[]>(await on.onServer("workflows.list", { serverId: on.serverId }))
    expect(here).toHaveLength(2)

    const off = await pair(false)
    const refused = make(off, await agentOf(off), "en")
    expect(codeOf(await off.ask("workflows.create", refused))).toBe("change_off")
    expect(
      value<Workflow[]>(await off.onServer("workflows.list", { serverId: off.serverId })),
    ).toEqual([])
  })

  test("a change may only name agents and model accounts of the server", async () => {
    const p = await pair(true)
    const agent = value<Agent>(
      await p.onServer("agents.create", {
        serverId: p.serverId,
        name: "Ada",
        role: "",
        instructions: "",
      }),
    )
    const account = await p.server.runtime.runPromise(
      Providers.use((x) =>
        x.connect({
          kind: "openai",
          name: "Work",
          baseUrl: `http://127.0.0.1:${model.port}/v1`,
          apiKey: "SECRET-KEY-OF-SERVER",
        }),
      ),
    )
    const withStep = (step: object) => ({ ...gated(p.serverId), steps: [step] })
    const agentStep = (agentId: string) => ({
      id: "a1",
      kind: "agent",
      name: "Write",
      x: 0,
      y: 0,
      agentId,
      prompt: "{{input}}",
      continueOnFailure: false,
    })
    const ask = (accountId: string, name: string) => ({
      id: "c1",
      kind: "condition",
      name: "Ask",
      x: 0,
      y: 0,
      contains: "Is it good?",
      mode: "ask",
      provider: { accountId, model: name },
    })

    expect(codeOf(await p.ask("workflows.create", withStep(agentStep(agent.id))))).toBe("ok")
    expect(codeOf(await p.ask("workflows.create", withStep(agentStep("nobody"))))).toBe(
      "agent_not_found",
    )
    expect(codeOf(await p.ask("workflows.create", withStep(ask(account.id, "model-b"))))).toBe("ok")
    expect(codeOf(await p.ask("workflows.create", withStep(ask(account.id, "nope"))))).toBe(
      "model_not_found",
    )
    expect(codeOf(await p.ask("workflows.create", withStep(ask("other", "model-b"))))).toBe(
      "model_not_found",
    )

    // A field that the schema does not know, or another server, is refused.
    expect(
      codeOf(await p.ask("workflows.create", { ...gated(p.serverId), runsOn: "elsewhere" })),
    ).toBe("invalid_input")
    expect(codeOf(await p.ask("workflows.create", gated("another-server")))).toBe("invalid_input")
    expect(codeOf(await p.ask("workflows.list", { serverId: "another-server" }))).toBe(
      "invalid_input",
    )

    // No key of the server reaches the client.
    const list = await p.ask("workflows.list", { serverId: p.serverId })
    expect(JSON.stringify(list)).not.toContain("SECRET-KEY-OF-SERVER")
  })

  test("a workflow that runs on another computer through sync does not run from a client", async () => {
    const p = await pair(true)
    const made = value<Workflow>(await p.onServer("workflows.create", gated(p.serverId)))
    await p.server.runtime.runPromise(
      Database.use((db) =>
        Effect.sync(() => db.run("UPDATE workflow SET runs_on = 'pc-3' WHERE id = ?", made.id)),
      ),
    )
    const list = value<Workflow[]>(await p.ask("workflows.list", { serverId: p.serverId }))
    expect(list[0]?.runsOn).not.toBeNull()
    expect(codeOf(await p.ask("workflows.run", { id: made.id }))).toBe("workflow_elsewhere")
    // "Run on this computer" is not offered to a client.
    expect(codeOf(await p.ask("workflows.runHere", { id: made.id }))).toBe("not_allowed")
  })
})
