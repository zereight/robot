import { expect, type Locator, type Page, test } from "@playwright/test"
import { connectMock, createAgent, freshUserData, launch, resizeWindow, shot } from "./harness.ts"
import { GOOD_KEY, startMockProvider } from "./mock-provider.ts"
import { rpc } from "./sync-helpers.ts"

const send = async (page: Page, text: string) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-input").press("Enter")
}

type Kind = "agents" | "channels"

const builtIn = (page: Page, kind: Kind) => page.getByTestId(`section-${kind}`)
/** A user section of a list, found by its name. */
const userSection = (page: Page, kind: Kind, name: string) =>
  builtIn(page, kind).locator("[data-testid=user-section]", {
    has: page.getByTestId("user-section-toggle").getByText(name, { exact: true }),
  })
const header = (section: Locator) => section.getByTestId("user-section-header")
const rowOf = (scope: Locator | Page, name: string) =>
  scope.locator(`[data-place-row][data-place-name="${name}"]`)
/** The names of the places of a list that are in no user section, in the order shown. */
const plainNames = (page: Page, kind: Kind) =>
  builtIn(page, kind).evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("[data-place-row]")]
      .filter((row) => !row.closest("[data-testid=user-section]"))
      .map((row) => row.dataset.placeName ?? ""),
  )
const namesIn = (section: Locator) =>
  section.evaluate((el) =>
    [...el.querySelectorAll<HTMLElement>("[data-place-row]")].map((row) => row.dataset.placeName),
  )
const sectionNames = (page: Page, kind: Kind) =>
  builtIn(page, kind)
    .getByTestId("user-section-toggle")
    .evaluateAll((all) => all.map((el) => el.textContent?.trim()))

/** Opens the menu of a list header and makes a section with the name. The list keeps the box on an error. */
const startSection = async (page: Page, kind: Kind) => {
  await page.getByTestId(`${kind}-menu`).click()
  await page.getByTestId(`${kind}-menu-new-section`).click()
  const input = page.getByTestId("section-new-input")
  await expect(input).toBeFocused()
  return input
}
const makeSection = async (page: Page, kind: Kind, name: string) => {
  const input = await startSection(page, kind)
  await input.fill(name)
  await input.press("Enter")
  await expect(userSection(page, kind, name)).toBeVisible()
  await expect(page.getByTestId("section-new-input")).toHaveCount(0)
}

/** Picks a section in the menu of a place (right click). */
const moveByMenu = async (row: Locator, page: Page, target: string) => {
  await row.click({ button: "right" })
  await page.getByRole("menuitemradio", { name: target, exact: true }).click()
}

/** Takes a row with the mouse and moves it over a header. The button stays down. */
const dragOver = async (page: Page, row: Locator, target: Locator) => {
  await row.hover()
  await page.mouse.down()
  const box = await target.boundingBox()
  if (!box) throw new Error("no target")
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 })
}
/** Drags a row onto a header and drops it. */
const dragOnto = async (page: Page, row: Locator, target: Locator) => {
  await dragOver(page, row, target)
  await page.mouse.up()
}

test("sections: make, refuse, move, keep, count, drag, delete, search, copy", async () => {
  test.setTimeout(240_000)
  const mock = await startMockProvider()
  const userData = freshUserData()
  const env = { ROBOT_SYSTEM_LOCALE: "en-US" }
  let { app, page } = await launch(userData, env)
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  for (const name of ["Ada", "Bo", "Cy"]) await createAgent(page, name)
  await page.getByTestId("new-channel").click()
  await page.getByTestId("channel-name").fill("Launch")
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Launch")
  await expect(await plainNames(page, "agents")).toEqual(["Ada", "Bo", "Cy"])

  // Make the agent section "Research". Escape cancels the name box.
  let input = await startSection(page, "agents")
  await input.fill("Draft")
  await input.press("Escape")
  await expect(page.getByTestId("section-new-input")).toHaveCount(0)
  await expect(page.getByTestId("user-section")).toHaveCount(0)
  await makeSection(page, "agents", "Research")
  await expect(
    userSection(page, "agents", "Research").getByTestId("user-section-empty"),
  ).toContainText("Drag a place here")
  await shot(page, "s28-01-new-section")

  // The same name with another case is refused in the same list. The other list accepts it.
  input = await startSection(page, "agents")
  await input.fill("research")
  await input.press("Enter")
  await expect(page.getByTestId("section-name-error")).toHaveText(
    "Another section in this list has this name.",
  )
  await expect(input).toBeVisible()
  await shot(page, "s28-02-refused")
  await input.press("Escape")
  await expect(page.getByTestId("user-section")).toHaveCount(1)
  await makeSection(page, "channels", "Research")
  await expect(userSection(page, "channels", "Research")).toBeVisible()
  // A name of 41 characters cannot be typed, and an empty name is refused.
  input = await startSection(page, "agents")
  await input.fill("x".repeat(60))
  await expect(input).toHaveValue("x".repeat(40))
  await input.fill("   ")
  await input.press("Enter")
  await expect(page.getByTestId("section-name-error")).toContainText("1 to 40 characters")
  await input.press("Escape")

  // "Move to section": the agent shows under "Research" and not among the others.
  const research = userSection(page, "agents", "Research")
  await moveByMenu(rowOf(page, "Ada"), page, "Research")
  await expect.poll(() => namesIn(research)).toEqual(["Ada"])
  await expect.poll(() => plainNames(page, "agents")).toEqual(["Bo", "Cy"])
  await expect(research.getByTestId("user-section-empty")).toHaveCount(0)
  // The menu marks the current section. Only sections of the kind of the place are listed.
  await rowOf(page, "Ada").click({ button: "right" })
  await expect(page.getByRole("menuitemradio")).toHaveText(["Research", "No section"])
  await expect(page.getByRole("menuitemradio", { name: "Research" })).toHaveAttribute(
    "aria-checked",
    "true",
  )
  await expect(page.getByRole("menuitemradio", { name: "No section" })).toHaveAttribute(
    "aria-checked",
    "false",
  )
  await shot(page, "s28-03-move-menu")
  await page.keyboard.press("Escape")
  await expect(page.getByTestId("place-menu")).toHaveCount(0)

  // After a restart, the section and the agent in it are still there.
  await app.close()
  ;({ app, page } = await launch(userData, env))
  await resizeWindow(app, 1300, 900)
  await expect.poll(() => namesIn(userSection(page, "agents", "Research"))).toEqual(["Ada"])
  await expect.poll(() => plainNames(page, "agents")).toEqual(["Bo", "Cy"])
  await expect.poll(() => sectionNames(page, "channels")).toEqual(["Research"])
  await shot(page, "s28-04-after-restart")

  // Two unread messages in a section: its collapsed header shows 2, and the dot while it works.
  // The second message waits in the queue, so that it gets a reply of its own (spec 003).
  await rpc(page, "settings.update", { duringTurn: "queue" })
  const researchAgents = userSection(page, "agents", "Research")
  await rowOf(page, "Ada").click()
  await send(page, "slow for unread one")
  await send(page, "slow for unread two")
  await rowOf(page, "Bo").click()
  await researchAgents.getByTestId("user-section-toggle").click()
  await expect(researchAgents.getByTestId("user-section-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  )
  await expect(rowOf(page, "Ada")).toHaveCount(0)
  await expect(researchAgents.getByTestId("section-working-dot")).toBeVisible()
  await expect(researchAgents.getByTestId("section-badge")).toHaveText("2", { timeout: 30_000 })
  await expect(researchAgents.getByTestId("section-working-dot")).toHaveCount(0)
  await shot(page, "s28-05-collapsed-badge")

  // The sum of a collapsed built-in section includes its user sections.
  const agentsHeader = page.getByTestId("section-header-agents")
  await page.getByTestId("section-toggle-agents").click()
  await expect(agentsHeader.getByTestId("section-badge")).toHaveText("2")
  await expect(page.getByTestId("section-agents").getByTestId("user-section")).toHaveCount(0)
  await page.getByTestId("section-toggle-agents").click()
  await expect(agentsHeader.getByTestId("section-badge")).toHaveCount(0)
  await expect(researchAgents.getByTestId("section-badge")).toHaveText("2")

  // Up and down move through the places that show. A collapsed section has none.
  await page.getByTestId("place-search").focus()
  const walked: string[] = []
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("ArrowDown")
    walked.push(
      await page.evaluate(() => document.activeElement?.getAttribute("data-place-name") ?? ""),
    )
  }
  expect(walked).toEqual(["Launch", "Bo", "Cy", "Cy"])

  // Open the section: the badge leaves the header and shows on the agent.
  await researchAgents.getByTestId("user-section-toggle").click()
  await expect(researchAgents.getByTestId("section-badge")).toHaveCount(0)
  await expect(rowOf(page, "Ada")).toContainText("2")
  await shot(page, "s28-06-badge-on-agent")

  // Drag: a header of the other kind refuses a channel row. A header of its kind takes it.
  const channelResearch = userSection(page, "channels", "Research")
  const launchRow = rowOf(builtIn(page, "channels"), "Launch")
  await dragOver(page, launchRow, header(researchAgents))
  await expect(header(researchAgents)).toHaveAttribute("data-drop", "false")
  await page.mouse.up()
  await expect(await namesIn(channelResearch)).toEqual([])
  await expect(await plainNames(page, "channels")).toEqual(["Launch"])
  // A drag never opens the place.
  await expect(page.getByTestId("chat-header-agent")).toContainText("Bo")

  await dragOver(page, launchRow, header(channelResearch))
  await expect(header(channelResearch)).toHaveAttribute("data-drop", "true")
  await shot(page, "s28-07-drag-over")
  await page.mouse.up()
  await expect.poll(() => namesIn(channelResearch)).toEqual(["Launch"])
  await expect(await plainNames(page, "channels")).toEqual([])
  await expect(page.getByTestId("chat-header-agent")).toContainText("Bo")
  // And back to no section: the header of the built-in section takes it.
  await dragOnto(
    page,
    rowOf(channelResearch, "Launch"),
    page.getByTestId("section-header-channels"),
  )
  await expect.poll(() => plainNames(page, "channels")).toEqual(["Launch"])

  // Escape cancels a drag: the header shows as selected, then it does not, and nothing moves.
  await dragOver(page, rowOf(page, "Cy"), header(researchAgents))
  await expect(header(researchAgents)).toHaveAttribute("data-drop", "true")
  await page.keyboard.press("Escape")
  await expect(header(researchAgents)).toHaveAttribute("data-drop", "false")
  await page.mouse.up()
  await expect(await plainNames(page, "agents")).toEqual(["Bo", "Cy"])
  await expect(page.getByTestId("chat-header-agent")).toContainText("Bo")

  // "New section" opens a list that is closed, so that the name box shows.
  await page.getByTestId("section-toggle-agents").click()
  await expect(page.getByTestId("section-toggle-agents")).toHaveAttribute("aria-expanded", "false")
  input = await startSection(page, "agents")
  await expect(page.getByTestId("section-toggle-agents")).toHaveAttribute("aria-expanded", "true")
  await input.press("Escape")
  await expect(page.getByTestId("section-new-input")).toHaveCount(0)

  // A second section. Order: "Move up" is off for the first, "Move down" for the last.
  await makeSection(page, "agents", "Ops")
  const ops = userSection(page, "agents", "Ops")
  expect(await sectionNames(page, "agents")).toEqual(["Research", "Ops"])
  await header(researchAgents).hover()
  await researchAgents.getByTestId("section-menu").click()
  await expect(page.getByTestId("section-move-up")).toBeDisabled()
  await expect(page.getByTestId("section-move-down")).toBeEnabled()
  await page.getByTestId("section-move-down").click()
  await expect.poll(() => sectionNames(page, "agents")).toEqual(["Ops", "Research"])
  await header(researchAgents).click({ button: "right" })
  await expect(page.getByTestId("section-move-down")).toBeDisabled()
  await expect(page.getByTestId("section-move-up")).toBeEnabled()
  await shot(page, "s28-08-section-menu")
  await page.keyboard.press("Escape")
  await header(ops).click({ button: "right" })
  await expect(page.getByTestId("section-move-up")).toBeDisabled()
  await page.getByTestId("section-rename").click()
  const renameInput = page.getByTestId("section-rename-input")
  await expect(renameInput).toHaveValue("Ops")
  await renameInput.fill("Operations")
  await renameInput.press("Enter")
  await expect(userSection(page, "agents", "Operations")).toBeVisible()
  await expect(page.getByTestId("section-rename-input")).toHaveCount(0)
  const operations = userSection(page, "agents", "Operations")

  // A section with no place goes at once. The order of the others stays.
  await makeSection(page, "agents", "Temp")
  const temp = userSection(page, "agents", "Temp")
  await header(temp).click({ button: "right" })
  await page.getByTestId("section-delete").click()
  await expect(page.getByTestId("section-delete-dialog")).toHaveCount(0)
  await expect(temp).toHaveCount(0)
  expect(await sectionNames(page, "agents")).toEqual(["Operations", "Research"])

  // Delete a section that holds two agents: a dialog asks, and Back keeps everything.
  await moveByMenu(rowOf(page, "Bo"), page, "Operations")
  await dragOnto(page, rowOf(page, "Cy"), header(operations))
  await expect.poll(() => namesIn(operations)).toEqual(["Bo", "Cy"])
  await header(operations).click({ button: "right" })
  await page.getByTestId("section-delete").click()
  const dialog = page.getByTestId("section-delete-dialog")
  await expect(dialog).toContainText("The places in “Operations” move out of the section.")
  await expect(dialog).toContainText("Nothing else is deleted.")
  await expect(dialog.getByRole("button")).toHaveText(["Back", "Delete section"])
  await shot(page, "s28-09-delete-dialog")
  await page.getByTestId("section-delete-back").click()
  await expect(dialog).toHaveCount(0)
  expect(await namesIn(operations)).toEqual(["Bo", "Cy"])
  await header(operations).click({ button: "right" })
  await page.getByTestId("section-delete").click()
  await page.getByTestId("section-delete-confirm").click()
  await expect(operations).toHaveCount(0)
  // Both agents show in Agents with no section. No agent is gone.
  await expect.poll(() => plainNames(page, "agents")).toEqual(["Bo", "Cy"])
  await expect(page.locator("[data-place-row][data-testid^=place-agent-]")).toHaveCount(3)
  await expect.poll(() => namesIn(researchAgents)).toEqual(["Ada"])

  // Search: a section with a match opens, also when it is collapsed. Escape brings the state back.
  const researchToggle = researchAgents.getByTestId("user-section-toggle")
  await researchToggle.click()
  await expect(researchToggle).toHaveAttribute("aria-expanded", "false")
  await expect(rowOf(page, "Ada")).toHaveCount(0)
  const searchBox = page.getByTestId("place-search")
  await searchBox.fill("ad")
  await expect(researchToggle).toHaveAttribute("aria-expanded", "true")
  await expect(rowOf(page, "Ada")).toBeVisible()
  await expect(rowOf(page, "Bo")).toHaveCount(0)
  // A section with no match hides, also a whole list.
  await expect(page.getByTestId("section-channels")).toHaveCount(0)
  await shot(page, "s28-10-search-opens")
  await searchBox.press("Escape")
  await expect(searchBox).toHaveValue("")
  await expect(researchToggle).toHaveAttribute("aria-expanded", "false")
  await expect(rowOf(page, "Ada")).toHaveCount(0)
  await expect(rowOf(page, "Bo")).toBeVisible()
  await searchBox.fill("bo")
  await expect(researchAgents).toHaveCount(0)
  // Search reads the names of places, not the names of sections.
  await searchBox.fill("research")
  await expect(page.getByTestId("place-list")).toContainText("No places match.")
  await searchBox.press("Escape")
  await researchToggle.click()
  await expect(rowOf(page, "Ada")).toBeVisible()

  // The forms. A new agent starts with "No section" and can pick one.
  await page.getByTestId("new-agent").click()
  const agentSection = page.getByTestId("agent-section")
  await expect(agentSection.locator("option")).toHaveText(["No section", "Research"])
  await expect(agentSection.locator("option:checked")).toHaveText("No section")
  await page.getByTestId("agent-name").fill("Dee")
  await agentSection.selectOption({ label: "Research" })
  await page.getByTestId("model-model").waitFor()
  await shot(page, "s28-11-agent-form")
  await page.getByTestId("agent-submit").click()
  await page.getByTestId("chat-start").filter({ hasText: "Dee" }).waitFor()
  await expect(page.getByTestId("new-agent-dialog")).toHaveCount(0)
  await expect.poll(() => namesIn(researchAgents)).toEqual(["Ada", "Dee"])
  // The profile shows the section, and a change of it applies at once.
  await page.getByTestId("chat-header-agent").click()
  await expect(agentSection.locator("option:checked")).toHaveText("Research")
  await agentSection.selectOption({ label: "No section" })
  await page.getByTestId("agent-submit").click()
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  await expect.poll(() => namesIn(researchAgents)).toEqual(["Ada"])
  await expect.poll(() => plainNames(page, "agents")).toEqual(["Bo", "Cy", "Dee"])

  // A copy joins the section of the original.
  await rowOf(page, "Ada").click()
  await page.getByTestId("chat-header-agent").click()
  await page.getByTestId("agent-duplicate").click()
  await expect(page.getByTestId("agent-profile")).toHaveCount(0)
  await expect.poll(() => namesIn(researchAgents)).toEqual(["Ada", "Ada copy"])

  // Archive keeps the section. Restore returns the agent to it.
  await rowOf(page, "Ada").click()
  await page.getByTestId("chat-header-agent").click()
  await page.getByTestId("agent-archive").click()
  await expect.poll(() => namesIn(researchAgents)).toEqual(["Ada copy"])
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-archive").click()
  await page.getByTestId("archive-restore").click()
  await page.getByTestId("settings-close").click()
  await expect.poll(() => namesIn(researchAgents)).toEqual(["Ada", "Ada copy"])

  // A channel has the same choice in its form and in its settings.
  await page.getByTestId("new-channel").click()
  const channelSection = page.getByTestId("channel-section")
  await expect(channelSection.locator("option")).toHaveText(["No section", "Research"])
  await expect(channelSection.locator("option:checked")).toHaveText("No section")
  await page.getByTestId("channel-name").fill("Chat")
  await channelSection.selectOption({ label: "Research" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-header-name")).toHaveText("Chat")
  await expect(page.getByTestId("channel-dialog")).toHaveCount(0)
  await expect.poll(() => namesIn(channelResearch)).toEqual(["Chat"])
  await page.getByTestId("channel-settings").click()
  await expect(channelSection.locator("option:checked")).toHaveText("Research")
  await channelSection.selectOption({ label: "No section" })
  await page.getByTestId("channel-submit").click()
  await expect(page.getByTestId("channel-dialog")).toHaveCount(0)
  await expect.poll(() => namesIn(channelResearch)).toEqual([])
  await expect.poll(() => plainNames(page, "channels")).toEqual(["Chat", "Launch"])

  // Archive an agent, then delete its section. The restore puts it in no section.
  await rowOf(page, "Ada copy").click()
  await page.getByTestId("chat-header-agent").click()
  await page.getByTestId("agent-archive").click()
  await expect.poll(() => namesIn(researchAgents)).toEqual(["Ada"])
  await header(researchAgents).click({ button: "right" })
  await page.getByTestId("section-delete").click()
  await page.getByTestId("section-delete-confirm").click()
  await expect(researchAgents).toHaveCount(0)
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-archive").click()
  await page.getByTestId("archive-restore").click()
  await page.getByTestId("settings-close").click()
  await expect
    .poll(() => plainNames(page, "agents"))
    .toEqual(["Ada", "Ada copy", "Bo", "Cy", "Dee"])
  await shot(page, "s28-12-final")

  await app.close()
  await mock.close()
})

interface Seen {
  name: string
  duration: number
}

/**
 * Records every animation and transition that starts after this call, from inside the page. An
 * animation that was already running is not counted, and each one is counted once.
 */
const watchMotion = (page: Page) =>
  page.evaluate(() => {
    const seen: Seen[] = []
    ;(window as unknown as { __motion: Seen[] }).__motion = seen
    const known = new WeakSet<Animation>(document.getAnimations())
    const record = () => {
      for (const a of document.getAnimations()) {
        if (known.has(a)) continue
        known.add(a)
        seen.push({
          name:
            a instanceof CSSAnimation
              ? a.animationName
              : a instanceof CSSTransition
                ? a.transitionProperty
                : "other",
          duration: Number(a.effect?.getComputedTiming().duration ?? 0),
        })
      }
    }
    const loop = () => {
      record()
      requestAnimationFrame(loop)
    }
    window.addEventListener("animationstart", record, true)
    window.addEventListener("transitionrun", record, true)
    loop()
  })
const seenMotion = (page: Page) =>
  page.evaluate(() => (window as unknown as { __motion: Seen[] }).__motion)

test("sections: motion is short, and off with reduce motion", async () => {
  test.setTimeout(120_000)
  const mock = await startMockProvider()
  const { app, page } = await launch(freshUserData(), { ROBOT_SYSTEM_LOCALE: "en-US" })
  await resizeWindow(app, 1300, 900)
  await connectMock(page, mock.openaiUrl, GOOD_KEY)
  await createAgent(page, "Ada")
  await makeSection(page, "agents", "Research")
  await moveByMenu(rowOf(page, "Ada"), page, "Research")
  const research = userSection(page, "agents", "Research")
  await expect.poll(() => namesIn(research)).toEqual(["Ada"])

  // Close and open a section, open its menu, and show the empty line: every motion is short.
  await watchMotion(page)
  const toggle = research.getByTestId("user-section-toggle")
  await toggle.click()
  await expect(rowOf(page, "Ada")).toHaveCount(0)
  await toggle.click()
  await expect(rowOf(page, "Ada")).toBeVisible()
  await header(research).hover()
  await research.getByTestId("section-menu").click()
  await page.keyboard.press("Escape")
  await moveByMenu(rowOf(page, "Ada"), page, "No section")
  await expect.poll(() => namesIn(research)).toEqual([])
  const seen = await seenMotion(page)
  expect(seen.length).toBeGreaterThan(0)
  const tooLong = seen.filter((m) => m.duration >= 300)
  expect(tooLong, JSON.stringify(tooLong.slice(0, 3))).toEqual([])

  // Reduce motion on: nothing moves, and a section closes at once.
  await page.getByTestId("open-settings").click()
  await page.getByTestId("settings-nav-appearance").click()
  await page.getByTestId("setting-reduce-motion").getByText("On", { exact: true }).click()
  await page.getByTestId("settings-close").click()
  await expect(page.getByTestId("settings")).toHaveCount(0)
  await watchMotion(page)
  await toggle.click()
  expect(await page.locator("[data-closing=true]").count()).toBe(0)
  await toggle.click()
  await header(research).hover()
  await research.getByTestId("section-menu").click()
  await page.keyboard.press("Escape")
  const moving = (await seenMotion(page)).filter((m) => m.duration > 0)
  expect(moving, JSON.stringify(moving.slice(0, 3))).toEqual([])
  await app.close()
  await mock.close()
})
