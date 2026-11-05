import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { join, resolve } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow } from "../harness.ts"
import { GOOD_KEY, startMockProvider } from "../mock-provider.ts"
import { freeNearbyPort, freePortPair } from "../ports.ts"
import { rpc } from "../sync-helpers.ts"

// The computer of the end-to-end run of the screen "Org chart" on the phone (spec 029, 011). It is
// the host of phone-host.ts with a team: four agents (Ada leads the organization "Docs", Bo has a long
// role line, Dee is in no organization), an organization "Team" with 14 members, and one hand-off from Bo to
// Cy. Set PHONE_E2E_HOST=phone-org-host.ts to use it. The phone flow drives the computer through
// a small control address (CONTROL in the host file): it starts a long task, stops it, and turns
// "Let other devices connect" off and on. The computer writes when each step happened, so that the
// run can say how long the phone needed to show a task that started on the computer.

const dir = resolve(
  process.env.PHONE_E2E_DIR ?? resolve(import.meta.dirname, "../../../../build/e2e/phone"),
)
const hostFile = join(dir, "host.json")
const doneFile = join(dir, "done")
const timingFile = join(dir, "org-timing.json")

const shot = (page: Page, name: string) => page.screenshot({ path: join(dir, `${name}.png`) })

/** The stand-in model answers "run long" in about 30 seconds. The label is cut at 90 characters. */
const LONG_WORK =
  "Draft the release notes for the next big version of the app and check every link in them (run long)"
const LONG_ROLE = "Writes the first draft of every article and keeps the style guide current"
/** A name and a role line that do not fit on one line of a phone (the step "long-names"). */
const LONG_NAME = "Ada Lovelace the Analytical Programmer"
const LONG_ROLE_2 =
  "Plans the work of the whole channel, splits each request into parts, and checks every part against its done test"

interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}

test("a computer for the phone app, with an org chart", async () => {
  test.setTimeout(30 * 60_000)
  mkdirSync(dir, { recursive: true })
  const [port] = await freePortPair()
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_LINK_ADDRESSES: "127.0.0.1",
    ROBOT_LINK_PORT: String(port),
    ROBOT_LINK_NEARBY_PORT: String(await freeNearbyPort()),
  })
  const timing: Record<string, number> = {}
  const control = createServer((req, res) => {
    const step = (req.url ?? "").replace(/^\//, "")
    void (async () => {
      const agents = await rpc<AgentInfo[]>(page, "agents.list", {
        serverId: (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id,
        archived: false,
      })
      const bo = agents.find((a) => a.name === "Bo")?.id
      if (step === "start-task") {
        // Bo starts a long task, unless it works already (the stand-in model ends it after about
        // 30 seconds, and a flow that runs long calls this step again). The time is taken before
        // the request, so the run measures the whole way: the computer, the link, the phone, and
        // the look of the phone.
        const snapshot = await rpc<{ agents: { id: string; state: string }[] }>(
          page,
          "orgChart.get",
        )
        if (snapshot.agents.find((a) => a.id === bo)?.state !== "working") {
          timing.startedAt = Date.now()
          await rpc(page, "chat.send", { agentId: bo, text: LONG_WORK, replyTo: null })
          timing.sentAt = Date.now()
        }
      } else if (step === "seen") {
        timing.seenAt = Date.now()
        timing.fromStartMs = timing.seenAt - (timing.startedAt ?? timing.seenAt)
        writeFileSync(timingFile, JSON.stringify(timing, null, 2))
      } else if (step === "ask-approval") {
        // Cy asks to run a command that needs the user: its task waits for the user.
        const cy = agents.find((a) => a.name === "Cy")?.id
        await rpc(page, "chat.send", {
          agentId: cy,
          text: `TOOL run_command ${JSON.stringify({ command: "rm /tmp/robot-org-chart-e2e-old.txt" })}`,
          replyTo: null,
        })
      } else if (step === "long-names") {
        const ada = agents.find((a) => a.name === "Ada" || a.name === LONG_NAME)?.id
        await rpc(page, "agents.update", {
          id: ada,
          patch: { name: LONG_NAME, role: LONG_ROLE_2 },
        })
      } else if (step === "stop-task") {
        for (const name of ["Bo", "Cy"]) {
          const id = agents.find((a) => a.name === name)?.id
          if (id) await rpc(page, "chat.stop", { agentId: id }).catch(() => undefined)
        }
      } else if (step === "server-off") {
        await rpc(page, "devices.update", { accept: false })
      } else if (step === "server-on") {
        await rpc(page, "devices.update", { accept: true })
      }
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ ok: true, step, timing }))
    })().catch((error: unknown) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise<void>((ok) => control.listen(0, "127.0.0.1", ok))
  const controlUrl = `http://127.0.0.1:${(control.address() as AddressInfo).port}`
  try {
    await resizeWindow(app, 1200, 860)
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await createAgent(page, "Ada")
    const server = (await rpc<{ id: string }[]>(page, "servers.list"))[0]?.id as string
    const list = () => rpc<AgentInfo[]>(page, "agents.list", { serverId: server, archived: false })
    const template = (await list())[0] as AgentInfo
    const make = (name: string, role: string) =>
      rpc(page, "agents.create", {
        serverId: server,
        name,
        role,
        instructions: "",
        model: template.model,
      })
    await make("Bo", LONG_ROLE)
    await make("Cy", "Checks facts")
    await make("Dee", "Keeps the calendar")
    const team = Array.from({ length: 12 }, (_, i) => `Team ${String(i + 1).padStart(2, "0")}`)
    for (const name of team) await make(name, "")
    const idOf = async (name: string) => (await list()).find((a) => a.name === name)?.id as string
    const [ada, bo, cy] = await Promise.all(["Ada", "Bo", "Cy"].map(idOf))
    await rpc(page, "organizations.create", {
      serverId: server,
      name: "Docs",
      memberIds: [ada, bo, cy],
      leadId: ada,
    })
    // "Team" has 14 members, so the phone shows 12 rows and the row "+2 more".
    await rpc(page, "organizations.create", {
      serverId: server,
      name: "Team",
      memberIds: [ada, bo, ...(await Promise.all(team.map(idOf)))],
      leadId: null,
    })
    // One hand-off: Bo sends a message to Cy with the tool "send message".
    await rpc(page, "chat.send", {
      agentId: bo,
      text: 'TOOL send_message {"to":"Cy","text":"Please check the facts"}',
      replyTo: null,
    })
    await expect
      .poll(
        async () =>
          (await rpc<{ source: string; state: string }[]>(page, "tasks.list", { serverId: server }))
            .filter((t) => t.source === "agent")
            .map((t) => t.state)
            .sort()
            .join(","),
        { timeout: 30_000 },
      )
      .toBe("done,done")

    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-devices").click()
    await page.getByTestId("device-name").fill("MacBook")
    await page.getByTestId("device-name").press("Enter")
    await page.getByTestId("pair-open").click()
    const turnOn = page.getByTestId("pair-turn-on")
    if (await turnOn.isVisible().catch(() => false)) await turnOn.click()
    await expect(page.getByTestId("pair-code")).toHaveAttribute("data-code", /^\d{6}$/)
    const code = (await page.getByTestId("pair-code").getAttribute("data-code")) ?? ""
    writeFileSync(
      hostFile,
      JSON.stringify({ address: `127.0.0.1:${port}`, code, control: controlUrl }),
    )
    await shot(page, "desktop-01-pairing-code")

    await expect(page.getByTestId("join-dialog")).toBeVisible({ timeout: 10 * 60_000 })
    await page.getByTestId("join-allow").click()
    await expect(page.getByTestId("pair-ended")).toBeVisible()
    await page.getByTestId("pair-close").click()
    await expect(page.locator('[data-testid=client-row][data-name="iPhone of Kim"]')).toBeVisible()
    await page.getByTestId("settings-close").click()
    await expect(page.getByTestId("settings")).toBeHidden()

    // The org chart page of this computer shows what the phone shows, for the screenshots.
    await page.getByTestId("page-orgchart").click()
    await expect(page.getByTestId("org-canvas")).toBeVisible()
    await shot(page, "desktop-02-org-chart")
    while (!existsSync(doneFile)) await page.waitForTimeout(500)
    await shot(page, "desktop-03-org-chart-after")
  } finally {
    control.close()
    await app.close()
    await mock.close()
  }
})
