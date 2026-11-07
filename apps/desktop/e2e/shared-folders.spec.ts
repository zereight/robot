import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 025: file claims between workflows that use one folder.

test.setTimeout(90_000)

type Invoke = (method: string, input?: unknown) => Promise<{ ok: boolean; value?: unknown }>

/** Makes the account and two workflows with one text node each, as the window would. */
const makeFlows = (page: Page, openaiUrl: string) =>
  page.evaluate(
    async ({ openaiUrl, key }) => {
      const invoke = (window as unknown as { robot: { invoke: Invoke } }).robot.invoke
      const call = async (method: string, input?: unknown) => {
        const result = await invoke(method, input)
        if (!result.ok) throw new Error(`${method}: ${JSON.stringify(result)}`)
        return result.value as never
      }
      const servers = (await call("servers.list")) as { id: string; kind: string }[]
      const serverId = servers.find((s) => s.kind === "local")?.id
      await call("providers.connect", {
        kind: "openai",
        name: "Mock",
        baseUrl: openaiUrl,
        apiKey: key,
      })
      const account = ((await call("providers.list")) as { id: string }[])[0]
      const make = async (name: string, level: string, prompt: string) => {
        const flow = (await call("workflows.create", { serverId, name })) as { id: string }
        await call("workflows.setPermission", { id: flow.id, level })
        await call("workflows.node.add", {
          workflowId: flow.id,
          node: {
            kind: "text",
            name: "Write notes",
            prompt,
            accountId: account?.id,
            model: "mock-fast",
            x: 24,
            y: 24,
          },
        })
        return flow.id
      }
      // Weekly report writes notes.md twice at "Ask for everything": the second card waits, so its
      // task holds the claim. Notes writes the file once, and has no card at "Ask for risky steps".
      const a = await make(
        "Weekly report",
        "ask_all",
        'tools 2 write_file {"path":"notes.md","content":"from Weekly report"}',
      )
      const b = await make(
        "Notes",
        "ask_risky",
        'tool write_file {"path":"notes.md","content":"from Notes"}',
      )
      const c = await make("Alone", "ask_risky", "hello")
      return { a, b, c }
    },
    { openaiUrl, key: GOOD_KEY },
  )

const openWorkflow = async (page: Page, name: string) => {
  await page
    .getByTestId("workflow-row")
    .filter({ hasText: name })
    .getByTestId("workflow-open")
    .click()
  await expect(page.getByTestId("workflow-view")).toBeVisible()
}

const pickFolder = async (page: Page, name: string) => {
  await openWorkflow(page, name)
  await page.getByTestId("tab-settings").click()
  await page.getByTestId("workflow-folder-pick").click()
}

test("shared folder: the editor says so, a held file is refused with no card, a read is not, and the claim ends with the task", async () => {
  const mock = await startMockProvider()
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "robot-shared-e2e-")))
  mkdirSync(folder, { recursive: true })
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_TEST_PICK_FOLDER: folder,
  })
  await resizeWindow(app, 1200, 900)
  await page.getByTestId("new-workflow-empty").waitFor()
  const ids = await makeFlows(page, mock.openaiUrl)
  await page.getByTestId("page-workflows").click()
  await page.getByTestId("workflows-page").waitFor()
  // The first workflow that the empty state made has the default folder like the others: delete it
  // is not needed, the page lists all of them.

  // Default folders: no line "Shares this folder" in the editor.
  await openWorkflow(page, "Weekly report")
  await page.getByTestId("tab-settings").click()
  await expect(page.getByTestId("workflow-folder")).toBeVisible()
  await expect(page.getByTestId("workflow-shared")).toHaveCount(0)
  await page.getByTestId("workflow-back").click()

  // Weekly report picks the folder: it is alone in it, so no line shows.
  await pickFolder(page, "Weekly report")
  await expect(page.getByTestId("workflow-folder")).toHaveText(folder)
  await expect(page.getByTestId("workflow-shared")).toHaveCount(0)
  await page.getByTestId("workflow-back").click()

  // Notes picks the same folder: the editor of Notes says that it shares the folder with Weekly
  // report, as a muted line, and the user can save (the folder is already set).
  await pickFolder(page, "Notes")
  await expect(page.getByTestId("workflow-shared")).toHaveText(
    "Shares this folder with Weekly report.",
  )
  await expect(page.getByTestId("workflow-shared")).not.toHaveAttribute("role", "alert")
  await shot(page, "b8-01-shares-folder")
  await page.getByTestId("workflow-back").click()
  // The editor of Weekly report names Notes, and Alone (default folder) has no line.
  await openWorkflow(page, "Weekly report")
  await page.getByTestId("tab-settings").click()
  await expect(page.getByTestId("workflow-shared")).toHaveText("Shares this folder with Notes.")
  await page.getByTestId("workflow-back").click()
  await openWorkflow(page, "Alone")
  await page.getByTestId("tab-settings").click()
  await expect(page.getByTestId("workflow-shared")).toHaveCount(0)
  await page.getByTestId("workflow-back").click()

  // A task of Weekly report writes notes.md and waits on its second card: it holds the claim.
  await openWorkflow(page, "Weekly report")
  await page.getByTestId("tab-runs").click()
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("card-approval")).toBeVisible()
  await page.getByTestId("card-allow").click()
  await expect(page.getByTestId("run-state")).toHaveText("Waiting for you")
  await expect(page.getByTestId("card-approval")).toBeVisible()
  await expect(page.getByTestId("run-node-claims-1")).toContainText("Holds 1 file claim")
  await page.getByTestId("run-node-claims-1").locator("summary").click()
  await expect(page.getByTestId("run-node-claims-1")).toContainText(join(folder, "notes.md"))
  expect(readFileSync(join(folder, "notes.md"), "utf8")).toBe("from Weekly report")
  await shot(page, "b8-02-claim-held")
  await page.getByTestId("workflow-back").click()

  // A task of Notes tries to write notes.md: refused, no card, the file keeps the text of the holder.
  await openWorkflow(page, "Notes")
  await page.getByTestId("tab-runs").click()
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-refused-line")).toHaveText(
    `Refused: in use by Weekly report: ${join(folder, "notes.md")}`,
  )
  await expect(page.getByTestId("run-node-result-1")).toContainText(
    "Refused: in use by Weekly report",
  )
  await expect(page.getByTestId("run-node-result-1")).toContainText('"Write notes"')
  await expect(page.getByTestId("card-approval")).toHaveCount(0)
  expect(readFileSync(join(folder, "notes.md"), "utf8")).toBe("from Weekly report")
  await shot(page, "b8-03-refused")
  // The action log has the step, with the result Refused and the shared folder as the one who decided.
  await page.getByTestId("workflow-back").click()
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-permissions").click()
  const entry = page.getByTestId("action-log-entry").filter({ hasText: "Shared folder" })
  await expect(entry).toContainText("Refused")
  await expect(entry).toContainText("In use by Weekly report")
  await page.getByTestId("settings-close").click()

  // The task of Weekly report ends: Notes writes the file again and it runs.
  await openWorkflow(page, "Weekly report")
  await page.getByTestId("tab-runs").click()
  await page.getByTestId("runs-list").locator("button").first().click()
  await page.getByTestId("card-allow").click()
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-node-claims-1")).toHaveCount(0)
  await page.getByTestId("workflow-back").click()
  await openWorkflow(page, "Notes")
  await page.getByTestId("tab-runs").click()
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  await expect(page.getByTestId("run-refused-line")).toHaveCount(0)
  expect(readFileSync(join(folder, "notes.md"), "utf8")).toBe("from Notes")
  expect(ids.a).not.toBe(ids.b)

  // Korean words.
  await page.evaluate(async () => {
    const invoke = (window as unknown as { robot: { invoke: Invoke } }).robot.invoke
    await invoke("settings.update", { language: "ko" })
  })
  await page.getByTestId("workflow-back").click()
  await openWorkflow(page, "Weekly report")
  await page.getByTestId("tab-settings").click()
  await expect(page.getByTestId("workflow-shared")).toHaveText(
    "이 폴더를 Notes 워크플로우와 함께 써요.",
  )
  await shot(page, "b8-04-shares-folder-ko")
  await app.close()
  await mock.close()
})
