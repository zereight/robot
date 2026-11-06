import { execFile } from "node:child_process"

/** Where the camera notch of a screen is, in px from the top left corner of the screen. */
export interface Notch {
  /** The left edge of the notch. */
  readonly x: number
  /** How wide the notch is. */
  readonly width: number
  /** How tall the menu bar of the screen is, which is the height of the notch. */
  readonly height: number
}

/**
 * AppKit knows where the camera notch is, and Electron does not: a `Display` holds only its
 * bounds and its work area. The two wings of the menu bar, at each side of the notch, give it.
 * The read runs in another program, so it can fail or take a moment: a screen with no notch, a
 * system where AppKit does not answer, and a read that is too slow all give no notch, and the
 * island then keeps its usual size. The read asks the first screen, which holds the menu bar and
 * is the primary display of Electron: `mainScreen` is the screen of the focused window, and that
 * may be an external screen with no notch.
 */
const SCRIPT = `
ObjC.import("AppKit");
const s = $.NSScreen.screens.objectAtIndex(0);
const l = s.auxiliaryTopLeftArea;
const r = s.auxiliaryTopRightArea;
const safe = s.safeAreaInsets;
if (!l || !r) JSON.stringify({ notch: null });
else JSON.stringify({
  left: l.origin.x + l.size.width,
  right: r.origin.x,
  height: safe.top,
});
`

/** The longest time that the app waits for the read. A slower answer is no answer. */
const NOTCH_READ_MS = 2000

/** The notch of the main screen, or null when the screen has none. */
export const readNotch = (): Promise<Notch | null> =>
  new Promise((resolve) => {
    execFile(
      "osascript",
      ["-l", "JavaScript", "-e", SCRIPT],
      { timeout: NOTCH_READ_MS },
      (error, stdout) => {
        if (error) return resolve(null)
        try {
          const value = JSON.parse(stdout) as {
            notch?: null
            left?: number
            right?: number
            height?: number
          }
          if (value.notch === null) return resolve(null)
          const { left, right, height } = value
          if (typeof left !== "number" || typeof right !== "number" || typeof height !== "number")
            return resolve(null)
          const width = right - left
          if (!(width > 0) || !(height > 0)) return resolve(null)
          return resolve({
            x: Math.round(left),
            width: Math.round(width),
            height: Math.round(height),
          })
        } catch {
          resolve(null)
        }
      },
    )
  })

/**
 * The notch of a screen, read one time. A screen keeps its notch while the app runs, and the
 * island asks for it each time its shape changes, which is many times in a busy turn: the read
 * starts a program, so it must not run again. Every later caller gets the same promise.
 */
export const notchReader = (
  read: () => Promise<Notch | null> = readNotch,
): (() => Promise<Notch | null>) => {
  let once: Promise<Notch | null> | undefined
  return () => {
    once ??= read()
    return once
  }
}

/** A menu bar this tall or taller means that the screen may have a camera notch. */
export const NOTCH_MENU_BAR_MIN = 30

interface Rect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Where the island window goes (spec 015). It is centred at the top of the screen. With a camera
 * notch, the window starts at the top edge, so the bar sits around the notch and is at least as
 * tall as it. A screen without a notch, or with a notch that is not known yet, keeps the window
 * under the menu bar.
 */
export const islandBounds = (
  screen: { bounds: Rect; workArea: Rect },
  notch: Notch | null,
  size: { width: number; height: number },
): Rect => {
  const { bounds, workArea } = screen
  const menuBar = workArea.y - bounds.y
  const notchHeight = notch?.height ?? 0
  const joinsNotch = notchHeight > 0 && menuBar >= NOTCH_MENU_BAR_MIN
  return {
    x: Math.round(bounds.x + (bounds.width - size.width) / 2),
    y: joinsNotch ? bounds.y : bounds.y + menuBar,
    width: size.width,
    height: Math.max(size.height, joinsNotch ? notchHeight : 0),
  }
}
