import type { PageInputNote } from "@robot/shared"

/**
 * The diagnostic report of the app. Something that does not take a click has two causes that look
 * alike: the click never reaches it, or it does not act on the click. These counters keep both
 * sides apart, and the report says which side is quiet. They count for each place that takes
 * input: the screen of the app, the Teams page and the browser page of each agent. A line of the
 * log or the report holds sizes, places, counts and the tag of an element. It never holds a
 * password, a text of a page, a message, or an address beyond its host (spec 000: no secret in a
 * log or a report).
 */

/** What one page has counted since it opened. */
export interface InputCounts {
  /** Presses and releases that the window gave to the page. */
  readonly nativeDown: number
  readonly nativeUp: number
  /** Presses and releases that the flag of the user input kept out of the page. */
  readonly refusedDown: number
  readonly refusedUp: number
  /**
   * Presses that the app screen under the page received inside the place of the page. A press that
   * lands there did not go to the page, although the page is drawn above that spot.
   */
  readonly screenDown: number
  /**
   * Pointer moves that the app screen under the page received inside the place of the page. With
   * no move at the page view, they tell a page that the pointer cannot hit (another view covers
   * it) from a place where nothing gets an event at all.
   */
  readonly screenMove: number
  /** Moves and wheel turns. Only counted: they come too often for a log. */
  readonly nativeMove: number
  readonly nativeWheel: number
  /** What the document of the page received. */
  readonly pointerDown: number
  readonly click: number
  readonly touchStart: number
  /** Events of the document that a script made. */
  readonly untrusted: number
  /** Events of the document whose pointer was a finger or a pen. */
  readonly touchLike: number
  /**
   * Samples (about one in 150 ms) in which the pointer of the system was inside the place of the
   * page. It tells a page that nobody pointed at from a page that got no event although the
   * pointer was over it.
   */
  readonly hovered: number
  /** Lines the log dropped, because input came too fast. */
  readonly dropped: number
}

export type DiagWrite = (event: string, data: Record<string, unknown>) => void

/** Lines about input that one page may write in one minute. */
const LINES_PER_MINUTE = 90
/** Lines about changes of the page (place, flag, load) that one page may write in one minute. */
const STATE_LINES_PER_MINUTE = 60
const MINUTE_MS = 60_000

/**
 * A budget of lines for each minute: the call says whether one more line may be written. `onDrop`
 * runs for each line that the budget keeps out.
 */
export const lineBudget = (
  max: number,
  now: () => number = Date.now,
  onDrop: () => void = () => {},
): (() => boolean) => {
  let windowStart = 0
  let used = 0
  return () => {
    const t = now()
    if (t - windowStart >= MINUTE_MS) {
      windowStart = t
      used = 0
    }
    if (used >= max) {
      onDrop()
      return false
    }
    used++
    return true
  }
}

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0

/** Reads a note that came from a page. A page cannot be trusted: only known, short values pass. */
export const cleanInputNote = (value: unknown): PageInputNote | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.type !== "pointerdown" && v.type !== "click" && v.type !== "touchstart") return undefined
  const pointer = typeof v.pointer === "string" ? v.pointer : ""
  const tag = typeof v.tag === "string" && /^[a-z][a-z0-9-]{0,23}$/.test(v.tag) ? v.tag : ""
  // The test id of an element of the app screen. A web page never sends one.
  const target =
    typeof v.target === "string" && /^[a-z0-9][a-z0-9_:.-]{0,47}$/i.test(v.target) ? v.target : ""
  return {
    type: v.type,
    pointer: ["mouse", "touch", "pen"].includes(pointer) ? pointer : "",
    trusted: v.trusted === true,
    tag,
    ...(target ? { target } : {}),
    x: finite(v.x),
    y: finite(v.y),
    width: finite(v.width),
    height: finite(v.height),
  }
}

/** The counters of one page, and the lines that it writes to the log. */
export interface InputDiagnostics {
  /** A mouse event that the window gave to the page. `refused` is true when the app kept it out. */
  native(type: string, at: { x: number; y: number }, refused: boolean): void
  /** One look at the pointer of the system: is it inside the place of the page? */
  hover(inside: boolean): void
  /** A press that the app screen received inside the place of this page. */
  screen(at: { x: number; y: number }): void
  /** A pointer move that the app screen received inside the place of this page. */
  screenMove(): void
  /** An input that reached the document of the page. */
  page(note: PageInputNote): void
  /** A change of the page (a place, a flag, a load). */
  state(event: string, data: Record<string, unknown>): void
  counts(): InputCounts
  /** Starts the counts again, for a page that opens again. */
  reset(): void
}

export const createInputDiagnostics = (
  write: DiagWrite,
  now: () => number = Date.now,
): InputDiagnostics => {
  let c: { -readonly [K in keyof InputCounts]: InputCounts[K] }
  const zero = () => {
    c = {
      nativeDown: 0,
      nativeUp: 0,
      refusedDown: 0,
      refusedUp: 0,
      screenDown: 0,
      screenMove: 0,
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
  }
  zero()
  const budget = (max: number) => lineBudget(max, now, () => c.dropped++)
  const room = budget(LINES_PER_MINUTE)
  // A drag of the window can move the place of a page on each frame. The budget keeps the log for the clicks.
  const stateRoom = budget(STATE_LINES_PER_MINUTE)
  return {
    native: (type, at, refused) => {
      if (type === "mouseMove") {
        c.nativeMove++
        return
      }
      if (type === "mouseWheel") {
        c.nativeWheel++
        return
      }
      const down = type === "mouseDown" || type === "contextMenu"
      const up = type === "mouseUp"
      if (!down && !up) return
      if (down) {
        c.nativeDown++
        if (refused) c.refusedDown++
      } else {
        c.nativeUp++
        if (refused) c.refusedUp++
      }
      // A release that went through is the usual end of a press: it adds nothing to the log.
      if (up && !refused) return
      if (room()) write("native_input", { type, x: finite(at.x), y: finite(at.y), refused })
    },
    hover: (inside) => {
      if (inside) c.hovered++
    },
    screenMove: () => {
      c.screenMove++
    },
    screen: (at) => {
      c.screenDown++
      if (room()) write("screen_input", { x: finite(at.x), y: finite(at.y) })
    },
    page: (note) => {
      if (note.type === "pointerdown") c.pointerDown++
      else if (note.type === "click") c.click++
      else c.touchStart++
      if (!note.trusted) c.untrusted++
      if (note.pointer === "touch" || note.pointer === "pen") c.touchLike++
      if (room()) write("page_input", { ...note })
    },
    state: (event, data) => {
      if (stateRoom()) write(event, data)
    },
    counts: () => ({ ...c }),
    reset: zero,
  }
}

// --- The report -------------------------------------------------------------------------------

export interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** What one place that takes input says about itself when the report is made. */
export interface PageSnapshot {
  /**
   * "app" for the screen of the app itself, "teams" for the Teams page, "agent" for the browser
   * page of an agent. No id of an agent.
   */
  readonly page: "app" | "teams" | "agent"
  readonly open: boolean
  /** True for a page that fills its place with no scale. */
  readonly plain: boolean
  /** The flag that lets the input of the user in. */
  readonly userInput: boolean
  /** The place that the screen gave, in CSS px. Null while the page is hidden. */
  readonly placed: Box | null
  /** The bounds that the native view has now, in window px. */
  readonly view: Box | null
  readonly visible: boolean | null
  readonly zoom: number | null
  readonly inWindow: "main" | "shelf" | "none"
  /** The place of the view among the views of its window: the last one is the top one. */
  readonly stackIndex: number | null
  readonly stackSize: number | null
  readonly pageFocused: boolean | null
  readonly windowFocused: boolean | null
  readonly loading: boolean | null
  /** The host of the address, never the path or the query. */
  readonly host: string
  /** How long the page had a place on the screen since it opened, in ms. Always 0 for the screen. */
  readonly shownMs: number
  /**
   * What the page declared about drag areas of the window, at the load where it declared the most.
   * The app cancels them with a style sheet of its own, but the numbers stay. Null: no load yet.
   */
  readonly pageDrag: PageDrag | null
  readonly counts: InputCounts
}

/** The drag areas that a web page declared in its own style (`-webkit-app-region`). */
export interface PageDrag {
  readonly host: string
  readonly drag: number
  readonly noDrag: number
  /** How many elements were looked at, and how many the document had. */
  readonly scanned: number
  readonly total: number
}

/** What the screen of the app measures around the place of one native page. */
export interface BoxMeasure {
  /** The kind of page that the box is for. */
  readonly page: "teams" | "agent"
  readonly rect: Box
  readonly innerWidth: number
  readonly innerHeight: number
  readonly pixelRatio: number
  /** Elements that still make a drag area of the window over the place. */
  readonly dragAreasOver: readonly string[]
  /** How many of the sampled points of the place lie in a drag area. */
  readonly dragPoints: number
  /** How many points were sampled. */
  readonly samples: number
  /** When the screen measured this. Set by the app. A box that left the screen keeps its last numbers. */
  readonly measuredAt?: string
}

const near = (a: number, b: number, slack = 2) => Math.abs(a - b) <= slack

/** True when the place has taken or shown any input, so it has something to report. */
const hasCounts = (c: InputCounts): boolean =>
  c.nativeDown + c.nativeUp + c.nativeMove + c.nativeWheel + c.screenDown + c.screenMove > 0 ||
  c.pointerDown + c.click + c.touchStart > 0

/**
 * The places that the report is about: the screen of the app always, and a page that is open or
 * has counted input. A page that never opened has nothing to say. The screen comes first, then
 * the Teams page, then the pages of the agents; an open page comes before a closed one.
 */
export const reportedPages = (pages: readonly PageSnapshot[]): PageSnapshot[] => {
  const rank = (p: PageSnapshot) => (p.page === "app" ? 0 : p.page === "teams" ? 1 : 2)
  return pages
    .filter((p) => p.page === "app" || p.open || p.shownMs > 0 || hasCounts(p.counts))
    .map((page, order) => ({ page, order }))
    .sort(
      (a, b) =>
        rank(a.page) - rank(b.page) ||
        Number(b.page.open) - Number(a.page.open) ||
        a.order - b.order,
    )
    .map((entry) => entry.page)
}

const labelOf = (page: PageSnapshot, shown: readonly PageSnapshot[]): string => {
  if (page.page === "app") return "App screen"
  if (page.page === "teams") return "Teams page"
  const agents = shown.filter((p) => p.page === "agent")
  return agents.length > 1 ? `Agent page ${agents.indexOf(page) + 1}` : "Agent page"
}

/** What the counts of one place say. `who` is how the finding names the place. */
const countFindings = (p: PageSnapshot, who: "screen" | "page"): string[] => {
  const out: string[] = []
  const c = p.counts
  // The app screen is always where it is. A page gets input only when the screen gave it a place,
  // or when it had one before it closed.
  const placed = who === "screen" ? p.open : p.placed !== null || p.shownMs > 0
  const seconds = Math.round(p.shownMs / 1000)
  const pressed = c.nativeDown + c.touchStart + c.pointerDown
  const moved = c.nativeMove + c.nativeWheel
  if (placed && pressed === 0 && moved === 0) {
    if (who === "screen")
      out.push(
        "Nothing reached the app screen yet: no press, no touch and no pointer move. Click in the app a few times, then make the report again.",
      )
    else if (seconds < 3)
      out.push(
        "Nothing reached the page yet: no press, no touch and no pointer move. Move the pointer over the page and click a few times, then make the report again.",
      )
    else
      out.push(
        `The page was shown for ${seconds} s and its view got no event at all: no press, no touch and no pointer move. ${
          c.screenMove > 0
            ? `The app screen under it got ${c.screenMove} pointer moves inside the place of the page, so the pointer does not hit the page view: another view covers it.`
            : "The app screen under it got no pointer move there either, so something outside both takes the events: a drag area of the window, another window, or the system."
        }`,
      )
  } else if (placed && pressed === 0)
    out.push(
      `The pointer moved over ${who === "screen" ? "the app screen" : "the page"} (${moved} events) but no press or touch reached it. Something takes the press before the view: a drag area of the window, or the system.`,
    )
  if (c.refusedDown > 0)
    out.push(`${c.refusedDown} press(es) were kept out by the flag of user input.`)
  if (c.nativeDown > c.refusedDown && c.pointerDown === 0 && c.touchStart === 0)
    out.push(
      who === "screen"
        ? "Presses reach the window but not the document of the app screen. The screen is stuck, or it does not run."
        : "Presses reach the view but not the document of the page. The page or the system takes them in between.",
    )
  if (c.touchLike > 0 && c.nativeDown === 0)
    out.push(
      "The document got touches while the window gave the view no mouse press: the input is a finger or a pen.",
    )
  if (c.pointerDown > 0 && c.click === 0)
    out.push(
      who === "screen"
        ? "The document gets the press but no click. Something takes the release, or a drag starts."
        : "The document gets the press but no click. The page, or a drag, takes it.",
    )
  if (c.untrusted > 0)
    out.push(`${c.untrusted} event(s) of the document were made by a script, not by the user.`)
  if (c.dropped > 0) out.push(`${c.dropped} line(s) of the log were dropped for speed.`)
  return out
}

/** What the place and the state of one page say. The screen of the app has no place to check. */
const placeFindings = (p: PageSnapshot, box: BoxMeasure | undefined): string[] => {
  const out: string[] = []
  // A press that hit the screen under the page stays true after the page closed.
  const underPage =
    p.counts.screenDown > 0
      ? `${p.counts.screenDown} press(es) went to the app screen under the page, inside its place. The system hit the screen, not the page view, although the page is drawn above it.`
      : undefined
  const drag = p.pageDrag
  const pageDragLine =
    drag && drag.drag > 0
      ? `The page itself declares ${drag.drag} drag area(s) of the window (${drag.host || "no host"}; ${drag.scanned} of ${drag.total} elements looked at). A press in such an area drags the window and never reaches the page. The app cancels them with a style sheet of its own.`
      : undefined
  if (!p.open) {
    out.push(
      `The page is not open now. The counts below are from its last time open, which had a place for ${Math.round(p.shownMs / 1000)} s.`,
    )
    if (pageDragLine) out.push(pageDragLine)
    if (underPage) out.push(underPage)
    return out
  }
  if (pageDragLine) out.push(pageDragLine)
  if (!p.placed)
    out.push("The screen gave the page no place, so the page is hidden. Nothing can be clicked.")
  if (p.placed && p.view) {
    const zoom = p.zoom ?? 1
    if (!near(p.view.width, p.placed.width * zoom) || !near(p.view.height, p.placed.height * zoom))
      out.push(
        "The view has another size than the place that the screen gave. Clicks land off the picture.",
      )
  }
  if (p.placed && p.visible === false)
    out.push("The view is hidden although the screen gave it a place.")
  if (!p.userInput) out.push("The flag of user input is off: the app keeps clicks out.")
  if (p.placed && p.stackIndex !== null && p.stackSize !== null && p.stackIndex !== p.stackSize - 1)
    out.push("Another view of the window is above the page. It takes the clicks.")
  if (box && box.dragAreasOver.length > 0)
    out.push(
      `A drag area of the window lies over the place of the page (${box.dragAreasOver.join(", ")}; ${box.dragPoints} of ${box.samples} points). The system can take a press there as the start of a window drag.`,
    )
  if (underPage) out.push(underPage)
  return out
}

/** What the numbers say, in plain words. The first line is the most likely one. */
export const findings = (
  pages: readonly PageSnapshot[],
  boxes: readonly BoxMeasure[] = [],
): string[] => {
  const shown = reportedPages(pages)
  const out: string[] = []
  for (const p of shown) {
    const label = labelOf(p, shown)
    const lines =
      p.page === "app"
        ? [
            ...(!p.open ? ["The main window is not open."] : []),
            ...(p.open && p.windowFocused === false
              ? ["The window has no focus. The first click may only give it the focus."]
              : []),
            ...countFindings(p, "screen"),
          ]
        : [
            ...placeFindings(
              p,
              boxes.find((b) => b.page === p.page),
            ),
            ...countFindings(p, "page"),
          ]
    for (const line of lines) out.push(`[${label}] ${line}`)
  }
  if (shown.every((p) => p.page === "app"))
    out.push("[Pages] No browser page has been opened since the app started.")
  if (out.length === 0)
    out.push("The numbers show no fault. Clicks reach the screen, the pages and their documents.")
  return out
}

export interface ReportInput {
  readonly madeAt: string
  readonly app: Record<string, unknown>
  readonly displays: readonly Record<string, unknown>[]
  readonly window: Record<string, unknown> | null
  /** The processes of the app: kind, load and memory. */
  readonly processes: readonly Record<string, unknown>[]
  readonly boxes: readonly BoxMeasure[]
  readonly pages: readonly PageSnapshot[]
  readonly logs: readonly { readonly name: string; readonly lines: readonly string[] }[]
}

/** The text of the report. It is plain, so the user can paste it anywhere. */
export const buildReport = (input: ReportInput): string => {
  const shown = reportedPages(input.pages)
  const parts: string[] = [
    "ROBot diagnostic report",
    `Made at: ${input.madeAt}`,
    "It holds sizes, places, counts and hosts of addresses. It holds no password, no text of a page and no message.",
    "",
    "== What the numbers say ==",
    ...findings(input.pages, input.boxes).map((line) => `- ${line}`),
    "",
    "== App and computer ==",
    JSON.stringify(input.app, null, 2),
    "",
    "== Displays ==",
    JSON.stringify(input.displays, null, 2),
    "",
    "== Main window ==",
    JSON.stringify(input.window, null, 2),
    "",
    "== Processes ==",
    JSON.stringify(input.processes, null, 2),
    "",
    "== Places of the pages, as the screen measures them ==",
    JSON.stringify(input.boxes, null, 2),
    "",
    "== Places that take input (the app screen, then the pages) ==",
    JSON.stringify(shown, null, 2),
  ]
  for (const log of input.logs) {
    parts.push("", `== Log: ${log.name} (newest ${log.lines.length} lines) ==`, ...log.lines)
  }
  return `${parts.join("\n")}\n`
}

/**
 * The attribute that marks an empty box of the app screen where a native page shows. Its value is
 * the kind of page: "teams" or "agent".
 */
export const NATIVE_PAGE_ATTRIBUTE = "data-native-page"

/**
 * The script that the app screen runs for the report. It lists the drag areas of the document the
 * way the window builds them: every element in the order of the document, the parent before its
 * children, a drag element adds its rectangle and a no-drag element cuts it, so the last element at
 * a point decides. Then it samples a grid of points over each box where a native page shows, and
 * names the elements that still make a drag area there. It changes nothing. It gives back a list
 * of `BoxMeasure`, empty when no box is on the screen.
 */
export const BOX_SCRIPT = `(() => {
  try {
    const modeOf = (el) => getComputedStyle(el).getPropertyValue("-webkit-app-region") || "none"
    const regions = []
    for (const el of document.querySelectorAll("*")) {
      const mode = modeOf(el)
      if (mode !== "drag" && mode !== "no-drag") continue
      const style = getComputedStyle(el)
      if (style.visibility !== "visible" || style.display === "none") continue
      const r = el.getBoundingClientRect()
      const testid = el.getAttribute("data-testid")
      regions.push({
        drag: mode === "drag",
        x: r.left, y: r.top, right: r.right, bottom: r.bottom,
        name: el.tagName.toLowerCase() + (el.classList[0] ? "." + el.classList[0] : "") + (testid ? "#" + testid : ""),
      })
    }
    const covers = (g, px, py) => px >= g.x && px < g.right && py >= g.y && py < g.bottom
    const GRID = 8
    return Array.from(document.querySelectorAll("[${NATIVE_PAGE_ATTRIBUTE}]")).map((box) => {
      const r = box.getBoundingClientRect()
      const names = new Set()
      let dragPoints = 0
      for (let i = 0; i < GRID; i++) {
        for (let j = 0; j < GRID; j++) {
          const px = r.left + (r.width * (i + 0.5)) / GRID
          const py = r.top + (r.height * (j + 0.5)) / GRID
          let last
          for (const g of regions) if (covers(g, px, py)) last = g
          if (last && last.drag) {
            dragPoints++
            names.add(last.name)
          }
        }
      }
      return {
        page: box.getAttribute("${NATIVE_PAGE_ATTRIBUTE}") === "teams" ? "teams" : "agent",
        rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        pixelRatio: window.devicePixelRatio,
        dragAreasOver: Array.from(names),
        dragPoints,
        samples: GRID * GRID,
      }
    })
  } catch {
    return []
  }
})()`

/**
 * The script that a web page runs once at each load, before the app cancels its drag areas: how
 * many elements declare a drag area of the window, and how many cut one. It looks at no more than
 * 8000 elements, reads no text, and changes nothing. It gives back a \`PageDrag\` without the host.
 */
export const PAGE_DRAG_SCRIPT = `(() => {
  try {
    const all = document.querySelectorAll("*")
    const scanned = Math.min(all.length, 8000)
    let drag = 0
    let noDrag = 0
    for (let i = 0; i < scanned; i++) {
      const mode = getComputedStyle(all[i]).getPropertyValue("-webkit-app-region")
      if (mode === "drag") drag++
      else if (mode === "no-drag") noDrag++
    }
    return { drag, noDrag, scanned, total: all.length }
  } catch {
    return null
  }
})()`

/**
 * The style sheet that the app puts on every web page (as a user sheet, so it beats the page even
 * when the page says \`!important\`). A web page is never a handle of the window: a drag area that
 * a page declares would take the presses of the user before the page sees them (spec 007, 028).
 * The value is \`initial\`, not \`none\`: this engine reads an explicit \`none\` as \`no-drag\`, which
 * would still make a region for each element of the page.
 */
export const PAGE_NO_DRAG_CSS = "*, *::before, *::after { -webkit-app-region: initial !important; }"
