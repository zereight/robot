import { expect, type Page, test } from "@playwright/test"
import { makeFakeRuntimes } from "./fake-runtimes.ts"
import { connectMock, freshUserData, type Launched, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { freePortPair } from "./ports.ts"
import { closeSettings, envFor, openDevices, rpc, setName } from "./sync-helpers.ts"

// Slice S85: the effort field of the form of a new agent starts at "Medium" when the model offers
// it, and stays where the user puts it (spec 002, flow 1, and 006). An agent that exists, a copy, a
// chat header, an import and a routine do not change. The window is the smallest that the spec
// allows with the full layout of the form (760 px wide).

interface AgentInfo {
  id: string
  name: string
  model: { accountId: string; model: string; effort: string | null } | null
}

const serverOf = async (page: Page) =>
  (await rpc<{ id: string; kind: string }[]>(page, "servers.list")).find((s) => s.kind === "local")
    ?.id as string
const agentsOf = async (page: Page) =>
  rpc<AgentInfo[]>(page, "agents.list", { serverId: await serverOf(page), archived: false })
const effortOf = async (page: Page, name: string) =>
  (await agentsOf(page)).find((a) => a.name === name)?.model?.effort

const effortField = (page: Page) => page.getByTestId("model-effort")
const levels = (page: Page) => effortField(page).locator("option")

/** Connects a mock account with the Anthropic API, named "Claude". The Mock account comes first. */
const connectClaude = async (page: Page, baseUrl: string) => {
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-providers").click()
  await page.getByTestId("provider-add").click()
  await page.getByTestId("provider-kind").selectOption("anthropic")
  await page.getByTestId("provider-name").fill("Claude")
  await page.getByTestId("provider-base-url").fill(baseUrl)
  await page.getByTestId("provider-api-key").fill(GOOD_KEY)
  await page.getByTestId("provider-submit").click()
  await expect(page.getByTestId("provider-status")).toHaveText(["Connected", "Connected"])
  await page.getByTestId("settings-close").click()
}

const openForm = async (page: Page) => {
  await page.getByTestId("new-agent").click()
  await expect(page.getByTestId("agent-form")).toBeVisible()
  await page.getByTestId("model-model").waitFor()
}

/** Presses Create and waits until the box is gone and the chat of the new agent shows. */
const create = async (page: Page, name: string) => {
  await page.getByTestId("agent-name").fill(name)
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("conversation-header")).toContainText(name)
  await page.getByTestId("new-agent-dialog").waitFor({ state: "detached" })
}

/** Opens the profile of the agent that shows now. */
const openProfile = async (page: Page, name: string) => {
  await page.locator(`[data-place-row][data-place-name="${name}"]`).click()
  await expect(page.getByTestId("chat-start").locator("h2")).toHaveText(name)
  await page.getByTestId("chat-header-agent").click()
  await expect(page.getByTestId("agent-profile")).toBeVisible()
}
/** A shot with the model picker in the middle of the window: the form is taller than the window. */
const shotPicker = async (page: Page, name: string) => {
  await page.getByTestId("model-picker").evaluate((el) => el.scrollIntoView({ block: "center" }))
  await shot(page, name)
}
const closeDialog = async (page: Page, testId: string) => {
  await page.keyboard.press("Escape")
  await expect(page.getByTestId(testId)).toBeHidden()
}

test("new agent: the effort starts at Medium, a pick stays, and nothing else changes", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider({ lowHighModel: true })
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 760, 880)
  try {
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await connectClaude(page, mock.anthropicUrl)

    // 1. A model with no levels shows no field. A model that offers Medium shows "Medium".
    await openForm(page)
    await page.getByTestId("model-account").selectOption({ label: "Mock" })
    await page.getByTestId("model-model").selectOption("mock-fast")
    await expect(effortField(page)).toHaveCount(0)
    await page.getByTestId("model-model").selectOption("o3-mini")
    await expect(effortField(page)).toHaveValue("medium")
    await expect(levels(page)).toHaveText(["Default", "Low", "Medium", "High"])
    await shotPicker(page, "s85-01-new-form-medium")

    // 2. The start follows the model until the user picks. A model with Low and High only has no
    //    Medium, so the field shows "Default". A model that offers Medium brings "Medium" back.
    await page.getByTestId("model-account").selectOption({ label: "Claude" })
    await page.getByTestId("model-model").selectOption("claude-3-5-haiku-latest")
    await expect(effortField(page)).toHaveCount(0)
    await page.getByTestId("model-model").selectOption("claude-opus-5-low-high")
    await expect(levels(page)).toHaveText(["Default", "Low", "High"])
    await expect(effortField(page)).toHaveValue("")
    await shotPicker(page, "s85-02-new-form-no-medium")
    await page.getByTestId("model-model").selectOption("claude-haiku-5-5")
    await expect(effortField(page)).toHaveValue("medium")

    // 3. A level that the user picks stays for a model that offers it, and goes to "Default" for
    //    a model that does not. The start is over then: Medium does not come back.
    await effortField(page).selectOption("high")
    await page.getByTestId("model-model").selectOption("claude-opus-5-low-high")
    await expect(effortField(page)).toHaveValue("high")
    await page.getByTestId("model-model").selectOption("claude-3-5-haiku-latest")
    await expect(effortField(page)).toHaveCount(0)
    await page.getByTestId("model-model").selectOption("claude-haiku-5-5")
    await expect(effortField(page)).toHaveValue("")
    await closeDialog(page, "new-agent-dialog")

    // 4. "Default" that the user picks stays, also for a model that offers Medium.
    await openForm(page)
    await page.getByTestId("model-account").selectOption({ label: "Mock" })
    await page.getByTestId("model-model").selectOption("o3-mini")
    await expect(effortField(page)).toHaveValue("medium")
    await effortField(page).selectOption("")
    await page.getByTestId("model-account").selectOption({ label: "Claude" })
    await page.getByTestId("model-model").selectOption("claude-haiku-5-5")
    await expect(effortField(page)).toHaveValue("")
    await page.getByTestId("model-model").selectOption("claude-sonnet-4-5")
    await expect(effortField(page)).toHaveValue("")
    await closeDialog(page, "new-agent-dialog")

    // 5. A starter keeps the field: it fills the name, the role and the instructions only. The
    //    agent that is made has "Medium", and its profile shows it.
    await openForm(page)
    await page.getByTestId("model-account").selectOption({ label: "Mock" })
    await page.getByTestId("model-model").selectOption("o3-mini")
    await expect(effortField(page)).toHaveValue("medium")
    await page.getByTestId("starter-assistant").click()
    await expect(page.getByTestId("agent-name")).toHaveValue("Assistant")
    await expect(effortField(page)).toHaveValue("medium")
    await create(page, "Ada")
    expect(await effortOf(page, "Ada")).toBe("medium")
    await openProfile(page, "Ada")
    await expect(page.getByTestId("agent-profile").getByTestId("model-effort")).toHaveValue(
      "medium",
    )
    await shotPicker(page, "s85-03-profile-medium")
    await closeDialog(page, "agent-profile")

    // 6. A starter after a pick of "Default" keeps "Default". The profile shows "Default".
    await openForm(page)
    await page.getByTestId("model-account").selectOption({ label: "Mock" })
    await page.getByTestId("model-model").selectOption("o3-mini")
    await page.getByTestId("starter-reviewer").click()
    await expect(effortField(page)).toHaveValue("medium")
    await effortField(page).selectOption("")
    await page.getByTestId("starter-organizer").click()
    await expect(page.getByTestId("agent-name")).toHaveValue("Organizer")
    await expect(effortField(page)).toHaveValue("")
    await create(page, "Bob")
    expect(await effortOf(page, "Bob")).toBeNull()
    await openProfile(page, "Bob")
    await expect(page.getByTestId("agent-profile").getByTestId("model-effort")).toHaveValue("")
    await closeDialog(page, "agent-profile")

    // 7. An agent that exists keeps its level, which is "Default" here. Its profile and its chat
    //    header still show "Default", though the model offers Medium.
    const accountId = (await agentsOf(page)).find((a) => a.name === "Ada")?.model?.accountId ?? ""
    expect(accountId).not.toBe("")
    await rpc(page, "agents.create", {
      serverId: await serverOf(page),
      name: "Cora",
      role: "",
      instructions: "",
      model: { accountId, model: "o3-mini", effort: null },
    })
    await openProfile(page, "Cora")
    await expect(page.getByTestId("agent-profile").getByTestId("model-effort")).toHaveValue("")
    await closeDialog(page, "agent-profile")
    await page.getByTestId("chat-header-model").click()
    await expect(page.getByTestId("model-picker")).toBeVisible()
    await expect(effortField(page)).toHaveValue("")
    await shotPicker(page, "s85-04-chat-header-default")
    await closeDialog(page, "model-dialog")
  } finally {
    await app.close()
    await mock.close()
  }
})

test("new agent: a copy keeps its level, and a routine with its own model starts at Default", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 760, 880)
  try {
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await openForm(page)
    await page.getByTestId("model-model").selectOption("o3-mini")
    await expect(effortField(page)).toHaveValue("medium")
    await effortField(page).selectOption("high")
    await create(page, "Ada")
    expect(await effortOf(page, "Ada")).toBe("high")

    // The copy has "High", as the agent has.
    await openProfile(page, "Ada")
    await page.getByTestId("agent-duplicate").click()
    await expect(page.getByTestId("chat-start").locator("h2")).toHaveText("Ada copy")
    expect(await effortOf(page, "Ada copy")).toBe("high")

    // A routine with its own model starts at "Default".
    await page.getByTestId("page-routines").click()
    await page.getByTestId("routine-new").click()
    await page.getByTestId("routine-model-mode").selectOption("own")
    await page.getByTestId("model-model").selectOption("o3-mini")
    await expect(effortField(page)).toHaveValue("")
    await shotPicker(page, "s85-05-routine-default")
  } finally {
    await app.close()
    await mock.close()
  }
})

test("new agent in Korean: the field starts at Medium (보통)", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "ko-KR" })
  await resizeWindow(app, 760, 880)
  try {
    await connectMock(page, mock.openaiUrl, GOOD_KEY)
    await openForm(page)
    await page.getByTestId("model-model").selectOption("o3-mini")
    await expect(effortField(page)).toHaveValue("medium")
    await expect(levels(page)).toHaveText(["기본값", "낮음", "보통", "높음"])
    await expect(effortField(page).locator("option:checked")).toHaveText("보통")
    await shotPicker(page, "s85-06-new-form-medium-ko")
    await create(page, "아다")
    expect(await effortOf(page, "아다")).toBe("medium")
  } finally {
    await app.close()
    await mock.close()
  }
})

// ---- An agent on a vendor runtime gets the level as before (spec 002, 006) ----

test("new agent on a vendor runtime: the level that the form holds goes to the program", async () => {
  test.skip(process.platform === "win32", "the stand-in programs need a shell")
  test.setTimeout(120_000)
  const fake = makeFakeRuntimes()
  fake.setClaude({
    loggedIn: true,
    authMethod: "claude.ai",
    email: "tester@example.com",
    plan: "max",
  })
  const { app, page } = await launch(freshUserData(), {
    ROBOT_SYSTEM_LOCALE: "en-US",
    ROBOT_CLAUDE_BIN: fake.claude,
    ROBOT_CODEX_BIN: "none",
  })
  await resizeWindow(app, 760, 880)
  try {
    await page.getByTestId("open-settings").click()
    await page.getByTestId("settings-nav-providers").click()
    await page.getByTestId("provider-add").click()
    await expect(page.getByTestId("provider-kind")).toHaveValue("claude_code")
    await expect(page.getByTestId("runtime-status")).toHaveText("Signed in as tester@example.com.")
    await page.getByTestId("provider-submit").click()
    await expect(page.getByTestId("provider-status")).toHaveText("Connected")
    await page.getByTestId("settings-close").click()

    // The program takes five levels, so the form starts at "Medium". The turn passes it on.
    await openForm(page)
    await expect(levels(page)).toHaveText(["Default", "Low", "Medium", "High", "Extra high", "Max"])
    await expect(effortField(page)).toHaveValue("medium")
    await create(page, "Ada")
    expect(await effortOf(page, "Ada")).toBe("medium")
    await page.getByTestId("composer-input").fill("hello ada")
    await page.getByTestId("composer-input").press("Enter")
    await expect(page.getByTestId("message").last()).toContainText("Echo: hello ada")
    const turnOf = (text: string) =>
      (
        fake.claudeCalls().filter((c) => "prompt" in c) as { args: string[]; prompt: string }[]
      ).find((c) => c.prompt.includes(text))
    const ada = turnOf("hello ada")?.args ?? []
    expect(ada[ada.indexOf("--effort") + 1]).toBe("medium")

    // "Default" that the user picks passes no level to the program.
    await openForm(page)
    await effortField(page).selectOption("")
    await create(page, "Bob")
    expect(await effortOf(page, "Bob")).toBeNull()
    await page.getByTestId("composer-input").fill("hello bob")
    await page.getByTestId("composer-input").press("Enter")
    await expect(page.getByTestId("message").last()).toContainText("Echo: hello bob")
    expect(turnOf("hello bob")?.args).not.toContain("--effort")
  } finally {
    await app.close()
  }
})

// ---- The same form on a linked computer starts the same way (spec 002, 012) ----

const tile = (page: Page, name: string) =>
  page.locator(`[data-testid=server-tile][data-name="${name}"]`)
const placeOf = (page: Page, name: string) =>
  page.locator("[data-testid^=place-agent-]", { hasText: new RegExp(`^${name}`) })

/** MacBook 2 shows a code; MacBook 1 connects one way, and may change agents on MacBook 2. */
const pairOneWay = async (one: Launched, two: Launched) => {
  await openDevices(two.page)
  await two.page.getByTestId("pair-open").click()
  await two.page.getByTestId("pair-turn-on").click()
  await expect(two.page.getByTestId("pair-code")).toHaveAttribute("data-code", /^\d{6}$/)
  const code = (await two.page.getByTestId("pair-code").getAttribute("data-code")) ?? ""
  const address =
    (await two.page
      .getByTestId("pair-addresses")
      .locator("li")
      .first()
      .getAttribute("data-address")) ?? ""
  await one.page.getByTestId("server-add").click()
  await one.page.getByTestId("connect-address").fill(address)
  await one.page.getByTestId("connect-code").fill(code)
  await one.page.getByTestId("connect-next").click()
  await one.page.getByTestId("connect-two-way").click()
  await one.page.getByTestId("connect-finish").click()
  await expect(two.page.getByTestId("join-can-change")).toHaveAttribute("aria-checked", "true")
  await two.page.getByTestId("join-allow").click()
  await expect(one.page.getByTestId("connect-dialog")).toBeHidden()
  await two.page.getByTestId("pair-close").click()
  await expect(tile(one.page, "MacBook 2")).toHaveAttribute("data-state", "online")
}

test("new agent on a linked computer: the field starts at Medium, and a pick stays", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const ports = await freePortPair()
  const two = await launch(freshUserData(), envFor(ports[1], {}))
  const one = await launch(freshUserData(), envFor(ports[0], {}))
  await resizeWindow(two.app, 1200, 860)
  await resizeWindow(one.app, 760, 880)
  try {
    // The model account is on MacBook 2 (the server). MacBook 1 has none.
    await connectMock(two.page, mock.openaiUrl, GOOD_KEY)
    await openDevices(two.page)
    await setName(two.page, "MacBook 2")
    await closeSettings(two.page)
    await openDevices(one.page)
    await setName(one.page, "MacBook 1")
    await closeSettings(one.page)
    await pairOneWay(one, two)
    await closeSettings(two.page)
    await tile(one.page, "MacBook 2").click()

    // The choices are the models of the server. A model with levels starts at "Medium".
    await openForm(one.page)
    await one.page.getByTestId("model-model").selectOption("mock-fast")
    await expect(effortField(one.page)).toHaveCount(0)
    await one.page.getByTestId("model-model").selectOption("o3-mini")
    await expect(effortField(one.page)).toHaveValue("medium")
    await shotPicker(one.page, "s85-07-linked-form-medium")
    await create(one.page, "Writer")
    await expect(placeOf(two.page, "Writer")).toBeVisible()
    // The server holds the level that the form showed.
    expect(await effortOf(two.page, "Writer")).toBe("medium")

    // A pick of "Default" on the client stays, and the server holds no level.
    await openForm(one.page)
    await one.page.getByTestId("model-model").selectOption("o3-mini")
    await expect(effortField(one.page)).toHaveValue("medium")
    await effortField(one.page).selectOption("")
    await create(one.page, "Editor")
    await expect(placeOf(two.page, "Editor")).toBeVisible()
    expect(await effortOf(two.page, "Editor")).toBeNull()
  } finally {
    await one.app.close()
    await two.app.close()
    await mock.close()
  }
})
