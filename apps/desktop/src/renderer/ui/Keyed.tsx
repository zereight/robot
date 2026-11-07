import { createMemo, For, type JSX } from "solid-js"

/**
 * A list whose rows keep their identity when the list is read again. `For` keys a row by the
 * object, so a fresh copy of the same item (a refetch after a background event) mounts every row
 * again and loses its local state: an open question, a half-typed field, the focus, the scroll.
 * `Keyed` keys a row by `by(item)` instead. The row gets a function that reads the newest item
 * with that key, and keeps the last item while the row is on its way out.
 */
export const Keyed = <T,>(props: {
  each: readonly T[] | undefined
  by: (item: T) => string | number
  children: (item: () => T, index: () => number) => JSX.Element
}): JSX.Element => {
  const items = createMemo(() => {
    const map = new Map<string | number, T>()
    for (const item of props.each ?? []) map.set(props.by(item), item)
    return map
  })
  const keys = createMemo((prev: readonly (string | number)[]) => {
    const next = (props.each ?? []).map(props.by)
    return prev.length === next.length && prev.every((k, i) => k === next[i]) ? prev : next
  }, [])
  return (
    <For each={keys()}>
      {(key, index) => {
        const item = createMemo((last: T | undefined) => items().get(key) ?? last, undefined)
        return props.children(item as () => T, index)
      }}
    </For>
  )
}
