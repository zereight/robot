import { existsSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { expect, test } from "@playwright/test"
import { createAgent, launch, shot } from "./harness.ts"
import {
  closeSettings,
  envFor,
  report,
  rowOf,
  rpc,
  send,
  settled,
  synced,
  turnOnSync,
} from "./sync-helpers.ts"

// Quitting the app (Cmd-Q, or `app.close()` in a test) must end the process, also while a card
// waits for the user and two computers sync live. After the start, the card is still there
// (spec 005, 007).

const waiting = (path: string) => `TOOL run_command ${JSON.stringify({ command: `rm "${path}"` })}`
const QUIT_MS = 10_000

/** True when nothing listens on the port. */
const portIsFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(true)))
  })

/** Closes the app the normal way. Returns how it ended and how long it took. */
const quit = async (app: Awaited<ReturnType<typeof launch>>["app"]) => {
  const proc = app.process()
  let stderr = ""
  proc.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const ended = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      return resolve({ code: proc.exitCode, signal: proc.signalCode })
    }
    proc.once("exit", (code, signal) => resolve({ code, signal }))
  })
  const started = Date.now()
  void app.close().catch(() => {})
  const result = await Promise.race([
    ended,
    new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), QUIT_MS)),
  ])
  if (result === "timeout") {
    // The test fails, and the app must not stay on the machine.
    proc.kill("SIGKILL")
    return { ok: false as const, ms: Date.now() - started, code: null, signal: null, stderr }
  }
  return {
    ok: true as const,
    ms: Date.now() - started,
    code: result.code,
    signal: result.signal,
    stderr,
  }
}

test("quit: a card waits and two computers sync live; the app ends, and the card is there after the start", async () => {
  test.setTimeout(300_000)
  const ports: [number, number] = [47921, 47922]
  const s = await synced(ports)
  const { one, two } = s
  let restarted: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await createAgent(one.page, "Ada")
    await turnOnSync(one, two)
    await closeSettings(one.page)
    await closeSettings(two.page)
    await expect(rowOf(two.page, "Ada")).toBeVisible({ timeout: 20_000 })
    const keep = join(s.data1, "keep.txt")
    writeFileSync(keep, "x")
    await rowOf(one.page, "Ada").click()
    await rowOf(two.page, "Ada").click()

    // A task on the first computer waits for an approval. The card shows on both, and the second
    // computer is connected to the first one as a linked client.
    await send(one.page, waiting(keep))
    await expect(one.page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    await expect(two.page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    const asked = (await one.page.getByTestId("ask-time").textContent()) ?? ""
    expect(asked).toMatch(/^Asked at /)
    const before = await rpc<{ id: string; state: string }[]>(one.page, "tasks.list", {
      serverId: (await rpc<{ id: string }[]>(one.page, "servers.list"))[0]?.id,
    })
    expect(before.map((t) => t.state)).toEqual(["waiting"])
    await shot(one.page, "f1-01-card-before-quit")

    // The first computer quits the normal way. Nothing opens a dialog, and the process ends.
    const quitOne = await quit(one.app)
    report("f1-quit", { quitOne })
    expect(quitOne.ok).toBe(true)
    expect(quitOne.signal).toBeNull()
    expect(quitOne.code).toBe(0)
    expect(quitOne.ms).toBeLessThan(QUIT_MS)
    // No error was thrown while the app closed (a late message on a closed database, for example).
    expect(quitOne.stderr).not.toContain("error while closing")
    // The port of the link is free again.
    expect(await portIsFree(ports[0])).toBe(true)
    // The file is still there: nothing ran.
    expect(existsSync(keep)).toBe(true)

    // The first computer starts again with the same data. The task waits on, the card is the same.
    restarted = await launch(s.data1, envFor(ports[0], {}))
    await rowOf(restarted.page, "Ada").click()
    await expect(restarted.page.getByTestId("ask-card")).toBeVisible({ timeout: 20_000 })
    await expect(restarted.page.getByTestId("ask-time")).toHaveText(asked)
    await expect(restarted.page.getByTestId("ask-card")).toContainText(`rm "${keep}"`)
    const after = await rpc<{ id: string; state: string; error: unknown }[]>(
      restarted.page,
      "tasks.list",
      { serverId: (await rpc<{ id: string }[]>(restarted.page, "servers.list"))[0]?.id },
    )
    expect(after.map((t) => t.state)).toEqual(["waiting"])
    expect(existsSync(keep)).toBe(true)
    await shot(restarted.page, "f1-02-card-after-start")

    // The second computer finds the first one again by itself and shows the same card.
    await expect(two.page.getByTestId("ask-card")).toBeVisible({ timeout: 30_000 })

    // Allow: the step runs, and the agent goes on in the same reply.
    await restarted.page.getByTestId("ask-allow").click()
    await expect.poll(() => existsSync(keep), { timeout: 15_000 }).toBe(false)
    await settled(restarted.page)
    await expect(
      restarted.page.getByTestId("message").filter({ hasText: "Tool said:" }),
    ).toHaveCount(1, { timeout: 15_000 })
    expect(
      (
        await rpc<{ id: string; state: string }[]>(restarted.page, "tasks.list", {
          serverId: (await rpc<{ id: string }[]>(restarted.page, "servers.list"))[0]?.id,
        })
      ).map((t) => t.state),
    ).toEqual(["done"])
    await shot(restarted.page, "f1-03-after-allow")

    // The other computer, a linked client with its own live sync, quits the normal way too.
    const quitTwo = await quit(two.app)
    report("f1-quit", { quitOne, quitTwo })
    expect(quitTwo.ok).toBe(true)
    expect(quitTwo.signal).toBeNull()
    expect(quitTwo.ms).toBeLessThan(QUIT_MS)
    expect(await portIsFree(ports[1])).toBe(true)
  } finally {
    await restarted?.app.close().catch(() => {})
    await one.app.close().catch(() => {})
    await two.app.close().catch(() => {})
    await s.mock.close()
  }
})

test("quit: a question that waits stays after the start, with its choices", async () => {
  test.setTimeout(240_000)
  const s = await synced([47923, 47924])
  const { one } = s
  let restarted: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await createAgent(one.page, "Ada")
    await rowOf(one.page, "Ada").click()
    const ask = `TOOL ask_user ${JSON.stringify({ question: "Which colour?", choices: ["red", "blue"] })}`
    await send(one.page, ask)
    await expect(one.page.getByTestId("ask-card")).toContainText("Which colour?", {
      timeout: 15_000,
    })
    const quitted = await quit(one.app)
    expect(quitted.ok).toBe(true)
    expect(quitted.signal).toBeNull()

    restarted = await launch(s.data1, envFor(47923, {}))
    await rowOf(restarted.page, "Ada").click()
    await expect(restarted.page.getByTestId("ask-card")).toContainText("Which colour?", {
      timeout: 20_000,
    })
    await expect(restarted.page.getByTestId("ask-choice")).toHaveText(["red", "blue"])
    await restarted.page.getByTestId("ask-choice").nth(1).click()
    await settled(restarted.page)
    await expect(
      restarted.page.getByTestId("message").filter({ hasText: "Tool said: blue" }),
    ).toHaveCount(1, { timeout: 15_000 })
  } finally {
    await restarted?.app.close().catch(() => {})
    await one.app.close().catch(() => {})
    await s.two.app.close().catch(() => {})
    await s.mock.close()
  }
})

test("quit: Stop on a card that waited through a restart ends it as before", async () => {
  test.setTimeout(240_000)
  const s = await synced([47925, 47926])
  const { one } = s
  let restarted: Awaited<ReturnType<typeof launch>> | undefined
  try {
    await createAgent(one.page, "Ada")
    await rowOf(one.page, "Ada").click()
    const keep = join(s.data1, "keep.txt")
    writeFileSync(keep, "x")
    await send(one.page, waiting(keep))
    await expect(one.page.getByTestId("ask-card")).toBeVisible({ timeout: 15_000 })
    expect((await quit(one.app)).ok).toBe(true)

    restarted = await launch(s.data1, envFor(47925, {}))
    await rowOf(restarted.page, "Ada").click()
    await expect(restarted.page.getByTestId("ask-card")).toBeVisible({ timeout: 20_000 })
    await restarted.page.getByTestId("composer-stop").click()
    await expect(restarted.page.getByTestId("ask-card")).toHaveCount(0)
    expect(existsSync(keep)).toBe(true)
    const serverId = (await rpc<{ id: string }[]>(restarted.page, "servers.list"))[0]?.id
    await expect
      .poll(async () =>
        (await rpc<{ state: string }[]>(restarted?.page as never, "tasks.list", { serverId })).map(
          (t) => t.state,
        ),
      )
      .toEqual(["cancelled"])
  } finally {
    await restarted?.app.close().catch(() => {})
    await one.app.close().catch(() => {})
    await s.two.app.close().catch(() => {})
    await s.mock.close()
  }
})
