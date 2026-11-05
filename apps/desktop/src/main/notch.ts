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
 * island then keeps its usual size.
 */
const SCRIPT = `
ObjC.import("AppKit");
const s = $.NSScreen.mainScreen;
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
