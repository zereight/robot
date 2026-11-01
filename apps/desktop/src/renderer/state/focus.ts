import { createSignal } from "solid-js"

/** A message that a notification asks to show. The open view scrolls to it, then clears it. */
export const [focusMessage, setFocusMessage] = createSignal<string>()
