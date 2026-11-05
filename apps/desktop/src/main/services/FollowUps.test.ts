import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  FOLLOW_UP_REASON_MAX,
  FOLLOW_UP_REPLIES,
  FOLLOW_UPS_PER_AGENT_MAX,
  newTurnMark,
} from "@robot/shared"
import { Effect } from "effect"
import { type FakeRuntimes, makeFakeRuntimes } from "../../../e2e/fake-runtimes.ts"
import { Agents } from "./Agents.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { FollowUps } from "./FollowUps.ts"
import { Providers } from "./Providers.ts"
import { Servers } from "./Servers.ts"
import { Tasks } from "./Tasks.ts"
import { Tools } from "./Tools.ts"
import { testRuntime } from "./testing.ts"

// "Follow-up" (spec 005): an agent ends its turn and asks the app to start a new turn later, so
// that it can look at work that takes time. It holds no process, and the user sets no routine.

let fake: FakeRuntimes
const saved: Record<string, string | undefined> = {}
beforeAll(() => {
  fake = makeFakeRuntimes()
  saved.ROBOT_CLAUDE_BIN = process.env.ROBOT_CLAUDE_BIN
  process.env.ROBOT_CLAUDE_BIN = fake.claude
  fake.setClaude({ loggedIn: true, authMethod: "claude.ai", email: "a@b.c", plan: "max" })
})
afterAll(() => {
  if (saved.ROBOT_CLAUDE_BIN === undefined) delete process.env.ROBOT_CLAUDE_BIN
  else process.env.ROBOT_CLAUDE_BIN = saved.ROBOT_CLAUDE_BIN
})

const until = async (check: () => Promise<boolean> | boolean, ms = 30_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error("timed out")
}

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const account = await run(
    Providers.use((p) => p.connect({ kind: "claude_code", name: "Claude" })),
  )
  const local = await run(Servers.use((s) => s.local))
  const ada = await run(
    Agents.use((a) =>
      a.create({
        serverId: local.id,
        name: "Ada",
        role: "",
        instructions: "You are Ada.",
        model: { accountId: account.id, model: "sonnet", effort: null },
      }),
    ),
  )
  const history = () => run(Chat.use((c) => c.history(ada.id)))
  const send = (text: string) =>
    run(Chat.use((c) => c.send({ agentId: ada.id, text, replyTo: null })))
  const settled = () =>
    until(async () => {
      const h = await history()
      return (
        h.messages.length > 0 &&
        h.messages.every((m) => m.status !== "streaming") &&
        h.queue.length === 0
      )
    })
  /** The follow-ups that wait for this agent. */
  const pending = () => run(FollowUps.use((f) => f.list(ada.id)))
  /** Records a follow-up as the tool does. */
  const follow = async (minutes: number, reason = "CI of the deploy") => {
    const tasks = await run(Tasks.use((x) => x.list(local.id)))
    const task = tasks.at(-1)
    if (!task) throw new Error("no task")
    await run(
      FollowUps.use((f) =>
        f.add({ agentId: ada.id, threadId: null, taskId: task.id, reason, minutes }),
      ),
    )
  }
  /** The clock of a look, `minutes` from now, as after the app was off for that time. */
  const later = (minutes: number) => Date.now() + minutes * 60_000
  return { t, run, local, ada, history, send, settled, pending, follow, later }
}
describe("follow-up (spec 005)", () => {
  describe("when an agent asks to look again later", () => {
    test("it records the follow-up and starts no turn now", async () => {
      const s = await setup()
      await s.send("Deploy, then look again.")
      await s.settled()
      const turns = fake.claudeCalls().filter((c) => "prompt" in c).length
      await s.follow(30)
      // No new turn starts: the call only records the follow-up.
      await Bun.sleep(100)
      expect(fake.claudeCalls().filter((c) => "prompt" in c)).toHaveLength(turns)
      const waiting = await s.pending()
      expect(waiting).toHaveLength(1)
      expect(waiting[0]?.reason).toBe("CI of the deploy")
      expect(waiting[0]?.at).toBeGreaterThan(Date.now())
    })

    test("its task starts at the time, as a turn of the same conversation", async () => {
      const s = await setup()
      await s.send("Deploy, then look again.")
      await s.settled()
      await s.follow(5)
      await s.run(FollowUps.use((f) => f.check(s.later(6))))
      await s.settled()
      const { messages } = await s.history()
      // The turn of a follow-up shows as a turn: the prompt of the task, then the reply (spec 005).
      expect(messages.map((m) => m.author)).toEqual(["user", "agent", "user", "agent"])
      // The follow-up made one task and is gone.
      expect(await s.pending()).toHaveLength(0)
      const tasks = await s.run(Tasks.use((x) => x.list(s.local.id)))
      const followUp = tasks.find((t) => t.source === "follow_up")
      expect(followUp?.state).toBe("done")
      // Its label names the reason, so the Tasks page reads as the spec says.
      expect(followUp?.label).toBe("Look again: CI of the deploy")
      // The agent reads its own reason in the prompt of the new turn.
      const sent = fake
        .claudeCalls()
        .filter((c) => "prompt" in c)
        .map((c) => String(c.prompt))
      expect(sent.at(-1)).toContain("CI of the deploy")
    })

    test("the details of the task list that follow-up", async () => {
      const s = await setup()
      await s.send("Deploy, then look again.")
      await s.settled()
      await s.follow(30)
      const [followUp] = await s.pending()
      if (!followUp) throw new Error("no follow-up")
      const rows = await s.run(FollowUps.use((f) => f.ofTask(followUp.taskId)))
      expect(rows.map((row) => row.reason)).toEqual(["CI of the deploy"])
    })

    test("a running follow-up marks the thread, so the working line can name it", async () => {
      const s = await setup()
      await s.send("Deploy, then look again.")
      await s.settled()
      const tasks = await s.run(Tasks.use((x) => x.list(s.local.id)))
      const task = tasks.at(-1)
      if (!task) throw new Error("no task")
      await s.run(
        Database.use((d) =>
          Effect.sync(() => {
            d.run("UPDATE task SET source = 'follow_up', state = 'running' WHERE id = ?", task.id)
          }),
        ),
      )
      const threads = await s.run(Chat.use((c) => c.threads(s.ada.id)))
      expect(threads.main.followUp).toBe(true)
    })

    test("the user deletes it before its time: no task starts", async () => {
      const s = await setup()
      await s.send("Deploy, then look again.")
      await s.settled()
      await s.follow(5)
      const [followUp] = await s.pending()
      if (!followUp) throw new Error("no follow-up")
      await s.run(FollowUps.use((f) => f.remove(followUp.id)))
      await s.run(FollowUps.use((f) => f.check(s.later(6))))
      await Bun.sleep(100)
      const tasks = await s.run(Tasks.use((x) => x.list(s.local.id)))
      expect(tasks.some((t) => t.source === "follow_up")).toBe(false)
    })

    test("a reason is one line of at most 200 characters", async () => {
      const s = await setup()
      await s.send("Deploy, then look again.")
      await s.settled()
      await s.follow(5, `many\nlines   here ${"x".repeat(FOLLOW_UP_REASON_MAX + 50)}`)
      const [followUp] = await s.pending()
      expect(followUp?.reason.startsWith("many lines here x")).toBe(true)
      expect([...(followUp?.reason ?? "")]).toHaveLength(FOLLOW_UP_REASON_MAX)
    })

    test("the 21st follow-up of one agent fails with the limit", async () => {
      const s = await setup()
      await s.send("Deploy, then look again.")
      await s.settled()
      const tasks = await s.run(Tasks.use((x) => x.list(s.local.id)))
      const taskId = tasks.at(-1)?.id
      if (!taskId) throw new Error("no task")
      const add = () =>
        s.run(
          FollowUps.use((f) =>
            f.add({
              agentId: s.ada.id,
              threadId: null,
              taskId,
              reason: "again",
              minutes: 5,
            }),
          ),
        )
      for (let i = 0; i < FOLLOW_UPS_PER_AGENT_MAX; i++) await add()
      await expect(add()).rejects.toThrow()
      expect(await s.pending()).toHaveLength(FOLLOW_UPS_PER_AGENT_MAX)
    })
  })
})

describe("follow-up의 시간이 지났을 때", () => {
  describe("앱이 꺼져 있었다면", () => {
    test("12시간 넘게 늦으면 태스크를 만들지 않아야 한다", async () => {
      const s = await setup()
      await s.send("Deploy, then look again.")
      await s.settled()
      await s.follow(5)
      // Thirteen hours later, as after the app was off.
      await s.run(FollowUps.use((f) => f.check(s.later(13 * 60))))
      await Bun.sleep(100)
      const tasks = await s.run(Tasks.use((x) => x.list(s.local.id)))
      expect(tasks.some((t) => t.source === "follow_up")).toBe(false)
      expect(await s.pending()).toHaveLength(0)
    })
  })
})

// The tool of spec 007, "Look again later". It records the follow-up and ends the call at once, so
// a place that is not a direct chat gets the refusal with the step marked failed.
describe("the tool wait until (spec 007)", () => {
  const exec = (
    runtime: ReturnType<typeof testRuntime>["runtime"],
    onFollowUp: ((callId: string, reason: string, minutes: number) => string | null) | undefined,
    args: object,
  ) => {
    const ctx = {
      agentId: "a",
      workspace: "/tmp",
      permission: "full" as const,
      signal: new AbortController().signal,
      onWaiting: () => {},
      onMemory: () => {},
      onKnowledge: () => {},
      knowledgeChanges: { count: 0 },
      turn: newTurnMark("user"),
      taskId: "t",
      ...(onFollowUp ? { onFollowUp } : {}),
    }
    return runtime.runPromise(
      Tools.use((x) =>
        Effect.promise(() =>
          x.execute(ctx, { id: "w", name: "wait_until", input: JSON.stringify(args) }),
        ),
      ),
    )
  }

  test("it records the follow-up and ends the call", async () => {
    const t = testRuntime()
    const calls: { reason: string; minutes: number }[] = []
    const outcome = await exec(
      t.runtime,
      (_callId, reason, minutes) => {
        calls.push({ reason, minutes })
        return null
      },
      { reason: "  CI of\n the deploy ", minutes: 15 },
    )
    expect(outcome.failed).toBe(false)
    expect(calls).toEqual([{ reason: "CI of the deploy", minutes: 15 }])
    expect(outcome.output).toContain("15 minutes")
  })

  test("a delay outside the range fails the step and the turn goes on", async () => {
    const t = testRuntime()
    for (const minutes of [0, 1441, 1.5]) {
      const outcome = await exec(t.runtime, () => null, {
        reason: "later",
        minutes,
      })
      expect(outcome.failed).toBe(true)
    }
  })

  test("a place with no follow-up gets the refusal", async () => {
    const t = testRuntime()
    const outcome = await exec(t.runtime, undefined, {
      reason: "later",
      minutes: 5,
    })
    expect(outcome.failed).toBe(true)
    expect(outcome.output).toContain("direct chat")
  })

  test("a full list of follow-ups gives the reason of the limit", async () => {
    const t = testRuntime()
    const outcome = await exec(t.runtime, () => FOLLOW_UP_REPLIES.full, {
      reason: "later",
      minutes: 5,
    })
    expect(outcome.failed).toBe(true)
    expect(outcome.output).toContain("20 follow-ups")
  })
})

describe("follow-up의 정리", () => {
  describe("에이전트를 지우면", () => {
    test("남은 follow-up도 함께 지워져야 한다", async () => {
      const s = await setup()
      await s.send("Deploy, then look again.")
      await s.settled()
      await s.follow(30)
      expect(await s.pending()).toHaveLength(1)
      await s.run(Agents.use((a) => a.archive(s.ada.id)))
      await s.run(Agents.use((a) => a.remove(s.ada.id)))
      expect(await s.pending()).toHaveLength(0)
    })
  })
})

describe("follow-up의 권한", () => {
  describe("Read only 레벨이면", () => {
    test("거부되고 저장되지 않아야 한다", async () => {
      const t = testRuntime()
      let called = false
      const ctx = {
        agentId: "a",
        workspace: "/tmp",
        permission: "read_only" as const,
        signal: new AbortController().signal,
        onWaiting: () => {},
        onMemory: () => {},
        onKnowledge: () => {},
        knowledgeChanges: { count: 0 },
        turn: newTurnMark("user"),
        taskId: "t",
        onFollowUp: () => {
          called = true
          return null
        },
      }
      const outcome = await t.runtime.runPromise(
        Tools.use((x) =>
          Effect.promise(() =>
            x.execute(ctx, {
              id: "w",
              name: "wait_until",
              input: JSON.stringify({ reason: "later", minutes: 5 }),
            }),
          ),
        ),
      )
      expect(outcome.failed).toBe(true)
      expect(outcome.refused).toBe("read_only")
      expect(called).toBe(false)
    })
  })
})
