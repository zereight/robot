// What the recorder of "Teach a task" in an agent page and the app share. The recorder is a
// sandboxed preload: it can load no packages, and no module that the preload of the app window
// loads too (a shared module would become a separate file that a sandbox cannot load). So this
// file holds only plain constants and types, and imports nothing.

/** The recorder in an agent page reports a step of the user (spec 017). */
export const TEACH_CHANNEL = "robot:teach-step"
/** The recorder in an agent page asks whether the app records, and hears when that changes. */
export const TEACH_ON_CHANNEL = "robot:teach-on"

/** The keys that make a step. Letters and digits are typed text, not steps. */
export const TEACH_KEYS: readonly string[] = [
  "Enter",
  "Tab",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]

/**
 * One step that the user did, as the recorder in the page reports it. The page step comes from
 * the app, not from the page.
 */
export type TeachEvent =
  | { readonly kind: "page"; readonly url: string; readonly title: string }
  | {
      readonly kind: "click"
      /** The role of the control, for example "button" or "link". Empty when it has none. */
      readonly role: string
      /** The label of the control, or its visible text. */
      readonly label: string
    }
  | {
      readonly kind: "type"
      readonly label: string
      readonly text: string
      /** True for a password field (the page says so, not the label). */
      readonly password: boolean
      /** The autocomplete hint of the field, for example "cc-number". */
      readonly autocomplete: string
    }
  | { readonly kind: "choose"; readonly label: string; readonly choice: string }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "scroll"; readonly down: boolean }
