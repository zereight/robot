import {
  type Accessor,
  createContext,
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  Show,
  untrack,
  useContext,
} from "solid-js"

const ClosingContext = createContext<Accessor<boolean>>(() => false)

/** True while the nearest Presence plays its exit motion. */
export const useClosing = () => useContext(ClosingContext)

/** Reads a motion duration token in ms. Reduce motion sets every token to 0. */
export const motionMs = (token: "fast" | "medium") => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--motion-${token}`)
  return Number.parseFloat(value) || 0
}

/**
 * Like `<Show keyed>`, but keeps the children for a short exit motion after `when` turns off.
 * Children read `useClosing()` and mark themselves so CSS can play the exit.
 */
export function Presence<T>(props: {
  when: T | undefined | null | false
  exit?: "fast" | "medium"
  children: (value: T) => JSX.Element
}) {
  // A new box per opening, so reopening during the exit mounts fresh children.
  const [shown, setShown] = createSignal<{ value: T }>()
  const [closing, setClosing] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined
  createEffect(() => {
    const next = props.when
    clearTimeout(timer)
    if (next) {
      setClosing(false)
      setShown({ value: next })
      return
    }
    if (untrack(shown) === undefined) return
    const ms = motionMs(props.exit ?? "fast")
    if (ms === 0) {
      setShown(undefined)
      return
    }
    setClosing(true)
    timer = setTimeout(() => {
      setShown(undefined)
      setClosing(false)
    }, ms)
  })
  onCleanup(() => clearTimeout(timer))
  return (
    <Show when={shown()} keyed>
      {(box) => (
        <ClosingContext.Provider value={closing}>
          {props.children(box.value)}
        </ClosingContext.Provider>
      )}
    </Show>
  )
}
