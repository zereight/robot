import { createSignal } from "solid-js"

/** What to put in the message box of a chat: a skill chip and text after it (spec 017). */
export interface ComposerFill {
  readonly agentId: string
  readonly skill: { readonly id: string; readonly name: string }
  readonly text: string
}

const [pending, setPending] = createSignal<ComposerFill>()

/** The fill that waits for the message box of its chat. */
export const pendingFill = pending

/** Puts a chip and text in the message box of the chat of an agent. */
export const fillComposer = (fill: ComposerFill) => setPending({ ...fill })

/** The message box took the fill. */
export const takeFill = () => setPending(undefined)
