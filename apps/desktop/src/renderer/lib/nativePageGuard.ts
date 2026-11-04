/**
 * A native page (the Teams page, the browser of an agent) is a view above this screen. On macOS the
 * window asks the drag areas of this screen about every point, also under a view that lies above,
 * and takes a yes at once: a press on the page then starts a window drag and never reaches the page.
 * Electron 45 has this fault (electron/electron#41002; the fix is in a later version).
 *
 * So each shown page gets one empty guard box over its place. The guard has no drag, and it is the
 * last element of the document. The window builds its drag areas in the order of the document, and
 * the last element at a point decides, so the guard cuts every drag area that lies before it, now
 * and later, whatever the screen draws under the page.
 */

const ATTRIBUTE = "data-native-guard"
/** The guard is a little larger than the place, so a rounded edge leaves no drag line. */
const MARGIN = 2

interface Guard {
  readonly el: HTMLElement
  key: string
}

const guards = new Map<string, Guard>()

const make = (): HTMLElement => {
  const el = document.createElement("div")
  el.setAttribute(ATTRIBUTE, "")
  el.setAttribute("aria-hidden", "true")
  el.style.position = "fixed"
  el.style.pointerEvents = "none"
  el.style.setProperty("-webkit-app-region", "no-drag")
  return el
}

/** True when an element that is no guard comes after this one in the document. */
const hasNonGuardBehind = (el: HTMLElement): boolean => {
  for (let next = el.nextElementSibling; next; next = next.nextElementSibling)
    if (!next.hasAttribute(ATTRIBUTE)) return true
  return false
}

/**
 * Puts the guard of one page over `rect` (CSS px of this screen), or takes it away with `null`.
 * Call it on each frame that measures the place: it does nothing when nothing changed.
 */
export const guardNativePage = (
  id: string,
  rect: { x: number; y: number; width: number; height: number } | null,
) => {
  const known = guards.get(id)
  if (!rect) {
    known?.el.remove()
    guards.delete(id)
    return
  }
  const guard = known ?? { el: make(), key: "" }
  guards.set(id, guard)
  const key = `${rect.x},${rect.y},${rect.width},${rect.height}`
  if (key !== guard.key) {
    guard.key = key
    guard.el.style.left = `${rect.x - MARGIN}px`
    guard.el.style.top = `${rect.y - MARGIN}px`
    guard.el.style.width = `${rect.width + MARGIN * 2}px`
    guard.el.style.height = `${rect.height + MARGIN * 2}px`
  }
  // Something that the screen draws later (a layer, a toast) may come after the guard.
  if (guard.el.parentElement !== document.body || hasNonGuardBehind(guard.el))
    document.body.append(guard.el)
}
