import { describe, expect, test } from "bun:test"
import {
  type BoxMeasure,
  buildReport,
  cleanInputNote,
  createInputDiagnostics,
  findings,
  type PageSnapshot,
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

const box = (dragAreasOver: string[] = []): BoxMeasure => ({
  rect: { x: 10, y: 10, width: 800, height: 440 },
  innerWidth: 1200,
  innerHeight: 800,
  pixelRatio: 2,
  dragAreasOver,
  dragPoints: dragAreasOver.length > 0 ? 3 : 0,
})

describe("findings", () => {
  test("a page that was never made says so", () => {
    expect(findings([], null)[0]).toContain("never made")
  })

  test("nothing at all asks for a pointer over the page and clicks", () => {
    expect(findings([teams()], box()).join("\n")).toContain("Nothing reached the page yet")
  })

  test("a pointer that moves with no press points at what lies before the view", () => {
    const out = findings([teams({}, { nativeMove: 40 })], box(["div.rail"]))
    expect(out.join("\n")).toContain("no press or touch reached it")
    expect(out.join("\n")).toContain("drag area of the window lies over the place")
    expect(out.join("\n")).toContain("3 of 9 points")
    expect(out.join("\n")).toContain("div.rail")
  })

  test("a quiet document is told from a quiet window", () => {
    const inBetween = findings([teams({}, { nativeDown: 3, nativeUp: 3 })], box())
    expect(inBetween.join("\n")).toContain("reach the view but not the document")
    const swallowed = findings([teams({}, { nativeDown: 2, pointerDown: 2 })], box())
    expect(swallowed.join("\n")).toContain("no click")
  })

  test("a press that lands on the screen under the page is named first", () => {
    const out = findings([teams({}, { screenDown: 2, nativeMove: 9 })], box())
    expect(out[0]).toContain("2 press(es) went to the app screen under the page")
  })

  test("the flag, the stack and the size are checked", () => {
    expect(findings([teams({ userInput: false })], box()).join("\n")).toContain(
      "flag of user input is off",
    )
    expect(findings([teams({ stackIndex: 0 })], box()).join("\n")).toContain("Another view")
    expect(
      findings([teams({ view: { x: 10, y: 10, width: 400, height: 440 } })], box()).join("\n"),
    ).toContain("another size")
    expect(findings([teams({ placed: null })], box()).join("\n")).toContain("no place")
    expect(findings([teams({ open: false })], box()).join("\n")).toContain("not open")
  })

  test("fingers on a window with no mouse press are named", () => {
    const out = findings([teams({}, { touchStart: 2, pointerDown: 2, touchLike: 2 })], box())
    expect(out.join("\n")).toContain("a finger or a pen")
  })

  test("clean numbers say there is no fault", () => {
    const out = findings([teams({}, { nativeDown: 2, pointerDown: 2, click: 2 })], box())
    expect(out).toEqual(["The numbers show no fault. Clicks reach the page and its document."])
  })
})

describe("report", () => {
  test("holds the findings, the pages and the log tails, and no address beyond its host", () => {
    const text = buildReport({
      madeAt: "2026-11-04T05:00:00.000Z",
      app: { version: "1.0.0" },
      displays: [{ scaleFactor: 2, touchSupport: "unknown" }],
      window: { focused: true },
      box: box(),
      pages: [teams({}, { nativeDown: 1 })],
      logs: [{ name: "browser", lines: ['{"event":"native_input"}'] }],
    })
    expect(text).toContain("ROBot diagnostic report")
    expect(text).toContain("== What the numbers say ==")
    expect(text).toContain('"host": "teams.microsoft.com"')
    expect(text).toContain("== Log: browser (newest 1 lines) ==")
    expect(text).toContain('{"event":"native_input"}')
    expect(text).not.toContain("https://")
  })
})
