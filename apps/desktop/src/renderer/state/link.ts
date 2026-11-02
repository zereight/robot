import { createSignal } from "solid-js"

const [epoch, setEpoch] = createSignal(0)

/**
 * Counts the times that a linked server came back online. A view that shows data of a server reads
 * again when it changes, because the events of the time away were not seen.
 */
export const linkEpoch = {
  value: epoch,
  bump: () => setEpoch((n) => n + 1),
}
