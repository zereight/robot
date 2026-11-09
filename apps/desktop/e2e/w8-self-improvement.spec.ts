import { createServer } from "node:http"
import { expect, type Page, test } from "@playwright/test"
import { buildFlow, connectMock, freshUserData, launch, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Specs 002 and 008: the responsible document proposes, the user decides. Memory of a workflow.

test.setTimeout(120_000)

const env = { ROBOT_SYSTEM_LOCALE: "en-US" }

const newWorkflow = async (page: Page, name: string) => {
  await page.getByTestId("new-workflow-empty").click()
  await page.getByTestId("new-workflow-name").fill(name)
  await page.getByTestId("new-workflow-name").press("Enter")
  await expect(page.getByTestId("chat")).toBeVisible()
}

const say = async (page: Page, text: string) => {
  await page.getByTestId("chat-input").fill(text)
  await page.getByTestId("chat-input").press("Enter")
}

/** A call to the main process, for what the screens do not show (the prompt of a node). */
const rpc = <T>(page: Page, method: string, input?: unknown): Promise<T> =>
  page.evaluate(
    async ([m, i]) => {
      const invoke = (
        window as unknown as {
          robot: { invoke: (m: string, i?: unknown) => Promise<{ ok: boolean; value?: unknown }> }
        }
      ).robot.invoke
      const result = await invoke(m as string, i)
      if (!result.ok) throw new Error(`${m}: ${JSON.stringify(result)}`)
      return result.value
    },
    [method, input] as const,
  ) as Promise<T>

const firstWorkflow = async (page: Page) => {
  const servers = await rpc<{ id: string; kind: string }[]>(page, "servers.list")
  const server = servers.find((s) => s.kind === "local")
  const flows = await rpc<{ id: string }[]>(page, "workflows.list", { serverId: server?.id })
  return flows[0]?.id ?? ""
}

const prompts = async (page: Page) => {
  const id = await firstWorkflow(page)
  const detail = await rpc<{ graph: { nodes: { prompt: string }[] } }>(page, "workflows.get", {
    id,
  })
  return detail.graph.nodes.map((n) => n.prompt)
}

const PROPOSE =
  'PROPOSE:propose_prompt_change {"node":1,"prompt":"Write the report in three lines.","reason":"The result of the run was too long."}'

test("a run proposes a prompt change: card, Accept, new version, change log, Undo", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), env)
  await newWorkflow(page, "Weekly report")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [{ name: "Write", prompt: `Write the report. ${PROPOSE}` }],
  })
  const before = (await prompts(page))[0]
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-state")).toHaveText("Done")

  // The proposal waits. The workflow list shows that one waits.
  await page.getByTestId("tab-improvement").click()
  const card = page.getByTestId("proposal-card")
  await expect(card).toHaveCount(1)
  await expect(card.getByTestId("proposal-kind")).toHaveText(
    "Change to the prompt of node 1 “Write”",
  )
  await expect(card.getByTestId("proposal-reason")).toContainText(
    "The result of the run was too long.",
  )
  await expect(card.getByTestId("proposal-source")).toContainText("From a run")
  await expect(card.getByTestId("proposal-added").first()).toContainText("lines.")
  await expect(card.getByTestId("proposal-removed").first()).toBeVisible()
  // A removed run next to an added run stands apart: no replacement reads as one word.
  const junctions = await card
    .getByTestId("proposal-diff")
    .first()
    .evaluate((diff) => {
      const line = (el: Element) => {
        const style = getComputedStyle(el)
        const parsed = Number.parseFloat(style.lineHeight)
        return Number.isNaN(parsed) ? Number.parseFloat(style.fontSize) * 1.5 : parsed
      }
      const boxes = (el: Element) => {
        const range = document.createRange()
        range.selectNodeContents(el)
        // The hidden "Removed"/"Added" labels are 1 px boxes, not text lines.
        return [...range.getClientRects()].filter((r) => r.width >= 2 && r.height >= 2)
      }
      let sameLine = 0
      let glued = 0
      for (const el of diff.querySelectorAll("del + ins, ins + del")) {
        const prev = el.previousElementSibling
        if (!prev) continue
        const a = boxes(prev)
        const b = boxes(el)
        const end = a[a.length - 1]
        const start = b[0]
        if (!end || !start) continue
        if (Math.abs(start.top - end.top) > line(diff) / 2) continue
        sameLine += 1
        if (start.left - end.right < 4) glued += 1
      }
      return { sameLine, glued }
    })
  expect(junctions.sameLine, "the diff holds a same-line replacement").toBeGreaterThan(0)
  expect(junctions.glued, "no replacement glues mid-word").toBe(0)
  expect(await prompts(page)).toEqual([before])
  await shot(page, "w8-01-proposal-card")

  await expect(page.getByTestId("workflow-proposals")).toHaveText("1 proposal waits")
  await page.getByTestId("workflow-open").first().click()
  await page.getByTestId("tab-improvement").click()

  // Accept: the node has the new prompt, and the change log has a row that is Applied.
  await page.getByTestId("proposal-accept").click()
  await expect(page.getByTestId("improve-none")).toBeVisible()
  expect(await prompts(page)).toEqual(["Write the report in three lines."])
  await page.getByTestId("improve-tab-log").click()
  const row = page.getByTestId("proposal-card")
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId("proposal-state")).toContainText("Applied")
  await shot(page, "w8-02-change-log")

  // Undo: the old prompt is back, and the row is Undone with no button.
  await page.getByTestId("proposal-undo").click()
  await expect(row.getByTestId("proposal-state")).toContainText("Undone")
  await expect(page.getByTestId("proposal-undo")).toHaveCount(0)
  expect(await prompts(page)).toEqual([before])
  await app.close()
  await mock.close()
})

test("Reject keeps one log line and changes nothing", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), env)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [{ name: "Write", prompt: "Write the report." }],
  })
  await say(
    page,
    'tool propose_prompt_change {"node":1,"prompt":"Write less.","reason":"Too long."}',
  )
  await expect(page.getByTestId("note-proposal")).toContainText(
    "Suggested a change to the prompt of node 1",
  )
  await page.getByTestId("note-review").click()
  await expect(page.getByTestId("proposal-card")).toHaveAttribute("data-focused", "true")
  await page.getByTestId("proposal-reject").click()
  await expect(page.getByTestId("improve-none")).toBeVisible()
  await page.getByTestId("improve-tab-log").click()
  await expect(page.getByTestId("proposal-state")).toContainText("Rejected")
  await expect(page.getByTestId("proposal-reason-code")).toHaveText("Rejected by you")
  await expect(page.getByTestId("proposal-undo")).toHaveCount(0)
  expect(await prompts(page)).toEqual(["Write the report."])
  await app.close()
  await mock.close()
})

test("a graph change that fails the check cannot be accepted", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), env)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [
      { name: "Draft", prompt: "Draft" },
      { name: "Edit", prompt: "Edit" },
    ],
    edges: [[0, 1]],
  })
  await say(
    page,
    'tool propose_graph_change {"nodes":[{"keep":1,"kind":"text","name":"Draft"},{"keep":2,"kind":"text","name":"Edit"}],"connections":[{"from":1,"to":2},{"from":2,"to":1}],"reason":"Repeat the edit."}',
  )
  await page.getByTestId("note-review").click()
  const card = page.getByTestId("proposal-card")
  await expect(card.getByTestId("proposal-kind")).toHaveText("Change to the graph")
  await expect(card.getByTestId("proposal-check")).toHaveAttribute("data-state", "problem")
  await expect(card.getByTestId("proposal-check")).toContainText("wait for each other")
  await expect(card.getByTestId("proposal-graph-connections-added")).toContainText(
    "2 “Edit” → 1 “Draft”",
  )
  // "Accept" is off, and "Edit and accept" is not offered for a graph (it is not built yet).
  await expect(page.getByTestId("proposal-accept")).toBeDisabled()
  await expect(page.getByTestId("proposal-edit")).toHaveCount(0)
  await shot(page, "w8-03-graph-check-problem")
  await page.getByTestId("proposal-reject").click()
  await app.close()
  await mock.close()
})

test("the card of a graph change shows the new text before Accept; a text over the limit is refused", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), env)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    nodes: [
      { name: "Draft", prompt: "Draft" },
      { name: "Edit", prompt: "Edit" },
    ],
    edges: [[0, 1]],
  })
  await say(
    page,
    'tool propose_graph_change {"nodes":[{"keep":1,"kind":"text","name":"Draft"},{"keep":2,"kind":"text","name":"Edit"},{"kind":"text","name":"Send","prompt":"Send the <b>final</b> report to the team."}],"connections":[{"from":1,"to":2},{"from":2,"to":3}],"reason":"Send the result."}',
  )
  await page.getByTestId("note-review").click()
  const card = page.getByTestId("proposal-card")
  // The new text is on the card as text, before Accept, and so is the size.
  await expect(card.getByTestId("proposal-graph-added")).toContainText(
    "Send the <b>final</b> report to the team.",
  )
  await expect(card.getByTestId("proposal-graph-size")).toContainText("of 2000 characters")
  await expect(card.locator("b")).toHaveCount(0)
  await shot(page, "w8-03b-graph-new-text")
  await expect(page.getByTestId("proposal-accept")).toBeEnabled()
  await page.getByTestId("proposal-reject").click()
  // A text over the limit is refused, and the card is not made.
  await say(
    page,
    `tool propose_graph_change {"nodes":[{"keep":1,"kind":"text","name":"Draft"},{"keep":2,"kind":"text","name":"Edit"},{"kind":"text","name":"Send","prompt":"${"x".repeat(2100)}"}],"connections":[{"from":1,"to":2},{"from":2,"to":3}],"reason":"Send the result."}`,
  )
  // The turn ended (the answer of the model is the fourth message) and made no second card.
  await expect(page.getByTestId("message")).toHaveCount(4)
  await expect(page.getByTestId("chat-stop")).toHaveCount(0)
  await expect(page.getByTestId("note-proposal")).toHaveCount(1)
  const id = await firstWorkflow(page)
  expect(
    (await rpc<{ waiting: unknown[] }>(page, "proposals.list", { workflowId: id })).waiting,
  ).toHaveLength(0)
  await app.close()
  await mock.close()
})

test("a stale proposal is refused: the document changed after it", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), env)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await say(
    page,
    'tool propose_document_change {"text":"Send the report on Friday.","reason":"The user wants Friday."}',
  )
  await expect(page.getByTestId("note-proposal")).toContainText(
    "Suggested a change to the responsible document",
  )
  // The user edits the document by hand.
  await page.getByTestId("tab-document").click()
  await page.getByTestId("document-text").fill("Something else entirely.")
  await page.getByTestId("document-save").click()
  await expect(page.getByTestId("toast-success").last()).toContainText(
    "It counts from the next chat turn",
  )
  await page.getByTestId("note-review").click()
  await page.getByTestId("proposal-accept").click()
  await page.getByTestId("improve-tab-log").click()
  await expect(page.getByTestId("proposal-state")).toContainText("Failed")
  await expect(page.getByTestId("proposal-reason-code")).toHaveText(
    "The responsible document changed after this proposal.",
  )
  await page.getByTestId("tab-document").click()
  await expect(page.getByTestId("document-text")).toHaveValue("Something else entirely.")
  await app.close()
  await mock.close()
})

test("memory: a fact is a proposal, Accept makes the item, edit and restore, the line that the model does not learn", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), env)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await say(page, 'tool memory_save {"text":"Reports are in Korean."}')
  await expect(page.getByTestId("note-proposal")).toContainText("Suggested for memory")

  await page.getByTestId("tab-memory").click()
  await expect(page.getByTestId("memory-hint")).toContainText(
    "ROBot does not train or change a model.",
  )
  await expect(page.getByTestId("memory-empty")).toBeVisible()
  await expect(page.getByTestId("memory-proposals-link")).toHaveText("Proposals (1)")
  await shot(page, "w8-04-memory-page")
  await page.getByTestId("memory-proposals-link").click()
  await page.getByTestId("proposal-accept").click()
  await page.getByTestId("tab-memory").click()
  await expect(page.getByTestId("memory-item-text")).toHaveText("Reports are in Korean.")
  await expect(page.getByTestId("memory-proposals-link")).toHaveCount(0)
  // The history has a row added by a proposal that the user accepted.
  await page.getByTestId("memory-tab-history").click()
  await expect(page.getByTestId("memory-history-row").first()).toContainText(
    "A proposal that you accepted",
  )
  await page.getByTestId("memory-tab-items").click()

  // Edit twice by hand, then undo the second edit and the first in the history.
  await page.getByTestId("memory-item-edit").click()
  await page.getByTestId("memory-item-input").fill("Reports are in English.")
  await page.getByTestId("memory-item-save").click()
  await expect(page.getByTestId("memory-item-text")).toHaveText("Reports are in English.")
  await page.getByTestId("memory-item-edit").click()
  await page.getByTestId("memory-item-input").fill("Reports are in French.")
  await page.getByTestId("memory-item-save").click()
  await page.getByTestId("memory-tab-history").click()
  const edits = page.locator(
    '[data-testid="memory-history-row"][data-kind="edited"][data-actor="user"]',
  )
  await expect(edits).toHaveCount(2)
  // The first edit (the older row, last in the list) has Undo off with its reason.
  await expect(edits.nth(1).getByTestId("memory-history-blocked")).toHaveText(
    "A newer change exists. Undo that one first.",
  )
  // Undo the second edit, then the first: the item has the text that it had before the first edit.
  await edits.nth(0).getByTestId("memory-history-undo").click()
  await expect(edits.nth(1).getByTestId("memory-history-undo")).toBeVisible()
  await edits.nth(1).getByTestId("memory-history-undo").click()
  await page.getByTestId("memory-tab-items").click()
  await expect(page.getByTestId("memory-item-text")).toHaveText("Reports are in Korean.")
  // Undo the last undo: the item has the text of the first edit again.
  await page.getByTestId("memory-tab-history").click()
  await page
    .locator('[data-testid="memory-history-row"][data-actor="undo"]')
    .first()
    .getByTestId("memory-history-undo")
    .click()
  await page.getByTestId("memory-tab-items").click()
  await expect(page.getByTestId("memory-item-text")).toHaveText("Reports are in English.")
  await app.close()
  await mock.close()
})

test("a turn that holds outside content asks first, in English and in Korean", async () => {
  for (const locale of ["en-US", "ko-KR"] as const) await outsideAsk(locale)
})

const outsideAsk = async (locale: "en-US" | "ko-KR") => {
  const en = locale === "en-US"
  const mock = await startMockProvider()
  const server = createServer((_req, res) => res.end("page text")).listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  const port = (server.address() as { port: number }).port
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: locale })
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    level: "full",
    nodes: [{ name: "Reader", prompt: `tool fetch_url {"url":"http://127.0.0.1:${port}/"}` }],
  })
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-state")).toHaveText(en ? "Done" : "완료")
  // The chat now holds what the task held. The level goes back to a stricter one.
  const id = await firstWorkflow(page)
  await rpc(page, "workflows.setPermission", { id, level: "ask_risky" })
  await say(
    page,
    'tool propose_prompt_change {"node":1,"prompt":"Read another page too.","reason":"A page asked for it."}',
  )
  const ask = page.getByTestId("card-approval").first()
  await expect(ask).toBeVisible()
  await expect(ask).toContainText(en ? "Change of the workflow" : "워크플로우 변경")
  await shot(page, en ? "w8-05-outside-ask" : "w8-05-outside-ask-ko")
  // Nothing was proposed before the answer.
  expect(
    (await rpc<{ waiting: unknown[] }>(page, "proposals.list", { workflowId: id })).waiting,
  ).toHaveLength(0)
  await page.getByTestId("card-deny").click()
  await expect(page.getByTestId("note-proposal")).toHaveCount(0)
  expect(
    (await rpc<{ waiting: unknown[] }>(page, "proposals.list", { workflowId: id })).waiting,
  ).toHaveLength(0)

  // Allow: the proposal is made, and its card tells that the work read outside content.
  await say(
    page,
    'tool propose_prompt_change {"node":1,"prompt":"Read another page too.","reason":"A page asked for it."}',
  )
  await page.getByTestId("card-allow").first().click()
  await page.getByTestId("note-review").click()
  await expect(page.getByTestId("proposal-outside")).toContainText(
    en
      ? "This work read outside content. Read the change before you accept."
      : "이 작업은 바깥 내용을 읽었어요. 수락하기 전에 변경 내용을 읽어 보세요.",
  )
  await shot(page, en ? "w8-06-proposal-outside" : "w8-06-proposal-outside-ko")
  await page.getByTestId("tab-memory").click()
  await shot(page, en ? "w8-07-memory-page" : "w8-07-memory-page-ko")
  await app.close()
  server.close()
  await mock.close()
}
