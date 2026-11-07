import { mkdtempSync, readFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, type Page, test } from "@playwright/test"
import { buildFlow, connectMock, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Spec 003 (folded tool steps, mark as unread, edit of the last message, message links, send once),
// spec 013 (the switch "Show tool steps", the controls of General) and spec 001 (the keys that the
// Help page lists). The model is a stand-in that makes the tool call that the message names.

test.setTimeout(120_000)

const en = { ROBOT_SYSTEM_LOCALE: "en-US" }
const ko = { ROBOT_SYSTEM_LOCALE: "ko-KR" }

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

/** Waits until no reply streams and no turn works. */
const settled = async (page: Page) => {
  await expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0, {
    timeout: 15_000,
  })
  await expect(page.getByTestId("working-line")).toHaveCount(0)
}

const openAppearance = async (page: Page) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
}

/** Turns "Show tool steps" on or off in Settings, and closes Settings. */
const showToolSteps = async (page: Page, on: boolean) => {
  await openAppearance(page)
  const box = page.getByTestId("setting-show-tool-steps")
  if ((await box.getAttribute("aria-checked")) !== String(on)) await box.click()
  await expect(box).toHaveAttribute("aria-checked", String(on))
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings")).toHaveCount(0)
}

const visibleCards = (page: Page) => page.locator('[data-testid="tool-card"]:visible')

test("tool steps: the switch folds finished steps into one line, which opens by click and key", async () => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  let { app, page } = await launch(userData, en)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")

  // On at first: two finished steps in one reply show as two cards.
  await say(page, "tools 2 read_workflow {}")
  await expect(page.getByTestId("message-text").last()).toContainText("Tool said")
  await settled(page)
  await expect(visibleCards(page)).toHaveCount(2)
  await expect(page.getByTestId("tools-folded")).toHaveCount(0)
  await shot(page, "b4-01-cards")

  // Off: the series folds into one muted line with the count. It changes the chat at once.
  await showToolSteps(page, false)
  await expect(page.getByTestId("tools-folded-line")).toHaveText("2 tool steps")
  await expect(page.getByTestId("tools-folded")).toHaveCount(1)
  await expect(visibleCards(page)).toHaveCount(0)
  await shot(page, "b4-02-folded")

  // A click opens the line, and a click closes it.
  await page.getByTestId("tools-folded-line").click()
  await expect(visibleCards(page)).toHaveCount(2)
  await page.getByTestId("tools-folded-line").click()
  await expect(visibleCards(page)).toHaveCount(0)

  // The keyboard works: the line takes the focus, Enter opens it, Space closes it.
  await page.getByTestId("tools-folded-line").focus()
  await page.keyboard.press("Enter")
  await expect(visibleCards(page)).toHaveCount(2)
  await expect(page.getByTestId("tools-folded")).toHaveAttribute("open", "")
  await page.keyboard.press("Space")
  await expect(visibleCards(page)).toHaveCount(0)
  await page.keyboard.press("Enter")
  await expect(visibleCards(page)).toHaveCount(2)
  await shot(page, "b4-03-open")

  // A change of the theme draws the chat again. The line that the user opened stays open.
  await openAppearance(page)
  await page.getByTestId("setting-theme").locator('label[data-value="dark"]').click()
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark")
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("tools-folded")).toHaveAttribute("open", "")
  await expect(visibleCards(page)).toHaveCount(2)
  await shot(page, "b4-04-open-dark")

  // The switch keeps its state after a restart.
  await app.close()
  ;({ app, page } = await launch(userData, en))
  await expect(page.getByTestId("tools-folded-line")).toHaveText("2 tool steps")
  await openAppearance(page)
  await expect(page.getByTestId("setting-show-tool-steps")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("settings-close").click()

  // On again: the cards show with no folded line.
  await showToolSteps(page, true)
  await expect(page.getByTestId("tools-folded")).toHaveCount(0)
  await expect(visibleCards(page)).toHaveCount(2)

  await app.close()
  await mock.close()
})

test("tool steps: a text between two steps splits the series, and a failed step stays a card", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), en)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await showToolSteps(page, false)

  // A text between two finished reads: two lines with the count 1 each.
  await say(page, "split 2 read_workflow {}")
  await expect(page.getByTestId("message-text").last()).toContainText("Tool said")
  await settled(page)
  await expect(page.getByTestId("tools-folded-line")).toHaveText(["1 tool step", "1 tool step"])
  await expect(visibleCards(page)).toHaveCount(0)
  await shot(page, "b4-05-split")

  // With the switch on, the cards show with no line.
  await showToolSteps(page, true)
  await expect(page.getByTestId("tools-folded")).toHaveCount(0)
  await expect(visibleCards(page)).toHaveCount(2)
  await app.close()
  await mock.close()
})

test("tool steps: a failed step shows as a card with the switch off", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), en)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await showToolSteps(page, false)
  await say(page, 'tools 2 edit_node {"node":1,"model":"no-such-model"}')
  await expect(page.getByTestId("message-text").last()).toContainText("Tool said")
  await settled(page)
  await expect(page.getByTestId("tools-folded")).toHaveCount(0)
  await expect(visibleCards(page)).toHaveCount(2)
  await expect(visibleCards(page).first()).toHaveAttribute("data-state", "failed")
  await shot(page, "b4-06-failed-stays-a-card")
  await app.close()
  await mock.close()
})

test("tool steps: a step that waits for an approval stays a card with the switch off, and so after the answer", async () => {
  const mock = await startMockProvider()
  // A page that the run reads: the chat then holds outside content and asks before it changes.
  const server = createServer((_req, res) => res.end("page text")).listen(0, "127.0.0.1")
  await new Promise((r) => server.once("listening", r))
  const port = (server.address() as { port: number }).port
  const { app, page } = await launch(freshUserData(), en)
  await resizeWindow(app, 1300, 860)
  await newWorkflow(page, "Weekly report")
  await buildFlow(page, {
    provider: { openaiUrl: mock.openaiUrl, key: GOOD_KEY },
    level: "full",
    nodes: [{ name: "Reader", prompt: `tool fetch_url {"url":"http://127.0.0.1:${port}/"}` }],
  })
  await page.getByTestId("workflow-run").click()
  await expect(page.getByTestId("run-state")).toHaveText("Done")
  const id = await page.evaluate(async () => {
    const invoke = (
      window as unknown as {
        robot: { invoke: (m: string, i?: unknown) => Promise<{ value: unknown }> }
      }
    ).robot.invoke
    const servers = (await invoke("servers.list")).value as { id: string; kind: string }[]
    const local = servers.find((s) => s.kind === "local")
    return ((await invoke("workflows.list", { serverId: local?.id })).value as { id: string }[])[0]
      ?.id
  })
  await page.evaluate(
    (flow) =>
      (
        window as unknown as { robot: { invoke: (m: string, i?: unknown) => Promise<unknown> } }
      ).robot.invoke("workflows.setPermission", { id: flow, level: "ask_risky" }),
    id,
  )
  await showToolSteps(page, false)

  await say(page, 'tool add_node {"kind":"text","name":"Send","prompt":"Send it."}')
  // The step waits: its card shows, and no folded line holds it.
  await expect(page.getByTestId("card-approval").first()).toBeVisible()
  await expect(visibleCards(page)).toHaveCount(1)
  await expect(visibleCards(page).first()).toHaveAttribute("data-state", "running")
  await expect(page.getByTestId("tools-folded")).toHaveCount(0)
  await shot(page, "b4-14-waiting-step-is-a-card")

  // After the answer the step is a card still: it never goes from a card into a line.
  await page.getByTestId("card-allow").first().click()
  await expect(page.getByTestId("message-text").last()).toContainText("Tool said")
  await settled(page)
  await expect(visibleCards(page)).toHaveCount(1)
  await expect(visibleCards(page).first()).toHaveAttribute("data-state", "done")
  await expect(page.getByTestId("tools-folded")).toHaveCount(0)
  await app.close()
  await mock.close()
  server.close()
})

test("tool steps: the line of the series speaks Korean", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), ko)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "주간 보고")
  await showToolSteps(page, false)
  await say(page, "tools 2 read_workflow {}")
  await expect(page.getByTestId("message-text").last()).toContainText("Tool said")
  await settled(page)
  await expect(page.getByTestId("tools-folded-line")).toHaveText("도구 단계 2개")
  await openAppearance(page)
  await expect(page.getByTestId("setting-show-tool-steps")).toBeVisible()
  await shot(page, "b4-07-ko-switch")
  await page.getByTestId("settings-close").click()
  await shot(page, "b4-08-ko-folded")
  await app.close()
  await mock.close()
})

test("tool steps: a series keeps its place and its open line while the turn makes steps", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), en)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  await showToolSteps(page, false)

  // The page watches the chat for as long as the turn runs: a card of a step that shows outside the
  // line is a card that goes into the line later, and that moved the reply on every step.
  await page.evaluate(() => {
    const watch = { loose: 0, lines: 0, counts: [] as string[], closed: 0 }
    ;(window as unknown as { __watch: typeof watch }).__watch = watch
    let opened = false
    const look = () => {
      for (const card of document.querySelectorAll('[data-testid="tool-card"]'))
        if (!card.closest('[data-testid="tools-folded"]')) watch.loose++
      const lines = document.querySelectorAll('[data-testid="tools-folded"]')
      watch.lines = Math.max(watch.lines, lines.length)
      const text = document.querySelector('[data-testid="tools-folded-line"]')?.textContent ?? ""
      if (text && watch.counts.at(-1) !== text) watch.counts.push(text)
      const first = lines[0] as HTMLDetailsElement | undefined
      if (first?.open) opened = true
      else if (opened && first) watch.closed++
    }
    new MutationObserver(look).observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    })
  })

  await say(page, "tools 4 read_workflow {}")
  // The line shows with the first step. The user opens it and keeps it open.
  await expect(page.getByTestId("tools-folded-line")).toBeVisible({ timeout: 20_000 })
  await page.getByTestId("tools-folded-line").click()
  await expect(page.getByTestId("tools-folded")).toHaveAttribute("open", "")
  await expect(page.getByTestId("message-text").last()).toContainText("Tool said")
  await settled(page)

  await expect(page.getByTestId("tools-folded-line")).toHaveText("4 tool steps")
  await expect(page.getByTestId("tools-folded")).toHaveAttribute("open", "")
  await expect(visibleCards(page)).toHaveCount(4)
  const watch = await page.evaluate(
    () =>
      (
        window as unknown as {
          __watch: { loose: number; lines: number; counts: string[]; closed: number }
        }
      ).__watch,
  )
  expect(watch.loose).toBe(0)
  expect(watch.lines).toBe(1)
  expect(watch.closed).toBe(0)
  // The count only grows, and it ends at 4.
  const numbers = watch.counts.map((text) => Number.parseInt(text, 10))
  expect(numbers.at(-1)).toBe(4)
  expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
  await shot(page, "b4-09-series-keeps-its-line")

  await app.close()
  await mock.close()
})

/** Text long enough that a few messages fill the chat. */
const long = (label: string) => `${label} ${"budget words go on and on ".repeat(70)}`

test("mark as unread: the count, the place where the chat opens, and the end that clears it", async () => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  let { app, page } = await launch(userData, en)
  await resizeWindow(app, 1300, 800)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")

  // Four turns: eight messages, and the messages 2, 4, 6 and 8 are replies.
  for (const n of [1, 2, 3, 4]) {
    await say(page, long(`turn${n}`))
    await expect(page.getByTestId("message")).toHaveCount(n * 2)
    await settled(page)
  }
  await expect(page.getByTestId("chat-unread")).toHaveCount(0)
  // The action is on a finished reply only: a message of the user has none.
  await page.getByTestId("message").nth(0).hover()
  await expect(page.getByTestId("message").nth(0).getByTestId("message-mark-unread")).toHaveCount(0)

  // Mark the reply of the second turn: it and the two later replies count.
  await page.getByTestId("message").nth(3).hover()
  await page.getByTestId("message").nth(3).getByTestId("message-mark-unread").click()
  await expect(page.getByTestId("chat-unread")).toHaveText("3 unread")
  // The mark does not clear itself while the chat stays where it is: the stored state says 3 too.
  const stored = await page.evaluate(async () => {
    const workflows = await window.robot.invoke("servers.list", undefined)
    if (!workflows.ok) return -1
    const id = await window.robot.invoke("workflows.list", {
      serverId: workflows.value[0]?.id ?? "",
    })
    if (!id.ok) return -1
    const history = await window.robot.invoke("chat.history", { workflowId: id.value[0]?.id ?? "" })
    return history.ok ? history.value.unread.count : -1
  })
  expect(stored).toBe(3)
  await expect(page.getByTestId("chat-unread")).toHaveText("3 unread")
  await shot(page, "b4-10-unread-count")

  // The next time the chat opens, it opens at that message, and the count stays.
  await app.close()
  ;({ app, page } = await launch(userData, en))
  await resizeWindow(app, 1300, 800)
  await expect(page.getByTestId("chat-unread")).toHaveText("3 unread")
  const marked = page.getByTestId("message").nth(3)
  await expect
    .poll(async () => {
      const box = await marked.boundingBox()
      const frame = await page.getByTestId("chat-scroll").boundingBox()
      return box && frame ? Math.abs(box.y - frame.y) : Number.POSITIVE_INFINITY
    })
    .toBeLessThan(40)
  await expect(page.getByTestId("chat-unread")).toHaveText("3 unread")
  await shot(page, "b4-11-opens-at-the-mark")

  // The count goes when the chat shows its latest message.
  await page.getByTestId("chat-scroll").hover()
  await page.mouse.wheel(0, 50_000)
  await expect(page.getByTestId("chat-unread")).toHaveCount(0)
  await shot(page, "b4-12-count-cleared")

  // The count also goes after a restart: it was read.
  await app.close()
  ;({ app, page } = await launch(userData, en))
  await expect(page.getByTestId("message")).toHaveCount(8)
  await expect(page.getByTestId("chat-unread")).toHaveCount(0)

  // Mark the last reply and look at it in Korean.
  await page.getByTestId("message").nth(7).hover()
  await page.getByTestId("message").nth(7).getByTestId("message-mark-unread").click()
  await expect(page.getByTestId("chat-unread")).toHaveText("1 unread")
  await app.close()
  ;({ app, page } = await launch(userData, ko))
  await expect(page.getByTestId("chat-unread")).toHaveText("읽지 않음 1개")
  await page.getByTestId("message").nth(7).hover()
  await expect(
    page.getByTestId("message").nth(7).getByTestId("message-mark-unread"),
  ).toHaveAttribute("aria-label", "읽지 않음으로 표시")
  await shot(page, "b4-13-unread-ko")

  await app.close()
  await mock.close()
})

test("mark as unread: a chat that fits clears its count at once, and typing in the edit box does not", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), en)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")
  const stored = () =>
    page.evaluate(async () => {
      const servers = await window.robot.invoke("servers.list", undefined)
      if (!servers.ok) return -1
      const flows = await window.robot.invoke("workflows.list", {
        serverId: servers.value[0]?.id ?? "",
      })
      if (!flows.ok) return -1
      const h = await window.robot.invoke("chat.history", { workflowId: flows.value[0]?.id ?? "" })
      return h.ok ? h.value.unread.count : -1
    })

  // A short chat: all of it shows, no scroll event can come, and the count must still go.
  await say(page, "short question")
  await expect(page.getByTestId("message-text").nth(1)).toContainText("You said: short question")
  await settled(page)
  const fits = await page
    .getByTestId("chat-scroll")
    .evaluate((el) => el.scrollHeight <= el.clientHeight + 1)
  expect(fits).toBe(true)
  await page.getByTestId("message").nth(1).hover()
  await page.getByTestId("message").nth(1).getByTestId("message-mark-unread").click()
  await expect(page.getByTestId("chat-unread")).toHaveCount(0)
  await expect.poll(stored).toBe(0)
  await shot(page, "b4-15-short-chat-count-clears")

  // A chat that scrolls keeps the count, and typing in the edit box does not clear it, even when a
  // scroll event follows at the end of the chat.
  for (const n of [1, 2, 3]) {
    await say(page, long(`turn${n}`))
    await settled(page)
  }
  const last = page.getByTestId("message").last()
  await last.hover()
  await last.getByTestId("message-mark-unread").click()
  await expect(page.getByTestId("chat-unread")).toHaveText("1 unread")
  const lastUser = page.getByTestId("message").nth(6)
  await lastUser.hover()
  await lastUser.getByTestId("message-edit-open").click()
  await page.getByTestId("message-edit-input").pressSequentially("typing")
  await page.getByTestId("chat-scroll").evaluate((el) => el.dispatchEvent(new Event("scroll")))
  await page.waitForTimeout(300)
  await expect(page.getByTestId("chat-unread")).toHaveText("1 unread")
  expect(await stored()).toBe(1)
  await page.getByTestId("message-edit-input").press("Escape")

  await app.close()
  await mock.close()
})

test("edit: the last message changes, the replies go, and the model answers again", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), en)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")

  await say(page, "first question")
  await expect(page.getByTestId("message-text").nth(1)).toContainText("You said: first question")
  await settled(page)
  await say(page, "second question")
  await expect(page.getByTestId("message-text").nth(3)).toContainText("You said: second question")
  await settled(page)

  // Only the last message of the user has Edit.
  await page.getByTestId("message").nth(0).hover()
  await expect(page.getByTestId("message").nth(0).getByTestId("message-edit-open")).toHaveCount(0)
  await page.getByTestId("message").nth(2).hover()
  await expect(page.getByTestId("message").nth(3).getByTestId("message-edit-open")).toHaveCount(0)
  await page.getByTestId("message").nth(2).getByTestId("message-edit-open").click()
  await expect(page.getByTestId("message-edit-input")).toHaveValue("second question")
  await shot(page, "b4-20-edit-open")

  // Escape cancels and changes nothing.
  await page.getByTestId("message-edit-input").press("Escape")
  await expect(page.getByTestId("message-edit")).toHaveCount(0)
  await expect(page.getByTestId("message-text").nth(2)).toHaveText("second question")

  // A new text, saved with Enter: the reply after it goes and the model answers the new text.
  const before = mock.requests.length
  await page.getByTestId("message").nth(2).hover()
  await page.getByTestId("message").nth(2).getByTestId("message-edit-open").click()
  await page.getByTestId("message-edit-input").fill("second question, but shorter")
  await page.getByTestId("message-edit-input").press("Enter")
  await expect(page.getByTestId("message-edit")).toHaveCount(0)
  await expect(page.getByTestId("message")).toHaveCount(4)
  await expect(page.getByTestId("message-text").nth(2)).toHaveText("second question, but shorter")
  await expect(page.getByTestId("message-text").nth(3)).toContainText(
    "You said: second question, but shorter",
  )
  await settled(page)
  const sent = mock.requests.slice(before).map((r) => JSON.stringify(r.body.messages))
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain("second question, but shorter")
  expect(sent[0]).not.toContain('"second question"')
  await shot(page, "b4-21-edited")

  // While a turn works there is no Edit.
  await say(page, "slow please")
  await expect(page.getByTestId("working-line")).toBeVisible()
  await page.getByTestId("message").nth(4).hover()
  await expect(page.getByTestId("message-edit-open")).toHaveCount(0)
  await page.getByTestId("chat-stop").click()
  await settled(page)

  // After a step ran, Edit is gone, and the app refuses it when it is asked anyway.
  await say(page, "tool read_workflow {}")
  await expect(page.getByTestId("message-text").last()).toContainText("Tool said")
  await settled(page)
  const count = await page.getByTestId("message").count()
  const last = page.getByTestId("message").nth(count - 2)
  await last.hover()
  await expect(page.getByTestId("message-edit-open")).toHaveCount(0)
  const id = await last.getAttribute("data-message-id")
  const refused = await page.evaluate(
    (messageId) => window.robot.invoke("chat.edit", { id: messageId ?? "", text: "x" }),
    id,
  )
  expect(refused).toMatchObject({ ok: false, error: { code: "edit_steps_ran" } })
  await expect(page.getByTestId("message")).toHaveCount(count)

  await app.close()
  await mock.close()
})

test("the Help page lists the keys that work, and the settings controls keep their state", async () => {
  const mock = await startMockProvider()
  const userData = freshUserData()
  let { app, page } = await launch(userData, en)
  await resizeWindow(app, 1300, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)

  await page.getByTestId("page-help").click()
  const help = page.getByTestId("help-page")
  await expect(help).toBeVisible()
  const keys = await help.locator("dt").allTextContents()
  expect(keys[0]).toMatch(/^(⌘|Ctrl) F$/)
  // The keys that do not exist are not listed (spec 001 leaves the search and the moves open).
  for (const gone of ["K", "[", "]", "↑ ↓"]) expect(keys.join("|")).not.toContain(gone)
  await expect(help).toContainText("Find in the chat")
  await shot(page, "b4-30-help")

  // The key works in a chat, and does nothing where there is no chat.
  await page.getByTestId("page-workflows").click()
  await newWorkflow(page, "Weekly report")
  await page.keyboard.press("ControlOrMeta+f")
  await expect(page.getByTestId("find-bar")).toBeVisible()
  await page.getByTestId("find-input").press("Escape")
  await page.getByTestId("open-settings").click()
  await page.keyboard.press("ControlOrMeta+f")
  await expect(page.getByTestId("find-bar")).toHaveCount(0)

  // General: "Compact long chats automatically" and "Keep going on open steps" are on at first.
  for (const id of ["setting-auto-compact", "setting-keep-going"])
    await expect(page.getByTestId(id)).toHaveAttribute("aria-checked", "true")
  await page.getByTestId("setting-auto-compact").click()
  await page.getByTestId("setting-keep-going").click()
  await expect(page.getByTestId("setting-auto-compact")).toHaveAttribute("aria-checked", "false")
  await expect(page.getByTestId("setting-keep-going")).toHaveAttribute("aria-checked", "false")
  await page.getByTestId("settings-nav-appearance").click()
  await expect(page.getByTestId("setting-show-tool-steps")).toHaveAttribute("aria-checked", "true")
  await shot(page, "b4-31-appearance")

  // The values stay after a restart.
  await app.close()
  ;({ app, page } = await launch(userData, ko))
  await page.getByTestId("open-settings").click()
  await expect(page.getByTestId("setting-auto-compact")).toHaveAttribute("aria-checked", "false")
  await expect(page.getByTestId("setting-keep-going")).toHaveAttribute("aria-checked", "false")
  await app.close()
  await mock.close()
})

test("send once: Enter pressed again while a message goes sends it once", async () => {
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), en)
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")

  const input = page.getByTestId("chat-input")
  const mine = page.locator("[data-testid=message][data-author=user]")
  await input.fill("only once")
  // Five presses in one turn of the window: all of them reach the box before the host answers.
  await input.evaluate((box) => {
    for (let i = 0; i < 5; i++)
      box.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      )
  })
  await expect(input).toHaveValue("")
  await expect(mine.first()).toContainText("only once")
  await expect(page.getByTestId("message-text").nth(1)).toContainText("You said: only once")
  await settled(page)
  await expect(mine).toHaveCount(1)

  await app.close()
  await mock.close()
})

test("links: a link with no scheme opens with https, and a relative link is plain text", async () => {
  const mock = await startMockProvider()
  const work = mkdtempSync(join(tmpdir(), "robot-links-"))
  const opened = join(work, "opened.log")
  const { app, page } = await launch(freshUserData(), { ...en, ROBOT_TEST_OPEN_LOG: opened })
  await resizeWindow(app, 1200, 860)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await newWorkflow(page, "Weekly report")

  // The stand-in answers with the words of the message, so the message holds the Markdown.
  await say(
    page,
    "See [the guide](www.example.com/guide) and [local](docs/guide.md) and [mail](me@example.com).",
  )
  const reply = page.getByTestId("message").nth(1)
  const guide = reply.locator("a", { hasText: "the guide" })
  await expect(guide).toHaveAttribute("href", "https://www.example.com/guide")
  await expect(reply.locator("a", { hasText: "mail" })).toHaveAttribute(
    "href",
    "mailto:me@example.com",
  )
  await expect(reply).toContainText("local")
  await expect(reply.locator("a", { hasText: "local" })).toHaveCount(0)
  await settled(page)
  await guide.click()
  await expect.poll(() => readFileSync(opened, "utf8")).toContain("https://www.example.com/guide")
  await expect(page.getByTestId("toast-error")).toHaveCount(0)
  await shot(page, "b4-40-links")

  await app.close()
  await mock.close()
})
