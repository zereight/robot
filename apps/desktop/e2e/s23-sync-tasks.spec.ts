import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { expect, type Page, test } from "@playwright/test"
import { createAgent, shot } from "./harness.ts"
import { GOOD_KEY } from "./mock-provider.ts"
import {
  closeSettings,
  report,
  rowOf,
  rpc,
  send,
  settled,
  synced,
  turnOnSync,
} from "./sync-helpers.ts"

// Tasks, routines, workflows and files of two computers that sync (spec 019, S23).
interface TaskInfo {
  id: string
  state: string
  originName: string | null
  waitsFor: string | null
  retryOf: string | null
  prompt: string
  agentName: string
}

const localServer = async (page: Page) =>
  (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string
const tasksOf = async (page: Page) =>
  rpc<TaskInfo[]>(page, "tasks.list", { serverId: await localServer(page) })

/** The model account of the second computer is connected here: a key never crosses (spec 019). */
const connectHere = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-reconnect").click()
  await page.getByTestId("provider-api-key").fill(GOOD_KEY)
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status").first()).toHaveText("Connected")
  await page.getByTestId("settings-close").click()
}

/** Two computers in sync with an agent "Ada", both able to ask the model. */
const ready = async (
  ports: [number, number],
  extra: [Record<string, string>, Record<string, string>] = [{}, {}],
) => {
  const s = await synced(ports, extra)
  await createAgent(s.one.page, "Ada")
  await turnOnSync(s.one, s.two)
  await closeSettings(s.one.page)
  await closeSettings(s.two.page)
  await expect(rowOf(s.two.page, "Ada")).toBeVisible({ timeout: 20_000 })
  await connectHere(s.two.page)
  return s
}
/** Closes an app the normal way. It must end by itself (see f1-quit.spec.ts). */
const quit = async (app: Awaited<ReturnType<typeof synced>>["one"]["app"]) => {
  await app.close().catch(() => {
    // The app was closed in the test.
  })
}
const close = async (s: Awaited<ReturnType<typeof ready>>) => {
  await quit(s.one.app)
  await quit(s.two.app)
  await s.mock.close()
}

const waiting = (path: string) => `TOOL run_command ${JSON.stringify({ command: `rm "${path}"` })}`

test("sync tasks: a message sent on computer 2 runs only there, and the tasks page lists both", async () => {
  test.setTimeout(300_000)
  const s = await ready([47891, 47892])
  const { one, two } = s
  try {
    await rowOf(one.page, "Ada").click()
    await rowOf(two.page, "Ada").click()
    await send(two.page, "Hello from the second computer")
    await settled(two.page)

    // The reply streams on both, and the first computer starts no task of its own.
    await expect(
      one.page.getByTestId("message").filter({ hasText: "You said: Hello from the second" }),
    ).toHaveCount(1, { timeout: 15_000 })
    const onOne = await tasksOf(one.page)
    const onTwo = await tasksOf(two.page)
    expect(onOne.filter((t) => t.originName === null)).toEqual([])
    expect(onOne.filter((t) => t.originName === "MacBook 2")).toHaveLength(1)
    expect(onTwo.filter((t) => t.originName === null)).toHaveLength(1)

    // The tasks page names the computer and filters by it.
    await one.page.getByTestId("page-tasks").click()
    await expect(one.page.getByTestId("task-row")).toHaveCount(1)
    await expect(one.page.getByTestId("task-computer")).toHaveText("MacBook 2")
    await shot(one.page, "s23-01-tasks-both")
    await one.page.getByTestId("tasks-filter-computer").selectOption("here")
    await expect(one.page.getByTestId("tasks-no-match")).toBeVisible()
    await one.page.getByTestId("tasks-filter-computer").selectOption({ label: "MacBook 2" })
    await expect(one.page.getByTestId("task-row")).toHaveCount(1)
    await two.page.getByTestId("page-tasks").click()
    await expect(two.page.getByTestId("task-computer")).toHaveText("This computer")
    report("s23-tasks", { onOne: onOne.length, onTwo: onTwo.length })
  } finally {
    await close(s)
  }
})

test("sync tasks: an approval is answered on the other computer, one task per agent, notices and Retry", async () => {
  test.setTimeout(300_000)
  const s = await ready([47893, 47894])
  const { one, two } = s
  try {
    const keep = join(s.data1, "keep.txt")
    writeFileSync(keep, "x")
    await rowOf(one.page, "Ada").click()
    await rowOf(two.page, "Ada").click()

    // A task on the first computer waits for an approval. The card shows on both.
    await send(one.page, waiting(keep))
    await expect(one.page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    await expect(two.page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    await expect(two.page.getByTestId("tool-origin")).toContainText("from MacBook 1")
    // A computer cannot make an "Always allow" rule for another computer.
    await expect(two.page.getByTestId("ask-always")).toHaveCount(0)
    await expect(one.page.getByTestId("ask-always")).toHaveCount(1)
    // The second computer gets a notice, and the island shows the card. The island there has no
    // "Always allow" for it, and the island of the first computer has.
    type Island = {
      waiting: { agent: { name: string }; kind: string; always: boolean; step: string | null }[]
    }
    const island = await rpc<Island>(two.page, "island.get")
    expect(island.waiting).toHaveLength(1)
    expect(island.waiting[0]?.agent.name).toBe("Ada")
    expect(island.waiting[0]?.kind).toBe("approval")
    expect(island.waiting[0]?.always).toBe(false)
    const own = await rpc<Island>(one.page, "island.get")
    expect(own.waiting).toHaveLength(1)
    expect(own.waiting[0]?.always).toBe(true)
    await shot(two.page, "s23-02-card-on-two")

    // One task per agent: a message on the second computer waits for the task on the first.
    await send(two.page, "Hello again")
    await expect
      .poll(async () => (await tasksOf(two.page)).find((t) => t.waitsFor !== null)?.waitsFor, {
        timeout: 15_000,
      })
      .toBe("MacBook 1")
    await two.page.getByTestId("page-tasks").click()
    await expect(two.page.getByTestId("task-waits")).toHaveText("Waits for the task on MacBook 1.")
    await shot(two.page, "s23-03-waits")
    await two.page.getByTestId("page-chats").click()
    await rowOf(two.page, "Ada").click()

    // The answer on the second computer goes to the first one, where the task goes on.
    await two.page.getByTestId("ask-allow").click()
    await expect.poll(() => existsSync(keep), { timeout: 15_000 }).toBe(false)
    await expect(one.page.getByTestId("tool-decision")).toContainText("MacBook 2", {
      timeout: 15_000,
    })
    await expect
      .poll(async () => (await rpc<{ waiting: unknown[] }>(two.page, "island.get")).waiting, {
        timeout: 15_000,
      })
      .toEqual([])
    // The task that waited runs on the second computer and ends.
    await expect
      .poll(
        async () =>
          (await tasksOf(two.page)).filter((t) => t.originName === null && t.state === "done")
            .length,
        { timeout: 30_000 },
      )
      .toBe(1)
    await settled(one.page)

    // A task of the other computer is stopped from here, and Retry makes a new task that runs here.
    await send(one.page, waiting(join(s.data1, "other.txt")))
    await expect(two.page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(
        async () =>
          (await tasksOf(two.page)).find(
            (t) => t.originName === "MacBook 1" && t.state === "waiting",
          )?.id,
        { timeout: 15_000 },
      )
      .toBeDefined()
    const stopped = (await tasksOf(two.page)).find(
      (t) => t.originName === "MacBook 1" && t.state === "waiting",
    )
    await two.page.getByTestId("page-tasks").click()
    await two.page
      .locator("[data-testid=task-row]", { hasText: "MacBook 1" })
      .getByTestId("task-open")
      .first()
      .click()
    await two.page.getByTestId("task-stop").click()
    await expect
      .poll(async () => (await tasksOf(one.page)).find((t) => t.id === stopped?.id)?.state, {
        timeout: 15_000,
      })
      .toBe("cancelled")
    await expect(two.page.getByTestId("task-detail-state")).toHaveAttribute(
      "data-state",
      "cancelled",
      { timeout: 15_000 },
    )
    await two.page.getByTestId("task-retry").click()
    await expect
      .poll(
        async () =>
          (await tasksOf(two.page)).some((t) => t.retryOf === stopped?.id && t.originName === null),
        { timeout: 15_000 },
      )
      .toBe(true)
    report("s23-approval", { answeredOnTwo: true })
  } finally {
    await close(s)
  }
})

test("sync tasks: a card of a computer that is off says so", async () => {
  test.setTimeout(240_000)
  const s = await ready([47895, 47896])
  const { one, two } = s
  try {
    await rowOf(one.page, "Ada").click()
    await rowOf(two.page, "Ada").click()
    await send(one.page, waiting(join(s.data1, "never.txt")))
    await expect(two.page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    await expect(two.page.getByTestId("ask-origin-offline")).toHaveCount(0)
    await expect(two.page.getByTestId("tool-origin")).toContainText("from MacBook 1")
    // The first computer is lost at once, as when its power goes: its task does not end by itself.
    const proc = one.app.process()
    const pid = proc.pid
    console.log("DIAG s23 kill returned", proc.kill("SIGKILL"), "pid", pid)
    for (const wait of [1000, 4000, 10000]) {
      await new Promise((r) => setTimeout(r, wait))
      const states = await rpc<{ name: string; state: string }[]>(two.page, "servers.list")
      console.log(
        "DIAG s23 after",
        wait,
        "ms servers on two",
        JSON.stringify(states.map((x) => `${x.name}:${x.state}`)),
      )
      const run = (cmd: string, args: string[]) =>
        spawnSync(cmd, args, { encoding: "utf8" }).stdout?.trim() ?? ""
      if (process.platform === "win32") {
        console.log("DIAG s23 netstat\n" + run("cmd.exe", ["/c", "netstat -ano | findstr 4789"]))
        console.log("DIAG s23 tasklist\n" + run("tasklist", ["/FI", "IMAGENAME eq ROBot.exe"]))
      } else {
        console.log(
          "DIAG s23 lsof\n" + run("/bin/sh", ["-c", "lsof -nP -iTCP:47895 -iTCP:47896 || true"]),
        )
      }
    }
    await expect(two.page.getByTestId("ask-origin-offline")).toHaveText("MacBook 1 is offline.", {
      timeout: 30_000,
    })
    await expect(two.page.getByTestId("ask-allow")).toBeDisabled()
    await shot(two.page, "s23-04-origin-offline")
    report("s23-offline", { offlineCard: true })
  } finally {
    await close(s)
  }
})

test("sync tasks: a routine and a workflow run on one computer only, and Run on this computer moves them", async () => {
  test.setTimeout(300_000)
  const s = await ready([47897, 47898])
  const { one, two } = s
  try {
    const server = await localServer(one.page)
    const agentId = (
      await rpc<{ id: string }[]>(one.page, "agents.list", { serverId: server, archived: false })
    )[0]?.id as string
    await rpc(one.page, "routines.create", {
      serverId: server,
      agentId,
      name: "Morning check",
      prompt: "hello",
      schedule: { kind: "every", minutes: 30, from: Date.now() },
      place: { kind: "agent" },
    })
    const watched = await rpc<{ id: string }>(one.page, "channels.create", {
      serverId: server,
      name: "Watched",
      topic: "",
      memberIds: [agentId],
      leadId: null,
    })
    const quiet = await rpc<{ id: string }>(one.page, "channels.create", {
      serverId: server,
      name: "Quiet",
      topic: "",
      memberIds: [agentId],
      leadId: null,
    })
    const flow = await rpc<{ id: string }>(one.page, "workflows.create", {
      serverId: server,
      name: "Deploy flow",
      trigger: { kind: "channel", channelId: watched.id, contains: "deploy" },
      steps: [{ id: "p", kind: "post", name: "p", x: 0, y: 0, channelId: quiet.id, text: "Ran" }],
      edges: [],
    })

    // On the second computer both show where they run, and the button is Run on this computer.
    await two.page.getByTestId("page-workflows").click()
    await expect(two.page.getByTestId("routine-runs-on")).toHaveText("Runs on MacBook 1", {
      timeout: 20_000,
    })
    await expect(two.page.getByTestId("routine-run")).toHaveCount(0)
    await shot(two.page, "s23-05-routine-elsewhere")
    await two.page.getByTestId("wf-tabs").getByText("Workflows", { exact: true }).click()
    await expect(two.page.getByTestId("wf-runs-on")).toHaveText("Runs on MacBook 1")
    await expect(two.page.getByTestId("wf-card-run")).toHaveCount(0)

    // A message that is sent on the second computer fires the workflow on the first one only.
    await expect
      .poll(
        async () =>
          (
            await rpc<{ id: string }[]>(two.page, "channels.list", {
              serverId: await localServer(two.page),
            })
          ).length,
        { timeout: 20_000 },
      )
      .toBe(2)
    await rpc(two.page, "channels.send", { channelId: watched.id, text: "please deploy now" })
    const runs = async (page: Page) =>
      (await rpc<unknown[]>(page, "workflows.runs", { workflowId: flow.id })).length
    await expect.poll(() => runs(one.page), { timeout: 20_000 }).toBe(1)
    await new Promise((r) => setTimeout(r, 1500))
    // One run in all: the second computer did not fire it too.
    expect(await runs(one.page)).toBe(1)
    await expect.poll(() => runs(two.page), { timeout: 20_000 }).toBe(1)

    // MacBook 1 sends a change that makes the routine and the workflow run on MacBook 2. Only the
    // user of MacBook 2 decides that, so MacBook 2 ignores it and still shows "Runs on MacBook 1".
    // The rename is in the same change, so the test sees that the change has crossed.
    const deviceTwo = (await rpc<{ self: { id: string } }>(two.page, "devices.get")).self.id
    const craft = (sql: string, ...args: (string | null)[]) => {
      const db = new DatabaseSync(join(s.data1, "robot.db"))
      db.exec("PRAGMA busy_timeout = 5000")
      db.prepare(sql).run(...args)
      db.close()
    }
    craft("UPDATE routine SET runs_on = ?, name = 'Morning check 2'", deviceTwo)
    craft("UPDATE workflow SET runs_on = ?, name = 'Deploy flow 2'", deviceTwo)
    await two.page.getByTestId("wf-tabs").getByText("Routines", { exact: true }).click()
    await expect(
      two.page.getByTestId("routine-card").filter({ hasText: "Morning check 2" }),
    ).toBeVisible({ timeout: 20_000 })
    await expect(two.page.getByTestId("routine-runs-on")).toHaveText("Runs on MacBook 1")
    await expect(two.page.getByTestId("routine-run")).toHaveCount(0)
    await two.page.getByTestId("wf-tabs").getByText("Workflows", { exact: true }).click()
    await expect(two.page.getByText("Deploy flow 2")).toBeVisible({ timeout: 20_000 })
    await expect(two.page.getByTestId("wf-runs-on")).toHaveText("Runs on MacBook 1")
    await expect(two.page.getByTestId("wf-card-run")).toHaveCount(0)
    await shot(two.page, "s23-05b-run-here-change-ignored")
    // The first computer takes them back, so that the move below is a real move.
    craft("UPDATE routine SET runs_on = NULL")
    craft("UPDATE workflow SET runs_on = NULL")
    await one.page.getByTestId("page-workflows").click()
    await expect(one.page.getByTestId("routine-runs-on")).toHaveCount(0, { timeout: 20_000 })

    // Run on this computer moves the routine; the first computer shows where it runs at once.
    await two.page.getByTestId("wf-tabs").getByText("Routines", { exact: true }).click()
    await two.page.getByTestId("routine-run-here").click()
    await expect(two.page.getByTestId("routine-run")).toBeVisible()
    await expect(two.page.getByTestId("routine-runs-on")).toHaveCount(0)
    await one.page.getByTestId("page-workflows").click()
    await expect(one.page.getByTestId("routine-runs-on")).toHaveText("Runs on MacBook 2", {
      timeout: 15_000,
    })
    await expect(one.page.getByTestId("routine-run-here")).toBeVisible()
    await shot(one.page, "s23-06-routine-moved")
    report("s23-routines", { moved: true })
  } finally {
    await close(s)
  }
})

test("sync tasks: a file of a message that is not on this computer is copied from the origin when it opens", async () => {
  test.setTimeout(300_000)
  const folder = mkdtempSync(join(tmpdir(), "robot-s23-"))
  const note = join(folder, "note.txt")
  writeFileSync(note, "hello from the first computer")
  const opened = join(folder, "opened.log")
  const s = await ready(
    [47899, 47900],
    [{ ROBOT_TEST_PICK_FILES: JSON.stringify([note]) }, { ROBOT_TEST_OPEN_LOG: opened }],
  )
  const { one, two } = s
  try {
    await rowOf(one.page, "Ada").click()
    await rowOf(two.page, "Ada").click()
    await one.page.getByTestId("composer-attach").click()
    await send(one.page, "see the file")
    await settled(one.page)
    await expect(one.page.getByTestId("message-file")).toContainText("note.txt")
    await expect(one.page.getByTestId("message-file-missing")).toHaveCount(0)

    // On the second computer it shows its name and size, and says that it is not there.
    const chip = two.page.getByTestId("message-file").first()
    await expect(chip).toContainText("note.txt", { timeout: 20_000 })
    await expect(chip.getByTestId("message-file-missing")).toHaveText("Not on this computer")
    await shot(two.page, "s23-07-file-missing")

    // Open copies the file from the first computer, keeps it and opens it.
    await chip.getByTestId("message-file-open").click()
    await expect(chip.getByTestId("message-file-missing")).toHaveCount(0, { timeout: 20_000 })
    await expect.poll(() => existsSync(opened), { timeout: 10_000 }).toBe(true)
    const path = readFileSync(opened, "utf8").trim().split("\n")[0] as string
    expect(readFileSync(path, "utf8")).toBe("hello from the first computer")
    expect(path.startsWith(s.data1)).toBe(false)

    // The origin is off: the open of a file that is not here fails with a plain line.
    await one.page.getByTestId("composer-attach").click()
    await send(one.page, "and again")
    await settled(one.page)
    await expect(two.page.getByTestId("message-file")).toHaveCount(2, { timeout: 20_000 })
    await one.app.close()
    const second = two.page.getByTestId("message-file").nth(1)
    await expect(second.getByTestId("message-file-missing")).toBeVisible()
    await expect
      .poll(
        async () => {
          await second.getByTestId("message-file-open").click()
          return second
            .getByTestId("message-file-error")
            .textContent({ timeout: 5_000 })
            .catch(() => "")
        },
        { timeout: 40_000 },
      )
      .toBe("The file is on MacBook 1, which is offline.")
    await shot(two.page, "s23-08-file-origin-off")
    report("s23-files", { copied: true })
  } finally {
    await close(s)
  }
})
