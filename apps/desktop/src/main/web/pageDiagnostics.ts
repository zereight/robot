import type { PageInputNote } from "@robot/shared"

/**
 * The diagnostic report of the browser pages. A page that does not take a click has two causes that
 * look alike: the click never reaches the page, or the page does not act on it. These counters keep
 * both sides apart, and the report says which side is quiet. A line of the log or the report holds
 * sizes, places, counts and the tag of an element. It never holds a password, a text of a page, a
 * message, or an address beyond its host (spec 000: no secret in a log or a report).
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
  /** Lines the log dropped, because input came too fast. */
  readonly dropped: number
}

export type DiagWrite = (event: string, data: Record<string, unknown>) => void

/** Lines about input that one page may write in one minute. */
const LINES_PER_MINUTE = 90
/** Lines about changes of the page (place, flag, load) that one page may write in one minute. */
const STATE_LINES_PER_MINUTE = 60
const MINUTE_MS = 60_000

const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0

/** Reads a note that came from a page. A page cannot be trusted: only known, short values pass. */
export const cleanInputNote = (value: unknown): PageInputNote | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  if (v.type !== "pointerdown" && v.type !== "click" && v.type !== "touchstart") return undefined
  const pointer = typeof v.pointer === "string" ? v.pointer : ""
  const tag = typeof v.tag === "string" && /^[a-z][a-z0-9-]{0,23}$/.test(v.tag) ? v.tag : ""
  return {
    type: v.type,
    pointer: ["mouse", "touch", "pen"].includes(pointer) ? pointer : "",
    trusted: v.trusted === true,
    tag,
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
  /** A press that the app screen received inside the place of this page. */
  screen(at: { x: number; y: number }): void
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
      nativeMove: 0,
      nativeWheel: 0,
      pointerDown: 0,
      click: 0,
      touchStart: 0,
      untrusted: 0,
      touchLike: 0,
      dropped: 0,
    }
  }
  zero()
  /** A budget of lines for each minute. Input and changes of the place have one each. */
  const budget = (max: number) => {
    let windowStart = 0
    let used = 0
    return () => {
      const t = now()
      if (t - windowStart >= MINUTE_MS) {
        windowStart = t
        used = 0
      }
      if (used >= max) {
        c.dropped++
        return false
      }
      used++
      return true
    }
  }
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

/** What one page says about itself when the report is made. */
export interface PageSnapshot {
  /** "teams" for the Teams page, "agent" for the page of an agent. No id of an agent. */
  readonly page: "teams" | "agent"
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
  readonly inWindow: "main" | "shelf" | "own" | "none"
  /** The place of the view among the views of its window: the last one is the top one. */
  readonly stackIndex: number | null
  readonly stackSize: number | null
  readonly pageFocused: boolean | null
  readonly windowFocused: boolean | null
  readonly loading: boolean | null
  /** The host of the address, never the path or the query. */
  readonly host: string
  readonly counts: InputCounts
}

/** What the screen of the app measures around the place of the Teams page. */
export interface BoxMeasure {
  readonly rect: Box
  readonly innerWidth: number
  readonly innerHeight: number
  readonly pixelRatio: number
  /** Elements that still make a drag area of the window over the place. */
  readonly dragAreasOver: readonly string[]
  /** How many of nine points of the place lie in a drag area (0 to 9). */
  readonly dragPoints: number
}

const near = (a: number, b: number, slack = 2) => Math.abs(a - b) <= slack

/** What the numbers say, in plain words. The first line is the most likely one. */
export const findings = (pages: readonly PageSnapshot[], box: BoxMeasure | null): string[] => {
  const out: string[] = []
  const teams = pages.find((p) => p.page === "teams")
  if (!teams) return ["The Teams page was never made. Show the Teams page, then make the report."]
  // The Teams page has a window of its own ("own"), or it sits in the main window as a view.
  const own = teams.inWindow === "own"
  /** The user can see the page: its window shows, or the screen gave its view a place. */
  const shown = own ? teams.userInput && teams.visible !== false : teams.placed !== null
  if (!teams.open) out.push("The Teams page is not open.")
  else {
    if (own && !teams.userInput)
      out.push("The Teams window is not shown. Press “Show the Teams page” first.")
    if (own && teams.userInput && teams.visible === false)
      out.push("The Teams window is hidden although the page is shown.")
    if (!own && !teams.placed)
      out.push("The screen gave the page no place, so the page is hidden. Nothing can be clicked.")
    if (!own && teams.placed && teams.view) {
      const zoom = teams.zoom ?? 1
      if (
        !near(teams.view.width, teams.placed.width * zoom) ||
        !near(teams.view.height, teams.placed.height * zoom)
      )
        out.push(
          "The view has another size than the place that the screen gave. Clicks land off the picture.",
        )
    }
    if (!own && teams.placed && teams.visible === false)
      out.push("The view is hidden although the screen gave it a place.")
    if (!own && !teams.userInput)
      out.push("The flag of user input is off: the app keeps clicks out.")
    if (
      !own &&
      teams.placed &&
      teams.stackIndex !== null &&
      teams.stackSize !== null &&
      teams.stackIndex !== teams.stackSize - 1
    )
      out.push("Another view of the window is above the page. It takes the clicks.")
    if (!own && box && box.dragAreasOver.length > 0)
      out.push(
        `A drag area of the window lies over the place of the page (${box.dragAreasOver.join(", ")}; ${box.dragPoints} of 9 points). The system can take a press there as the start of a window drag.`,
      )
    const c = teams.counts
    if (c.screenDown > 0)
      out.push(
        `${c.screenDown} press(es) went to the app screen under the page, inside its place. The system hit the screen, not the page view, although the page is drawn above it.`,
      )
    const pressed = c.nativeDown + c.touchStart + c.pointerDown
    const moved = c.nativeMove + c.nativeWheel
    if (shown && pressed === 0 && moved === 0)
      out.push(
        "Nothing reached the page yet: no press, no touch and no pointer move. Move the pointer over the page and click a few times, then make the report again. If you did, something covers the page before its view.",
      )
    else if (shown && pressed === 0)
      out.push(
        `The pointer moved over the page (${moved} events) but no press or touch reached it. Something takes the press before the view: a drag area of the window, or the system.`,
      )
    if (c.refusedDown > 0)
      out.push(`${c.refusedDown} press(es) were kept out by the flag of user input.`)
    if (c.nativeDown > c.refusedDown && c.pointerDown === 0 && c.touchStart === 0)
      out.push(
        "Presses reach the view but not the document of the page. The page or the system takes them in between.",
      )
    if (c.touchLike > 0 && c.nativeDown === 0)
      out.push(
        "The document got touches while the window gave the view no mouse press: the input is a finger or a pen.",
      )
    if (c.pointerDown > 0 && c.click === 0)
      out.push("The document gets the press but no click. The page, or a drag, takes it.")
    if (c.untrusted > 0)
      out.push(`${c.untrusted} event(s) of the document were made by a script, not by the user.`)
    if (c.dropped > 0) out.push(`${c.dropped} line(s) of the log were dropped for speed.`)
  }
  if (out.length === 0)
    out.push("The numbers show no fault. Clicks reach the page and its document.")
  return out
}

export interface ReportInput {
  readonly madeAt: string
  readonly app: Record<string, unknown>
  readonly displays: readonly Record<string, unknown>[]
  readonly window: Record<string, unknown> | null
  readonly box: BoxMeasure | null
  readonly pages: readonly PageSnapshot[]
  readonly logs: readonly { readonly name: string; readonly lines: readonly string[] }[]
}

/** The text of the report. It is plain, so the user can paste it anywhere. */
export const buildReport = (input: ReportInput): string => {
  const parts: string[] = [
    "ROBot diagnostic report",
    `Made at: ${input.madeAt}`,
    "It holds sizes, places, counts and hosts of addresses. It holds no password, no text of a page and no message.",
    "",
    "== What the numbers say ==",
    ...findings(input.pages, input.box).map((line) => `- ${line}`),
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
    "== Place of the Teams page, as the screen measures it ==",
    JSON.stringify(input.box, null, 2),
    "",
    "== Pages ==",
    JSON.stringify(input.pages, null, 2),
  ]
  for (const log of input.logs) {
    parts.push("", `== Log: ${log.name} (newest ${log.lines.length} lines) ==`, ...log.lines)
  }
  return `${parts.join("\n")}\n`
}

/** The box on the settings screen where the Teams page shows. */
const TEAMS_BOX_SELECTOR = '[data-testid="teams-page-box"]'

/**
 * The script that the app screen runs for the report. It measures the box of the Teams page and
 * lists the elements that still make a drag area of the window at nine points of the box. The
 * window builds its drag area from the elements in the order of the document: a drag element adds
 * its rectangle and a no-drag element cuts it, so the last one at a point decides. The script does
 * the same. It changes nothing. It gives back a `BoxMeasure`, or null when the box is not on the
 * screen.
 */
export const BOX_SCRIPT = `(() => {
  try {
    const box = document.querySelector(${JSON.stringify(TEAMS_BOX_SELECTOR)})
    if (!box) return null
    const r = box.getBoundingClientRect()
    const regionOf = (el) => {
      const style = getComputedStyle(el)
      return style.getPropertyValue("-webkit-app-region") || style.webkitAppRegion || "none"
    }
    const drag = new Set()
    let dragPoints = 0
    for (const fy of [0.1, 0.5, 0.9]) {
      for (const fx of [0.1, 0.5, 0.9]) {
        const stack = document
          .elementsFromPoint(r.left + r.width * fx, r.top + r.height * fy)
          .filter((el) => regionOf(el) === "drag" || regionOf(el) === "no-drag")
          .sort((a, b) => (a === b ? 0 : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        const last = stack[stack.length - 1]
        if (last && regionOf(last) === "drag") {
          dragPoints++
          drag.add(last.tagName.toLowerCase() + (last.classList[0] ? "." + last.classList[0] : ""))
        }
      }
    }
    return {
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      pixelRatio: window.devicePixelRatio,
      dragAreasOver: Array.from(drag),
      dragPoints,
    }
  } catch {
    return null
  }
})()`
