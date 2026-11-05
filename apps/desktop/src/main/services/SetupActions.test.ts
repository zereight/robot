import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { messageText } from "@robot/shared"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { listSetup, prepareTurn, runNamed, setSetupAllowed } from "./setupRun.ts"
import { testRuntime } from "./testing.ts"

const git = (cwd: string, args: readonly string[]) => {
  const result = spawnSync("git", [...args], { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(result.stderr || result.stdout)
}

const initRepo = (dir: string) => {
  git(dir, ["init"])
  git(dir, ["config", "user.email", "setup@example.com"])
  git(dir, ["config", "user.name", "Setup"])
}

const commitAll = (dir: string) => {
  git(dir, ["add", "."])
  git(dir, ["commit", "-m", "start"])
}

async function withDirs(run: (dir: string, dataDir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "robot-setup-"))
  const dataDir = mkdtempSync(join(tmpdir(), "robot-setup-data-"))
  try {
    await run(dir, dataDir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "mock" }] })
    await req.text()
    return new Response(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "Done." } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    )
  },
})
afterAll(() => server.stop(true))

const openChat = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) =>
      p.connect({
        kind: "custom",
        name: "M",
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "sk-setup-test",
      }),
    ),
  )
  const local = await run(Servers.use((s) => s.local))
  const agent = await run(
    Agents.use((a) =>
      a.create({
        serverId: local.id,
        name: "Ada",
        role: "",
        instructions: "Be brief.",
        model: { accountId: account.id, model: "mock", effort: null },
      }),
    ),
  )
  const history = () => run(Chat.use((c) => c.history(agent.id)))
  const send = (text: string) =>
    run(Chat.use((c) => c.send({ agentId: agent.id, text, replyTo: null })))
  const settled = async () => {
    const end = Date.now() + 4000
    while (Date.now() < end) {
      const page = await history()
      if (
        page.messages.length > 0 &&
        page.messages.every((message) => message.status !== "streaming") &&
        page.queue.length === 0
      )
        return page
      await Bun.sleep(10)
    }
    throw new Error("timed out")
  }
  return { ...t, agent, send, settled }
}

describe("When the user runs a setup action", () => {
  describe("with the list not allowed", () => {
    it("should run the command in the workspace", async () => {
      await withDirs(async (dir) => {
        writeFileSync(
          join(dir, "robot.json"),
          JSON.stringify({
            setupActions: [
              { name: "Copy .npmrc and configurations/env", command: "printf x > copied.txt" },
            ],
          }),
        )
        const result = await runNamed(dir, "Copy .npmrc and configurations/env")
        expect(result).toEqual({ status: "ran" })
        expect(readFileSync(join(dir, "copied.txt"), "utf8")).toBe("x")
      })
    })
  })

  describe("with a command that does not succeed", () => {
    it("should report the failure", async () => {
      await withDirs(async (dir) => {
        writeFileSync(
          join(dir, "robot.json"),
          JSON.stringify({ setupActions: [{ name: "Break", command: "exit 1" }] }),
        )
        expect(await runNamed(dir, "Break")).toEqual({ status: "failed", code: "exit" })
      })
    })
  })

  describe("with a command that does not finish", () => {
    it("should stop the command", async () => {
      await withDirs(async (dir) => {
        writeFileSync(
          join(dir, "robot.json"),
          JSON.stringify({ setupActions: [{ name: "Wait", command: "sleep 30" }] }),
        )
        const started = Date.now()
        expect(await runNamed(dir, "Wait", { limitMs: 200 })).toEqual({
          status: "failed",
          code: "timeout",
        })
        expect(Date.now() - started).toBeLessThan(2000)
      })
    })
  })
})

describe("When a turn starts", () => {
  describe("with the list not allowed", () => {
    it("should not run the command", async () => {
      await withDirs(async (dir, dataDir) => {
        writeFileSync(
          join(dir, "robot.json"),
          JSON.stringify({
            setupActions: [{ name: "Mark", command: "printf x > ran.txt", onTurnStart: true }],
          }),
        )
        expect(await prepareTurn(dataDir, dir)).toEqual([])
        expect(() => readFileSync(join(dir, "ran.txt"), "utf8")).toThrow()
      })
    })
  })

  describe("with an allowed action marked for a turn", () => {
    it("should run it on every turn", async () => {
      await withDirs(async (dir, dataDir) => {
        writeFileSync(
          join(dir, "robot.json"),
          JSON.stringify({
            setupActions: [{ name: "Mark", command: "printf x >> turns.txt", onTurnStart: true }],
          }),
        )
        setSetupAllowed(dataDir, dir, true)
        expect(await prepareTurn(dataDir, dir)).toEqual([])
        expect(await prepareTurn(dataDir, dir)).toEqual([])
        expect(readFileSync(join(dir, "turns.txt"), "utf8")).toBe("xx")
      })
    })
  })

  describe("with a command that exits with an error", () => {
    it("should name the action and let the turn go on", async () => {
      await withDirs(async (dir, dataDir) => {
        writeFileSync(
          join(dir, "robot.json"),
          JSON.stringify({
            setupActions: [{ name: "Break", command: "exit 1", onTurnStart: true }],
          }),
        )
        setSetupAllowed(dataDir, dir, true)
        expect(await prepareTurn(dataDir, dir)).toEqual([{ name: "Break", code: "exit" }])
      })
    })
  })

  describe("with a changed command", () => {
    it("should wait for a new allow", async () => {
      await withDirs(async (dir, dataDir) => {
        const file = join(dir, "robot.json")
        writeFileSync(
          file,
          JSON.stringify({
            setupActions: [{ name: "Mark", command: "printf x >> turns.txt", onTurnStart: true }],
          }),
        )
        setSetupAllowed(dataDir, dir, true)
        await prepareTurn(dataDir, dir)
        writeFileSync(
          file,
          JSON.stringify({
            setupActions: [{ name: "Mark", command: "printf y >> turns.txt", onTurnStart: true }],
          }),
        )
        await prepareTurn(dataDir, dir)
        expect(readFileSync(join(dir, "turns.txt"), "utf8")).toBe("x")
        setSetupAllowed(dataDir, dir, true)
        await prepareTurn(dataDir, dir)
        expect(readFileSync(join(dir, "turns.txt"), "utf8")).toBe("xy")
      })
    })
  })

  describe("with stop automatic setup", () => {
    it("should not run the marked action", async () => {
      await withDirs(async (dir, dataDir) => {
        writeFileSync(
          join(dir, "robot.json"),
          JSON.stringify({
            setupActions: [{ name: "Mark", command: "printf x > ran.txt", onTurnStart: true }],
          }),
        )
        setSetupAllowed(dataDir, dir, true)
        setSetupAllowed(dataDir, dir, false)
        await prepareTurn(dataDir, dir)
        expect(() => readFileSync(join(dir, "ran.txt"), "utf8")).toThrow()
        expect(await runNamed(dir, "Mark")).toEqual({ status: "ran" })
        expect(readFileSync(join(dir, "ran.txt"), "utf8")).toBe("x")
      })
    })
  })

  describe("with a file that is not a list", () => {
    it("should read nothing and run nothing", async () => {
      await withDirs(async (dir, dataDir) => {
        writeFileSync(join(dir, "robot.json"), "{")
        expect(listSetup(dataDir, dir).unreadable).toBe(true)
        expect(await prepareTurn(dataDir, dir)).toEqual([])
      })
    })
  })

  describe("with the file at the root of the repository", () => {
    it("should run the command in the workspace", async () => {
      await withDirs(async (dir, dataDir) => {
        initRepo(dir)
        writeFileSync(
          join(dir, "robot.json"),
          JSON.stringify({
            setupActions: [{ name: "Mark", command: "printf x > here.txt", onTurnStart: true }],
          }),
        )
        commitAll(dir)
        const pkg = join(dir, "pkg")
        mkdirSync(pkg)
        setSetupAllowed(dataDir, pkg, true)
        await prepareTurn(dataDir, pkg)
        expect(readFileSync(join(pkg, "here.txt"), "utf8")).toBe("x")
      })
    })
  })
})

describe("When the first turn starts in a linked worktree", () => {
  describe("with an allowed action marked for an own copy", () => {
    it("should copy a file from the main checkout once", async () => {
      await withDirs(async (dir, dataDir) => {
        const main = join(dir, "main")
        const copy = join(dir, "copy")
        mkdirSync(main)
        initRepo(main)
        writeFileSync(
          join(main, "robot.json"),
          JSON.stringify({
            setupActions: [
              {
                name: "Copy .npmrc and configurations/env",
                command: 'cp "$ROBOT_ORIGIN/from.txt" copied.txt',
                onOwnCopy: true,
              },
            ],
          }),
        )
        writeFileSync(join(main, "keep.txt"), "kept")
        commitAll(main)
        writeFileSync(join(main, "from.txt"), "secret")
        git(main, ["worktree", "add", "-b", "part", copy])
        expect(() => readFileSync(join(copy, "from.txt"))).toThrow()
        setSetupAllowed(dataDir, copy, true)
        expect(await prepareTurn(dataDir, copy)).toEqual([])
        expect(readFileSync(join(copy, "copied.txt"), "utf8")).toBe("secret")
        rmSync(join(copy, "copied.txt"))
        await prepareTurn(dataDir, copy)
        expect(() => readFileSync(join(copy, "copied.txt"))).toThrow()
      })
    })
  })

  describe("with a command that fails", () => {
    it("should try again on the next turn", async () => {
      await withDirs(async (dir, dataDir) => {
        const main = join(dir, "main")
        const copy = join(dir, "copy")
        mkdirSync(main)
        initRepo(main)
        writeFileSync(
          join(main, "robot.json"),
          JSON.stringify({
            setupActions: [{ name: "Break", command: "exit 1", onOwnCopy: true }],
          }),
        )
        writeFileSync(join(main, "keep.txt"), "kept")
        commitAll(main)
        git(main, ["worktree", "add", "-b", "part", copy])
        setSetupAllowed(dataDir, copy, true)
        expect(await prepareTurn(dataDir, copy)).toEqual([{ name: "Break", code: "exit" }])
        expect(await prepareTurn(dataDir, copy)).toEqual([{ name: "Break", code: "exit" }])
      })
    })
  })
})

describe("When a turn of a chat starts", () => {
  describe("with an allowed action that fails", () => {
    it("should show the failure and still answer", async () => {
      const t = await openChat()
      writeFileSync(
        join(t.agent.workspace, "robot.json"),
        JSON.stringify({
          setupActions: [{ name: "Break", command: "exit 1", onTurnStart: true }],
        }),
      )
      setSetupAllowed(t.dataDir, t.agent.workspace, true)
      await t.send("hello")
      const page = await t.settled()
      const reply = page.messages.find((message) => message.author === "agent")
      expect(reply?.parts).toContainEqual({
        kind: "note",
        note: "setup_failed",
        name: "Break",
        code: "exit",
      })
      expect(messageText(reply ?? { parts: [] })).toBe("Done.")
    })
  })

  describe("without an allow", () => {
    it("should not run the command", async () => {
      const t = await openChat()
      writeFileSync(
        join(t.agent.workspace, "robot.json"),
        JSON.stringify({
          setupActions: [{ name: "Mark", command: "printf x > ran.txt", onTurnStart: true }],
        }),
      )
      await t.send("hello")
      await t.settled()
      expect(() => readFileSync(join(t.agent.workspace, "ran.txt"), "utf8")).toThrow()
    })
  })
})
