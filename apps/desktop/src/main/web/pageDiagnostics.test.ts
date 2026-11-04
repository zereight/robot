import { describe, expect, test } from "bun:test"
import {
  BOX_SCRIPT,
  type BoxMeasure,
  buildReport,
  cleanInputNote,
  createInputDiagnostics,
  findings,
  lineBudget,
  NATIVE_PAGE_ATTRIBUTE,
  type PageSnapshot,
  reportedPages,
} from "./pageDiagnostics.ts"

const lines = () => {
  const written: { event: string; data: Record<string, unknown> }[] = []
  return {
    written,
    write: (event: string, data: Record<string, unknown>) => void written.push({ event, data }),
  }
}

const note = {
  type: "pointerdown",
  pointer: "mouse",
  trusted: true,
  tag: "button",
  x: 10,
  y: 20,
  width: 800,
  height: 440,
}

describe("line budget", () => {
  test("lets a number of lines through each minute and counts the rest", () => {
    let t = 0
    let dropped = 0
    const room = lineBudget(
      2,
      () => t,
      () => dropped++,
    )
    expect([room(), room(), room()]).toEqual([true, true, false])
    expect(dropped).toBe(1)
    t = 60_000
    expect(room()).toBe(true)
  })
})

describe("input counts", () => {
  test("a press that the window gives is counted and logged, a move is only counted", () => {
    const { written, write } = lines()
    const diag = createInputDiagnostics(write)
    diag.native("mouseDown", { x: 5.4, y: 6.6 }, false)
    diag.native("mouseUp", { x: 5, y: 7 }, false)
    diag.native("mouseMove", { x: 1, y: 1 }, false)
    diag.native("mouseWheel", { x: 1, y: 1 }, false)
    expect(diag.counts()).toMatchObject({
      nativeDown: 1,
      nativeUp: 1,
      nativeMove: 1,
      nativeWheel: 1,
    })
    // The release that went through adds no line: the press already tells the click.
    expect(written).toEqual([
      { event: "native_input", data: { type: "mouseDown", x: 5, y: 7, refused: false } },
    ])
  })

  test("a press that the flag keeps out is counted and logged with its release", () => {
    const { written, write } = lines()
    const diag = createInputDiagnostics(write)
    diag.native("mouseDown", { x: 1, y: 2 }, true)
    diag.native("mouseUp", { x: 1, y: 2 }, true)
    expect(diag.counts()).toMatchObject({
      nativeDown: 1,
      refusedDown: 1,
      nativeUp: 1,
      refusedUp: 1,
    })
    expect(written.map((w) => w.data.refused)).toEqual([true, true])
  })

  test("the document side counts pointers, scripts and fingers", () => {
    const { written, write } = lines()
    const diag = createInputDiagnostics(write)
    diag.page({ ...note })
    diag.page({ ...note, type: "click", trusted: false })
    diag.page({ ...note, type: "touchstart", pointer: "touch" })
    expect(diag.counts()).toMatchObject({
      pointerDown: 1,
      click: 1,
      touchStart: 1,
      untrusted: 1,
      touchLike: 1,
    })
    expect(written).toHaveLength(3)
    expect(written[0]?.event).toBe("page_input")
  })

  test("a flood of input writes a limited number of lines and counts the rest", () => {
    let now = 1_000
    const { written, write } = lines()
    const diag = createInputDiagnostics(write, () => now)
    for (let i = 0; i < 200; i++) diag.page({ ...note })
    expect(written.length).toBe(90)
    expect(diag.counts().dropped).toBe(110)
    expect(diag.counts().pointerDown).toBe(200)
    // The next minute has room again.
    now += 60_000
    diag.page({ ...note })
    expect(written.length).toBe(91)
  })

  test("changes of the place have a budget of their own, so a window drag leaves room for clicks", () => {
    const { written, write } = lines()
    const diag = createInputDiagnostics(write, () => 5_000)
    for (let i = 0; i < 500; i++) diag.state("placed", { i })
    expect(written.length).toBe(60)
    diag.native("mouseDown", { x: 1, y: 1 }, false)
    expect(written.length).toBe(61)
    expect(diag.counts().dropped).toBe(440)
  })

  test("a press on the screen under the page is counted and logged", () => {
    const { written, write } = lines()
    const diag = createInputDiagnostics(write)
    diag.screen({ x: 300.2, y: 600.7 })
    expect(diag.counts().screenDown).toBe(1)
    expect(written).toEqual([{ event: "screen_input", data: { x: 300, y: 601 } }])
  })

  test("reset starts the counts again", () => {
    const diag = createInputDiagnostics(() => {})
    diag.native("mouseDown", { x: 0, y: 0 }, false)
    diag.reset()
    expect(diag.counts().nativeDown).toBe(0)
  })
})

describe("notes from a page", () => {
  test("a good note passes", () => {
    expect(cleanInputNote(note)).toEqual(note)
  })

  test("the test id of an element of the app screen passes, text does not", () => {
    expect(cleanInputNote({ ...note, target: "settings-nav-data" })).toMatchObject({
      target: "settings-nav-data",
    })
    expect(cleanInputNote({ ...note, target: "my secret text" })?.target).toBeUndefined()
    expect(cleanInputNote({ ...note, target: "x".repeat(60) })?.target).toBeUndefined()
  })

  test("a page cannot put text or a wrong kind into a note", () => {
    expect(cleanInputNote({ ...note, type: "keydown" })).toBeUndefined()
    expect(cleanInputNote(null)).toBeUndefined()
    expect(cleanInputNote("click")).toBeUndefined()
    const cleaned = cleanInputNote({
      ...note,
      tag: "div class=secret-token",
      pointer: "my-password",
      x: "12",
      trusted: "yes",
    })
    expect(cleaned).toMatchObject({ tag: "", pointer: "", x: 0, trusted: false })
  })
})

const counts = {
  nativeDown: 0,
  nativeUp: 0,
  refusedDown: 0,
  refusedUp: 0,
  screenDown: 0,
  nativeMove: 0,
  nativeWheel: 0,
  pointerDown: 0,
  click: 0,
  touchStart: 0,
  untrusted: 0,
  touchLike: 0,
  hovered: 0,
  dropped: 0,
}

const teams = (
  patch: Partial<PageSnapshot> = {},
  c: Partial<typeof counts> = {},
): PageSnapshot => ({
  page: "teams",
  open: true,
  plain: true,
  userInput: true,
  placed: { x: 10, y: 10, width: 800, height: 440 },
  view: { x: 10, y: 10, width: 800, height: 440 },
  visible: true,
  zoom: 1,
  inWindow: "main",
  stackIndex: 2,
  stackSize: 3,
  pageFocused: true,
  windowFocused: true,
  loading: false,
  host: "teams.microsoft.com",
  counts: { ...counts, ...c },
  ...patch,
})

const app = (patch: Partial<PageSnapshot> = {}, c: Partial<typeof counts> = {}): PageSnapshot => ({
  ...teams(),
  page: "app",
  placed: null,
  host: "",
  stackIndex: null,
  stackSize: null,
  counts: { ...counts, ...c },
  ...patch,
})

const agent = (
  patch: Partial<PageSnapshot> = {},
  c: Partial<typeof counts> = {},
): PageSnapshot => ({
  ...teams(),
  page: "agent",
  host: "example.com",
  counts: { ...counts, ...c },
  ...patch,
})

const box = (dragAreasOver: string[] = [], page: "teams" | "agent" = "teams"): BoxMeasure => ({
  page,
  rect: { x: 10, y: 10, width: 800, height: 440 },
  innerWidth: 1200,
  innerHeight: 800,
  pixelRatio: 2,
  dragAreasOver,
  dragPoints: dragAreasOver.length > 0 ? 3 : 0,
})

/** Presses and a click, as a screen that works counts them. */
const working = { nativeDown: 2, nativeUp: 2, pointerDown: 2, click: 2 }

describe("findings", () => {
  test("with no browser page opened, the report says so", () => {
    expect(findings([app({}, working)]).join("\n")).toContain("No browser page has been opened")
  })

  test("nothing at all asks for a pointer over the page and clicks", () => {
    expect(findings([teams()], [box()]).join("\n")).toContain("Nothing reached the page yet")
  })

  test("a pointer that moves with no press points at what lies before the view", () => {
    const out = findings([teams({}, { nativeMove: 40 })], [box(["div.rail"])])
    expect(out.join("\n")).toContain("no press or touch reached it")
    expect(out.join("\n")).toContain("drag area of the window lies over the place")
    expect(out.join("\n")).toContain("3 of 9 points")
    expect(out.join("\n")).toContain("div.rail")
  })

  test("a quiet document is told from a quiet window", () => {
    const inBetween = findings([teams({}, { nativeDown: 3, nativeUp: 3 })], [box()])
    expect(inBetween.join("\n")).toContain("reach the view but not the document")
    const swallowed = findings([teams({}, { nativeDown: 2, pointerDown: 2 })], [box()])
    expect(swallowed.join("\n")).toContain("no click")
  })

  test("a press that lands on the screen under the page is named first", () => {
    const out = findings([teams({}, { screenDown: 2, nativeMove: 9 })], [box()])
    expect(out[0]).toContain("2 press(es) went to the app screen under the page")
  })

  test("the flag, the stack and the size are checked", () => {
    expect(findings([teams({ userInput: false })], [box()]).join("\n")).toContain(
      "flag of user input is off",
    )
    expect(findings([teams({ stackIndex: 0 })], [box()]).join("\n")).toContain("Another view")
    expect(
      findings([teams({ view: { x: 10, y: 10, width: 400, height: 440 } })], [box()]).join("\n"),
    ).toContain("another size")
    expect(findings([teams({ placed: null })], [box()]).join("\n")).toContain("no place")
    // A page that closed after it took input says so. One that never took any is left out.
    expect(findings([teams({ open: false }, { nativeDown: 1 })], [box()]).join("\n")).toContain(
      "not open",
    )
  })

  test("fingers on a window with no mouse press are named", () => {
    const out = findings([teams({}, { touchStart: 2, pointerDown: 2, touchLike: 2 })], [box()])
    expect(out.join("\n")).toContain("a finger or a pen")
  })

  test("clean numbers say there is no fault", () => {
    const out = findings([app({}, working), teams({}, working)], [box()])
    expect(out).toEqual([
      "The numbers show no fault. Clicks reach the screen, the pages and their documents.",
    ])
  })

  test("the app screen is judged on its own: a window that gets presses its document never sees", () => {
    const out = findings([app({}, { nativeDown: 3, nativeUp: 3 })])
    expect(out.join("\n")).toContain("[App screen] Presses reach the window but not the document")
    // A screen that takes no press at all asks for clicks, not for a place.
    expect(findings([app()]).join("\n")).toContain("Nothing reached the app screen yet")
    expect(findings([app({ open: false })]).join("\n")).toContain("main window is not open")
  })

  test("each finding names its place, and the app screen comes before the pages", () => {
    const out = findings(
      [
        agent({}, { nativeMove: 5 }),
        teams({ userInput: false }, working),
        app({}, { nativeDown: 1, nativeUp: 1 }),
      ],
      [box(["div.rail"], "agent")],
    )
    expect(out[0]).toContain("[App screen]")
    expect(out.findIndex((l) => l.startsWith("[Teams page]"))).toBeLessThan(
      out.findIndex((l) => l.startsWith("[Agent page]")),
    )
    // The box of an agent page goes with the agent page, not with the Teams page.
    expect(out.find((l) => l.includes("div.rail"))).toContain("[Agent page]")
  })

  test("a page that never opened and never counted is left out, one that closed keeps its counts", () => {
    const never = agent({ open: false, placed: null, view: null })
    const closed = teams(
      { open: false, placed: null, view: null },
      { nativeDown: 2, pointerDown: 2 },
    )
    expect(reportedPages([app(), never, closed]).map((p) => p.page)).toEqual(["app", "teams"])
    const out = findings([app({}, working), closed])
    expect(out.join("\n")).toContain("[Teams page] The page is not open now")
    expect(out.join("\n")).toContain("[Teams page] The document gets the press but no click")
    // A press that hit the screen under the page is kept after the page closed.
    const hit = findings([
      closed.page === "teams" ? { ...closed, counts: { ...closed.counts, screenDown: 1 } } : closed,
    ])
    expect(hit.join("\n")).toContain("1 press(es) went to the app screen under the page")
  })
})

describe("report", () => {
  test("holds the findings, the places, the processes and the log tails, and no address beyond its host", () => {
    const text = buildReport({
      madeAt: "2026-11-04T05:00:00.000Z",
      app: { version: "1.0.0" },
      displays: [{ scaleFactor: 2, touchSupport: "unknown" }],
      window: { focused: true },
      processes: [{ type: "Tab", cpu: 1 }],
      boxes: [box()],
      pages: [app({}, working), teams({}, { nativeDown: 1 })],
      logs: [
        { name: "app", lines: ['{"event":"window_focus"}'] },
        { name: "browser", lines: ['{"event":"native_input"}'] },
      ],
    })
    expect(text).toContain("ROBot diagnostic report")
    expect(text).toContain("== What the numbers say ==")
    expect(text).toContain("== Processes ==")
    expect(text).toContain('"host": "teams.microsoft.com"')
    expect(text).toContain('"page": "app"')
    expect(text).toContain("== Log: app (newest 1 lines) ==")
    expect(text).toContain("== Log: browser (newest 1 lines) ==")
    expect(text).toContain('{"event":"native_input"}')
    expect(text).not.toContain("https://")
  })

  test("the script that measures the boxes looks for the mark that the screen puts on them", () => {
    expect(BOX_SCRIPT).toContain(`[${NATIVE_PAGE_ATTRIBUTE}]`)
  })
})
