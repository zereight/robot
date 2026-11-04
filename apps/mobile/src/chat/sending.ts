// Rules of the message box while a message goes out (spec 003, 011). Plain functions, so a test
// can run them without a screen.

/**
 * Lets one send run at a time. `enter` is true for the first call and false until `leave`. The
 * state of a screen is read late, so two quick taps both see "not sending"; this flag does not
 * wait for a new render.
 */
export const createSendGate = () => {
  let busy = false
  return {
    enter: (): boolean => {
      if (busy) return false
      busy = true
      return true
    },
    leave: (): void => {
      busy = false
    },
    busy: (): boolean => busy,
  }
}

/**
 * The text that stays in the box when a send ends. The box is cleared only when it still holds
 * what went out. Text that the user typed during the send is theirs and stays.
 */
export const textAfterSend = (current: string, sent: string): string =>
  current === sent ? "" : current

/** The files that stay in the box when a send ends: the ones that were added during the send. */
export const filesAfterSend = <T>(current: readonly T[], sent: readonly T[]): T[] =>
  current.filter((file) => !sent.includes(file))
