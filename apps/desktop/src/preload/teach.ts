// The recorder of "Teach a task" (spec 017). It runs in the browser page of an agent, in a world
// that the scripts of the page cannot reach. It reports what the user does while the app records.
// Only real input of the user counts: events that a script makes are skipped.
// It also tells the diagnostic report, at the bottom of this file, that a click or a touch reached
// the document. That report has the kind of event and a place, never text of the page.
// A sandboxed preload cannot load packages, so it imports only plain constants and types, from a
// module that the preload of the window does not load.
import {
  PAGE_INPUT_CHANNEL,
  PAGE_INPUT_TYPES,
  type PageInputNote,
  TEACH_CHANNEL,
  TEACH_KEYS,
  TEACH_ON_CHANNEL,
  type TeachEvent,
} from "@robot/shared/teachPage"
import { ipcRenderer } from "electron"

let on = ipcRenderer.sendSync(TEACH_ON_CHANNEL) === true
ipcRenderer.on(TEACH_ON_CHANNEL, (_, next: boolean) => {
  on = next
})

const report = (event: TeachEvent) => {
  if (on) ipcRenderer.send(TEACH_CHANNEL, event)
}

const text = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim()

/** The text of the elements that an `aria-labelledby` names. */
const labelledBy = (el: Element) =>
  text(
    (el.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .map((id) => (id ? document.getElementById(id)?.textContent : ""))
      .join(" "),
  )

/** The label of a field: its own label, a label element, a placeholder, or its name. */
const fieldLabel = (el: Element): string => {
  const own = text(el.getAttribute("aria-label")) || labelledBy(el)
  if (own) return own
  const field = el as HTMLInputElement
  const labels = field.labels ? [...field.labels].map((l) => text(l.textContent)).join(" ") : ""
  return (
    text(labels) ||
    text(el.getAttribute("placeholder")) ||
    text(el.getAttribute("title")) ||
    text(el.getAttribute("name")) ||
    text(el.id)
  )
}

const CONTROLS =
  'a[href], button, input, select, textarea, summary, label, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [contenteditable="true"]'

const INPUT_ROLES: Record<string, string> = {
  button: "button",
  submit: "button",
  reset: "button",
  image: "button",
  checkbox: "checkbox",
  radio: "radio",
  range: "slider",
  file: "file field",
}

/** The role of a control, as a person would name it. */
const roleOf = (el: Element): string => {
  const explicit = el.getAttribute("role")
  if (explicit) return explicit
  switch (el.tagName) {
    case "A":
      return "link"
    case "BUTTON":
    case "SUMMARY":
      return "button"
    case "SELECT":
      return "list"
    case "TEXTAREA":
      return "field"
    case "LABEL":
      return "label"
    case "INPUT":
      return INPUT_ROLES[(el as HTMLInputElement).type] ?? "field"
    default:
      return ""
  }
}

/** The label of a control that is clicked, or its visible text. */
const clickLabel = (el: Element): string => {
  const own = text(el.getAttribute("aria-label")) || labelledBy(el)
  if (own) return own
  if (el instanceof HTMLInputElement) {
    if (["button", "submit", "reset"].includes(el.type)) return text(el.value)
    return fieldLabel(el)
  }
  if (el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) return fieldLabel(el)
  // The text that the user sees, not hidden text: so the rendered text, not the DOM text.
  // biome-ignore lint/performance/useDomNodeTextContent: hidden text must not name the control
  const visible = text((el as HTMLElement).innerText ?? el.textContent)
  if (visible) return visible
  const img = el.querySelector("img[alt]")
  return text(img?.getAttribute("alt")) || text(el.getAttribute("title"))
}

/** Fields whose text is typed. Their text is reported once, when it is done. */
const isTextField = (el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement =>
  el instanceof HTMLTextAreaElement ||
  (el instanceof HTMLInputElement &&
    !["button", "submit", "reset", "image", "checkbox", "radio", "range", "file", "color"].includes(
      el.type,
    ))

/** The value of each field when it was last reported, so the same text is not reported twice. */
const reported = new WeakMap<Element, string>()

const reportTyped = (el: HTMLInputElement | HTMLTextAreaElement) => {
  const value = el.value
  if ((reported.get(el) ?? el.defaultValue) === value) return
  reported.set(el, value)
  report({
    kind: "type",
    label: fieldLabel(el),
    text: value,
    password: el instanceof HTMLInputElement && el.type === "password",
    autocomplete: text(el.getAttribute("autocomplete")),
  })
}

document.addEventListener(
  "click",
  (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return
    const target = event.target.closest(CONTROLS) ?? event.target
    // A click into a text field only moves the caret. The typed text is the step.
    if (isTextField(target) || target instanceof HTMLSelectElement) return
    report({ kind: "click", role: roleOf(target), label: clickLabel(target) })
  },
  true,
)

document.addEventListener(
  "change",
  (event) => {
    if (!event.isTrusted) return
    const target = event.target
    if (isTextField(target)) reportTyped(target)
    else if (target instanceof HTMLSelectElement)
      report({
        kind: "choose",
        label: fieldLabel(target),
        choice: [...target.selectedOptions].map((o) => text(o.textContent)).join(", "),
      })
  },
  true,
)

document.addEventListener(
  "keydown",
  (event) => {
    if (!event.isTrusted || event.isComposing || !TEACH_KEYS.includes(event.key)) return
    // The text of a field comes before the key that sends it.
    if ((event.key === "Enter" || event.key === "Tab") && isTextField(event.target))
      reportTyped(event.target)
    // Arrow keys inside a text field move the caret. They are not steps.
    if (event.key.startsWith("Arrow") && isTextField(event.target)) return
    report({ kind: "key", key: event.key })
  },
  true,
)

// Scrolls come often. One report every half second is enough: the app joins them.
let lastScroll = 0
document.addEventListener(
  "wheel",
  (event) => {
    if (!event.isTrusted || event.deltaY === 0) return
    const now = Date.now()
    if (now - lastScroll < 500) return
    lastScroll = now
    report({ kind: "scroll", down: event.deltaY > 0 })
  },
  { capture: true, passive: true },
)

// --- The diagnostic report ---------------------------------------------------------------------
// A click that does not work in a page has two causes that look alike: it never reaches the
// document, or the page does not act on it. The app counts what its window gives to the page. This
// counts what the document gets, so the report can tell the two apart. It only listens: it never
// stops an event and never reads text.

// A desktop without a touch screen may have no `TouchEvent` and no `Touch` at all, so the events
// are told apart by their fields, and no class of touch is named.
const pointerOf = (event: Event): string => {
  if ("pointerType" in event) return String(event.pointerType)
  return "touches" in event ? "touch" : ""
}

const placeOf = (event: Event): { x: number; y: number } => {
  const touches = "touches" in event ? (event.touches as ArrayLike<Touch>) : undefined
  const point = touches?.[0] ?? (event as MouseEvent)
  return { x: Math.round(point.clientX ?? 0), y: Math.round(point.clientY ?? 0) }
}

for (const type of PAGE_INPUT_TYPES) {
  window.addEventListener(
    type,
    (event) => {
      try {
        const note: PageInputNote = {
          type,
          pointer: pointerOf(event),
          trusted: event.isTrusted,
          tag: event.target instanceof Element ? event.target.tagName.toLowerCase() : "",
          ...placeOf(event),
          width: window.innerWidth,
          height: window.innerHeight,
        }
        ipcRenderer.send(PAGE_INPUT_CHANNEL, note)
      } catch {
        // A report that fails must never break the page.
      }
    },
    { capture: true, passive: true },
  )
}
