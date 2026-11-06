/** Steps that the user opened, with a cursor on the open one (spec 001, "Back and forward"). */
export const createHistory = <T>(limit = 50, same: (a: T, b: T) => boolean = Object.is) => {
  let steps: T[] = []
  let at = -1
  const reactive = { bump: () => {} }
  const notify = () => reactive.bump()
  return {
    /** Called on each move. The step that back or forward opened is the open one, so it adds nothing. */
    visit(step: T) {
      if (at >= 0 && same(steps[at] as T, step)) return
      steps = [...steps.slice(0, at + 1), step].slice(-limit)
      at = steps.length - 1
      notify()
    },
    canBack: () => at > 0,
    canForward: () => at >= 0 && at < steps.length - 1,
    back(): T | undefined {
      if (at <= 0) return undefined
      at -= 1
      notify()
      return steps[at]
    },
    forward(): T | undefined {
      if (at < 0 || at >= steps.length - 1) return undefined
      at += 1
      notify()
      return steps[at]
    },
    /** Set once by the owner, to learn that the cursor or the steps changed. */
    onChange(fn: () => void) {
      reactive.bump = fn
    },
  }
}
