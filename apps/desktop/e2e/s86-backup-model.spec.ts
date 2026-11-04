import { expect, type Page, test } from "@playwright/test"
import { connectMock, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"

// Slice S86: the backup model (spec 006, "Backup model"; 002, 003). The main account is a stand-in
// that can be made to answer every chat request with a spent limit. The backup account is a second
// stand-in that always answers. The tests look at the form, the first turn that goes to the backup,
// the hold, the turns that follow, "Use the main model now", the hold after a restart, and the
// profile. The same screens are looked at in Korean.

const QUOTA = "You exceeded your current quota, please check your plan and billing details."

const agentMessages = (page: Page) => page.locator("[data-testid=message][data-author=agent]")
const settled = (page: Page) =>
  expect(page.locator("[data-testid=message][data-status=streaming]")).toHaveCount(0)
const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}
const chatRequests = (mock: { requests: { path: string }[] }) =>
  mock.requests.filter((r) => r.path === "/v1/chat/completions").length

/** The part of the form of an agent that holds the backup model: its pickers are the second pair. */
const backupPicker = (page: Page) => page.getByTestId("backup-field")

/** Fills the form of a new agent: main model "Main / mock-fast", and the backup that is given. */
const openForm = async (page: Page) => {
  await page.getByTestId("new-agent").click()
  await expect(page.getByTestId("agent-form")).toBeVisible()
  await page.getByTestId("model-model").first().waitFor()
}

const rowOf = (page: Page, name: string) =>
  page.locator(`[data-place-row][data-place-name="${name}"]`)

const openProfile = async (page: Page, name: string) => {
  await rowOf(page, name).click()
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
}

/** A shot of the field "Backup model" in the middle of the window: the form is taller than it. */
const shotBackup = async (page: Page, name: string) => {
  await page.getByTestId("backup-field").evaluate((el) => el.scrollIntoView({ block: "center" }))
  await shot(page, name)
}

test("backup model: the form, the first turn, the hold, 'Use the main model now', a restart, the profile", async () => {
  test.setTimeout(300_000)
  const main = await startMockProvider()
  const backup = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1100, 900)
  try {
    await connectMock(page, main.openaiUrl, GOOD_KEY, "Main")
    await connectMock(page, backup.openaiUrl, GOOD_KEY, "Backup")

    // 1. The form: the backup starts as "None". The same choice as the main one is refused, with
    // the reason, and Create does not go on. A different model saves.
    await openForm(page)
    await page.getByTestId("agent-name").fill("Ada")
    await page.getByTestId("model-account").first().selectOption({ label: "Main" })
    await page.getByTestId("model-model").first().selectOption("mock-fast")
    await expect(page.getByTestId("backup-none")).toHaveText("None")
    await expect(page.getByTestId("backup-same")).toHaveCount(0)
    await shotBackup(page, "s86-01-form-none")
    await page.getByTestId("backup-choose").click()
    await backupPicker(page).getByTestId("model-account").selectOption({ label: "Main" })
    await backupPicker(page).getByTestId("model-model").selectOption("mock-fast")
    await expect(page.getByTestId("backup-same")).toBeVisible()
    await shotBackup(page, "s86-02-form-same")
    await page.getByTestId("agent-submit").click()
    await expect(page.getByTestId("agent-form")).toBeVisible()
    await backupPicker(page).getByTestId("model-account").selectOption({ label: "Backup" })
    await backupPicker(page).getByTestId("model-model").selectOption("o3-mini")
    await expect(page.getByTestId("backup-same")).toHaveCount(0)
    await shotBackup(page, "s86-03-form-backup")
    await page.getByTestId("agent-submit").click()
    await expect(page.getByTestId("chat-start").filter({ hasText: "Ada" })).toBeVisible()
    await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
    await expect(page.getByTestId("chat-header-model")).toHaveText("mock-fast")
    await expect(page.getByTestId("chat-header-hold")).toHaveCount(0)

    // 2. No limit: the main model answers, the backup is not asked, and there is no line.
    await send(page, "hello")
    await expect(agentMessages(page).first()).toContainText("You said: hello")
    await settled(page)
    expect(chatRequests(main)).toBe(1)
    expect(chatRequests(backup)).toBe(0)
    await expect(page.getByTestId("backup-line")).toHaveCount(0)

    // 3. The main account spends its quota, and the provider says when it resets (in one hour).
    // The turn goes on with the backup model, in the same task, from its start: the failed try ran
    // no step. The chat shows one muted line, and the header shows the hold.
    main.setLimit({ message: QUOTA, retryAfter: 3600 })
    await send(page, "second message")
    await expect(agentMessages(page).nth(1)).toContainText("You said: second message")
    await settled(page)
    expect(chatRequests(main)).toBe(2)
    expect(chatRequests(backup)).toBe(1)
    await expect(page.getByTestId("backup-line")).toHaveCount(1)
    await expect(page.getByTestId("backup-line")).toContainText(
      "mock-fast reached its limit. o3-mini goes on. The limit resets at ",
    )
    await expect(page.getByTestId("chat-header-model")).toHaveText("o3-mini")
    await expect(page.getByTestId("chat-header-backup")).toHaveText(/^Backup until \d/)
    await expect(page.getByTestId("chat-header-use-main")).toHaveText("Use mock-fast now")
    await shot(page, "s86-04-first-turn-on-backup")

    // 4. While the hold lasts, a turn goes to the backup at once: the main model is not asked,
    // and there is no second line.
    await send(page, "third message")
    await expect(agentMessages(page).nth(2)).toContainText("You said: third message")
    await settled(page)
    expect(chatRequests(main)).toBe(2)
    expect(chatRequests(backup)).toBe(2)
    await expect(page.getByTestId("backup-line")).toHaveCount(1)

    // 5. The hold stays after a restart of the app.
    await app.close()
    ;({ app, page } = await launch(userData, env))
    await resizeWindow(app, 1100, 900)
    await rowOf(page, "Ada").click()
    await expect(page.getByTestId("chat-header-model")).toHaveText("o3-mini")
    await expect(page.getByTestId("chat-header-backup")).toHaveText(/^Backup until \d/)
    await expect(page.getByTestId("backup-line")).toHaveCount(1)

    // 6. "Use mock-fast now" ends the hold. The next turn tries the main model; the limit is still
    // spent, so the hold starts again and the chat shows no second line.
    await page.getByTestId("chat-header-use-main").click()
    await expect(page.getByTestId("chat-header-hold")).toHaveCount(0)
    await expect(page.getByTestId("chat-header-model")).toHaveText("mock-fast")
    await shot(page, "s86-05-main-again")
    await send(page, "fourth message")
    await expect(agentMessages(page).nth(3)).toContainText("You said: fourth message")
    await settled(page)
    expect(chatRequests(main)).toBe(3)
    expect(chatRequests(backup)).toBe(3)
    await expect(page.getByTestId("backup-line")).toHaveCount(1)
    await expect(page.getByTestId("chat-header-hold")).toBeVisible()

    // 7. The limit resets: the user ends the hold, and the next turn is the main model's.
    main.setLimit(null)
    await page.getByTestId("chat-header-use-main").click()
    await expect(page.getByTestId("chat-header-hold")).toHaveCount(0)
    await send(page, "fifth message")
    await expect(agentMessages(page).nth(4)).toContainText("You said: fifth message")
    await settled(page)
    expect(chatRequests(main)).toBe(4)
    expect(chatRequests(backup)).toBe(3)
    await expect(page.getByTestId("chat-header-hold")).toHaveCount(0)

    // 8. The profile shows the backup. Removing it and saving ends a hold, and the agent has none.
    main.setLimit({ message: QUOTA, retryAfter: 3600 })
    await send(page, "sixth message")
    await expect(agentMessages(page).nth(5)).toContainText("You said: sixth message")
    await settled(page)
    await expect(page.getByTestId("chat-header-hold")).toBeVisible()
    // A limit that comes after a turn of the main model is a new event: it has its own line.
    await expect(page.getByTestId("backup-line")).toHaveCount(2)
    await openProfile(page, "Ada")
    await expect(page.getByTestId("backup-field")).toBeVisible()
    await shotBackup(page, "s86-06-profile-backup")
    await page.getByTestId("backup-remove").click()
    await expect(page.getByTestId("backup-none")).toHaveText("None")
    await page.getByTestId("agent-submit").click()
    await expect(page.getByTestId("agent-profile")).toBeHidden()
    await expect(page.getByTestId("chat-header-hold")).toHaveCount(0)
    await expect(page.getByTestId("chat-header-model")).toHaveText("mock-fast")

    // 9. With no backup the limit fails the turn as before: no second model, no line, no hold.
    const before = chatRequests(backup)
    await send(page, "seventh message")
    await expect(page.getByTestId("chat-header-hold")).toHaveCount(0)
    const failed = agentMessages(page).nth(6)
    await expect(failed).toHaveAttribute("data-status", "failed")
    await expect(failed).toContainText("The usage limit of this account is reached.")
    await settled(page)
    expect(chatRequests(backup)).toBe(before)
    await expect(page.getByTestId("backup-line")).toHaveCount(2)
    await shot(page, "s86-07-no-backup-fails")
  } finally {
    await app.close()
    await main.close()
    await backup.close()
  }
})

test("backup model: a limit with no reset time holds for 15 minutes; Korean", async () => {
  test.setTimeout(180_000)
  const main = await startMockProvider()
  const backup = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 1100, 900)
  try {
    await connectMock(page, main.openaiUrl, GOOD_KEY, "Main")
    await connectMock(page, backup.openaiUrl, GOOD_KEY, "Backup")
    await openForm(page)
    await page.getByTestId("agent-name").fill("Ada")
    await page.getByTestId("model-account").first().selectOption({ label: "Main" })
    await page.getByTestId("model-model").first().selectOption("mock-fast")
    await shotBackup(page, "s86-10-ko-form-none")
    await page.getByTestId("backup-choose").click()
    await backupPicker(page).getByTestId("model-account").selectOption({ label: "Main" })
    await backupPicker(page).getByTestId("model-model").selectOption("mock-fast")
    await expect(page.getByTestId("backup-same")).toContainText("백업이 메인 모델과 같아요")
    await shotBackup(page, "s86-11-ko-form-same")
    await backupPicker(page).getByTestId("model-account").selectOption({ label: "Backup" })
    await backupPicker(page).getByTestId("model-model").selectOption("o3-mini")
    await page.getByTestId("agent-submit").click()
    await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })

    // No reset time from the provider: the hold lasts 15 minutes from the failed turn.
    main.setLimit({ message: QUOTA })
    const started = Date.now()
    await send(page, "hello")
    await expect(agentMessages(page).first()).toContainText("You said: hello")
    await settled(page)
    const line = page.getByTestId("backup-line")
    await expect(line).toHaveCount(1)
    await expect(line).toContainText("mock-fast의 한도에 도달했어요. 이어서 하는 모델: o3-mini")
    // The line names no time, because the provider named none.
    await expect(line).not.toContainText("풀려요")
    await expect(page.getByTestId("chat-header-backup")).toContainText("까지 백업")
    await expect(page.getByTestId("chat-header-use-main")).toHaveText("지금 mock-fast 쓰기")
    // The time in the line under the header is 15 minutes after the turn (a minute either way).
    const shown =
      (await page.getByTestId("chat-header-backup").textContent())?.replace("까지 백업", "") ?? ""
    const clock = (ms: number) =>
      new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(ms)
    const allowed = [-60_000, 0, 60_000, 120_000].map((d) => clock(started + 15 * 60_000 + d))
    expect(allowed).toContain(shown.trim())
    await shot(page, "s86-12-ko-hold")
  } finally {
    await app.close()
    await main.close()
    await backup.close()
  }
})
