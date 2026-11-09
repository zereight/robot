import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Workflow } from "@robot/shared"
import { CLIENT_METHODS } from "@robot/shared"
import { Effect, Layer } from "effect"
import { handlers, runRequest } from "./rpc.ts"
import { Database } from "./services/Database.ts"
import { gitEnv } from "./services/GitWorktrees.ts"
import { Secrets } from "./services/Secrets.ts"
import { Servers } from "./services/Servers.ts"
import { testRuntime } from "./services/testing.ts"

/** A server with two linked devices: one that may change workflows, and one that may not. */
const setup = async () => {
  const t = testRuntime()
  const server = await t.runtime.runPromise(Servers.use((s) => s.local))
  await t.runtime.runPromise(
    Database.use((db) =>
      Effect.sync(() => {
        for (const [id, canChange, position] of [
          ["may", 1, 0],
          ["may-not", 0, 1],
        ] as const)
          db.run(
            "INSERT INTO device_link (id, name, kind, public_key, inbound, position, created_at, can_change) VALUES (?, ?, 'phone', '', 1, ?, 0, ?)",
            id,
            id,
            position,
            canChange,
          )
      }),
    ),
  )
  const ask = (method: string, input: unknown, device?: string) =>
    runRequest(t.runtime, method, input, device ? { id: device, name: device } : null)
  return { ...t, server, ask }
}

describe("a linked device and the switch for workflows (spec 010, 012)", () => {
  test("a device without the switch cannot create a workflow, and nothing is made", async () => {
    const t = await setup()
    const result = await t.ask(
      "workflows.create",
      { serverId: t.server.id, name: "Report" },
      "may-not",
    )
    expect(result).toMatchObject({ ok: false, error: { code: "change_off" } })
    const list = await t.ask("workflows.list", { serverId: t.server.id }, "may-not")
    expect(list).toEqual({ ok: true, value: [] })
  })

  test("a device with the switch creates and deletes a workflow", async () => {
    const t = await setup()
    const created = await t.ask(
      "workflows.create",
      { serverId: t.server.id, name: "Report" },
      "may",
    )
    expect(created.ok).toBe(true)
    const id = (created as { value: Workflow }).value.id
    expect(await t.ask("workflows.delete", { id }, "may")).toMatchObject({ ok: true })
    expect(await t.ask("workflows.list", { serverId: t.server.id }, "may")).toEqual({
      ok: true,
      value: [],
    })
  })

  test("a device without the switch cannot delete a workflow, and it stays", async () => {
    const t = await setup()
    const created = await t.ask("workflows.create", { serverId: t.server.id, name: "Report" })
    const id = (created as { value: Workflow }).value.id
    expect(await t.ask("workflows.delete", { id }, "may-not")).toMatchObject({
      ok: false,
      error: { code: "change_off" },
    })
    const list = await t.ask("workflows.list", { serverId: t.server.id }, "may-not")
    expect((list as { value: Workflow[] }).value).toHaveLength(1)
  })

  test("a device that is not linked is refused, and the window needs no switch", async () => {
    const t = await setup()
    const unknown = await t.ask("workflows.create", { serverId: t.server.id, name: "A" }, "ghost")
    expect(unknown).toMatchObject({ ok: false, error: { code: "change_off" } })
    const window = await t.ask("workflows.create", { serverId: t.server.id, name: "B" })
    expect(window.ok).toBe(true)
  })

  test("a method that the link does not list is refused for a device", async () => {
    const t = await setup()
    const result = await t.ask("workflows.rename", { id: "x", name: "Y" }, "may")
    expect(result).toMatchObject({ ok: false, error: { code: "not_allowed" } })
  })
})

describe("the requests of a linked device (spec 012)", () => {
  test("every request on the list has a handler", () => {
    for (const method of CLIENT_METHODS) expect(Object.keys(handlers), method).toContain(method)
  })

  test("a request that is not on the list is refused with no change", async () => {
    const t = await setup()
    for (const method of ["workflows.update", "workflows.run", "tools.respond", "agents.list"])
      expect(await t.ask(method, {}, "may")).toMatchObject({
        ok: false,
        error: { code: "not_allowed" },
      })
    // The marks of a chat are cleared by the user on this computer only (spec 007, 012).
    expect(await t.ask("chat.clearMarks", { workflowId: "x" }, "may")).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    })
    // Compact starts on this computer only: a linked device sees the result (spec 003, 012).
    expect(CLIENT_METHODS as readonly string[]).not.toContain("chat.compact")
    expect(await t.ask("chat.compact", { workflowId: "x" }, "may")).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    })
  })

  test("the vault is for this computer only: a linked device is refused", async () => {
    const t = await setup()
    // A linked device shows the vault as one muted line, and never takes or sends a value
    // (spec 020, V1). None of the vault methods is a client method.
    for (const method of [
      "secrets.list",
      "secrets.add",
      "secrets.rename",
      "secrets.test",
      "secrets.replace",
      "secrets.delete",
      "logins.list",
      "logins.add",
      "logins.rename",
      "logins.replace",
      "logins.delete",
    ])
      expect(await t.ask(method, {}, "may")).toMatchObject({
        ok: false,
        error: { code: "not_allowed" },
      })
  })

  test("a device without the switch can run, see and stop a run, and answer cards", async () => {
    const t = await setup()
    const created = await t.ask("workflows.create", { serverId: t.server.id, name: "Report" })
    const id = (created as { value: Workflow }).value.id
    // A workflow with no node does not start: the answer is the error of the run, not "change_off".
    expect(await t.ask("runs.start", { workflowId: id }, "may-not")).toMatchObject({
      ok: false,
      error: { code: "run_empty" },
    })
    expect(await t.ask("runs.list", { workflowId: id }, "may-not")).toEqual({ ok: true, value: [] })
    expect(await t.ask("runs.stop", { runId: "none" }, "may-not")).toMatchObject({
      ok: false,
      error: { code: "run_not_found" },
    })
    expect(
      await t.ask(
        "cards.answer",
        { cardId: "none", answer: { kind: "approval", answer: "deny" } },
        "may-not",
      ),
    ).toMatchObject({ ok: false, error: { code: "card_gone" } })
  })
})

describe("the verdict answer at the boundary (spec 010)", () => {
  test("a comment over 2,000 characters is refused; trailing space does not count", async () => {
    const t = await setup()
    expect(
      await t.ask("cards.answer", {
        cardId: "none",
        answer: { kind: "verdict", verdict: "approve", comment: "x".repeat(2001) },
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_input" } })
    expect(
      await t.ask("cards.answer", {
        cardId: "none",
        answer: { kind: "verdict", verdict: "approve", comment: `${"x".repeat(1999)}  ` },
      }),
    ).toMatchObject({ ok: false, error: { code: "card_gone" } })
    expect(
      await t.ask("cards.answer", {
        cardId: "none",
        answer: { kind: "verdict", verdict: "approve", comment: "x".repeat(2000) },
      }),
    ).toMatchObject({ ok: false, error: { code: "card_gone" } })
  })
})

describe("a keychain that cannot be read (spec 020)", () => {
  test("both vault lists fail with the keychain reason on the RPC path", async () => {
    // The identity of the device link loads at boot, so the store keeps values in memory and
    // only the readability probe fails: the vault reads fail while the app runs.
    const store = new Map<string, string>()
    const broken = Layer.sync(Secrets, () =>
      Secrets.of({
        get: (key) => store.get(key) ?? null,
        set: (key, value) => void store.set(key, value),
        remove: (key) => void store.delete(key),
        check: () => {
          throw new Error("The keychain could not be read")
        },
      }),
    )
    const t = testRuntime({ secrets: broken })
    const ask = (method: string, input: unknown) => runRequest(t.runtime, method, input, null)
    // The window gets the reason, not error.unknown and no stack in the main log.
    expect(await ask("secrets.list", {})).toMatchObject({
      ok: false,
      error: { code: "secret_keychain_read" },
    })
    expect(await ask("logins.list", {})).toMatchObject({
      ok: false,
      error: { code: "secret_keychain_read" },
    })
  })
})

describe("the switch Work in a new worktree over rpc (spec 007)", () => {
  test("workflows.setNewWorktree reaches the service: on fails outside git, off works", async () => {
    const t = await setup()
    const created = await t.ask("workflows.create", { serverId: t.server.id, name: "Report" })
    expect(created.ok).toBe(true)
    const id = (created as { value: Workflow }).value.id
    // The default folder is not inside a git repository.
    expect(await t.ask("workflows.setNewWorktree", { id, on: true })).toMatchObject({
      ok: false,
      error: { code: "worktree_not_git" },
    })
    expect(await t.ask("workflows.setNewWorktree", { id, on: false })).toMatchObject({
      ok: true,
      value: { newWorktree: false },
    })
  })
})

describe("the worktree of a run over rpc (spec 007)", () => {
  test("open shows and remove deletes the folder of the worktree", async () => {
    const t = await setup()
    const dir = mkdtempSync(join(tmpdir(), "robot-rpc-wt-"))
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", env: gitEnv() })
    git("-c", "init.defaultBranch=main", "init", "--quiet")
    git("config", "user.email", "test@robot.local")
    git("config", "user.name", "ROBot test")
    writeFileSync(join(dir, "notes.md"), "first\n")
    git("add", "notes.md")
    git("commit", "--quiet", "-m", "first")
    const path = join(mkdtempSync(join(tmpdir(), "robot-rpc-copy-")), "copy")
    git("worktree", "add", "-b", "robot/report-20261109-120000", path, "HEAD")
    const created = await t.ask("workflows.create", { serverId: t.server.id, name: "Report" })
    const id = (created as { value: Workflow }).value.id
    await t.runtime.runPromise(
      Database.use((db) =>
        Effect.sync(() =>
          db.run(
            `INSERT INTO run (id, workflow_id, state, source, started_at, worktree_path, worktree_branch)
             VALUES ('r1', ?, 'done', 'hand', 1, ?, ?)`,
            id,
            path,
            "robot/report-20261109-120000",
          ),
        ),
      ),
    )
    const seen: string[] = []
    t.platform.openPath = async (p: string) => {
      seen.push(p)
    }
    expect(await t.ask("runs.worktree.open", { runId: "r1" })).toMatchObject({ ok: true })
    expect(seen).toEqual([path])
    expect(await t.ask("runs.worktree.remove", { runId: "r1", confirmed: true })).toEqual({
      ok: true,
      value: "removed",
    })
    expect(existsSync(path)).toBe(false)
  })

  test("open and remove of a missing run fail with run_not_found", async () => {
    const t = await setup()
    expect(await t.ask("runs.worktree.open", { runId: "missing" })).toMatchObject({
      ok: false,
      error: { code: "run_not_found" },
    })
    expect(
      await t.ask("runs.worktree.remove", { runId: "missing", confirmed: false }),
    ).toMatchObject({ ok: false, error: { code: "run_not_found" } })
  })
})

describe("make a skill from a workflow, and the skill check (spec 017)", () => {
  const made = async () => {
    const t = await setup()
    const flow = (await t.ask("workflows.create", { serverId: t.server.id, name: "Weekly" })) as {
      value: Workflow
    }
    return { ...t, workflowId: flow.value.id }
  }

  test("a workflow with no node cannot make a draft", async () => {
    const t = await made()
    expect(await t.ask("skills.fromWorkflow", { workflowId: t.workflowId })).toMatchObject({
      ok: false,
      error: { code: "workflow_no_nodes" },
    })
  })

  test("the draft is not saved, and a taken name gets a number", async () => {
    const t = await made()
    await t.ask("workflows.node.add", {
      workflowId: t.workflowId,
      node: { kind: "text", name: "Collect", prompt: "Collect the news.  {{input}}" },
    })
    const first = (await t.ask("skills.fromWorkflow", { workflowId: t.workflowId })) as {
      ok: true
      value: { name: string; instructions: string }
    }
    expect(first.value).toMatchObject({ name: "Weekly", instructions: "1. Collect the news." })
    expect(await t.ask("skills.list", { serverId: t.server.id })).toEqual({ ok: true, value: [] })

    await t.ask("skills.create", {
      serverId: t.server.id,
      name: "weekly",
      description: "",
      instructions: "x",
    })
    const second = (await t.ask("skills.fromWorkflow", { workflowId: t.workflowId })) as {
      value: { name: string }
    }
    expect(second.value.name).toBe("Weekly 2")
  })

  test("the check reads a saved skill, and a deleted skill fails Saved", async () => {
    const t = await made()
    const created = (await t.ask("skills.create", {
      serverId: t.server.id,
      name: "Weekly",
      description: "Write the weekly summary.",
      instructions: "1. Do it.",
    })) as { value: { id: string } }
    const checked = (await t.ask("skills.check", { id: created.value.id })) as {
      value: { id: string; status: string }[]
    }
    expect(checked.value.every((f) => f.status === "ok")).toBe(true)
    await t.ask("skills.delete", { id: created.value.id })
    const gone = (await t.ask("skills.check", { id: created.value.id })) as {
      value: { id: string; status: string }[]
    }
    expect(gone.value.map((f) => f.status)).toEqual(["fail", ...Array(6).fill("skipped")])
  })

  test("a linked device cannot use either request", async () => {
    const t = await made()
    expect(await t.ask("skills.fromWorkflow", { workflowId: t.workflowId }, "may")).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    })
    expect(await t.ask("skills.check", { id: "x" }, "may")).toMatchObject({
      ok: false,
      error: { code: "not_allowed" },
    })
  })
})
