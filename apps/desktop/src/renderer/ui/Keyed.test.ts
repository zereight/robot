import { describe, expect, mock, test } from "bun:test"
import type * as Solid from "solid-js"

// Under the test runner "solid-js" resolves to the build for a server, which does not track
// changes. The test loads the build for a window and gives it to `Keyed`.
const BROWSER_BUILD = "solid-js/dist/solid.js"
const solid = (await import(BROWSER_BUILD)) as typeof Solid
const { createRoot, createSignal } = solid
mock.module("solid-js", () => solid)
const { Keyed } = await import("./Keyed.tsx")

interface Item {
  readonly id: string
  readonly label: string
}
const item = (id: string, label = id): Item => ({ id, label })

/** A row of the test: `mounted` counts the rows made, `read` reads the newest item of the row. */
const setup = (first: readonly Item[]) => {
  const mounted: string[] = []
  const disposed: string[] = []
  const [list, setList] = createSignal<readonly Item[]>(first)
  let rows: () => unknown = () => []
  const dispose = createRoot((dispose: () => void) => {
    rows = Keyed({
      get each() {
        return list()
      },
      by: (x: Item) => x.id,
      children: (row: () => Item, index: () => number) => {
        const id = row().id
        mounted.push(id)
        solid.onCleanup(() => disposed.push(id))
        return (() => `${index()}:${row().label}`) as unknown as Solid.JSX.Element
      },
    }) as unknown as () => unknown
    return dispose
  })
  // The rows are functions: read each one to get the text that the row shows.
  const text = () => (rows() as (() => string)[]).map((r) => r())
  return { text, setList, mounted, disposed, dispose }
}

describe("Keyed", () => {
  test("a fresh copy of the same items keeps every row", () => {
    const t = setup([item("a"), item("b")])
    expect(t.mounted).toEqual(["a", "b"])
    t.setList([item("a"), item("b")])
    expect(t.mounted).toEqual(["a", "b"])
    expect(t.disposed).toEqual([])
    t.dispose()
  })

  test("a row reads the new data of its item without a new mount", () => {
    const t = setup([item("a", "one"), item("b", "two")])
    t.setList([item("a", "ONE"), item("b", "two")])
    expect(t.text()).toEqual(["0:ONE", "1:two"])
    expect(t.mounted).toEqual(["a", "b"])
    t.dispose()
  })

  test("a reorder moves the rows and mounts none", () => {
    const t = setup([item("a"), item("b"), item("c")])
    t.setList([item("c"), item("a"), item("b")])
    expect(t.text()).toEqual(["0:c", "1:a", "2:b"])
    expect(t.mounted).toEqual(["a", "b", "c"])
    expect(t.disposed).toEqual([])
    t.dispose()
  })

  test("a removed item removes its row only, an added item adds one row", () => {
    const t = setup([item("a"), item("b"), item("c")])
    t.setList([item("a"), item("c")])
    expect(t.text()).toEqual(["0:a", "1:c"])
    expect(t.disposed).toEqual(["b"])
    t.setList([item("a"), item("d"), item("c")])
    expect(t.text()).toEqual(["0:a", "1:d", "2:c"])
    expect(t.mounted).toEqual(["a", "b", "c", "d"])
    t.dispose()
  })

  test("an empty list has no row", () => {
    const t = setup([item("a")])
    t.setList([])
    expect(t.text()).toEqual([])
    expect(t.disposed).toEqual(["a"])
    t.dispose()
  })

  test("two items with one id make two rows that read the last of them", () => {
    const t = setup([item("a", "first"), item("a", "second"), item("b")])
    expect(t.text()).toEqual(["0:second", "1:second", "2:b"])
    t.setList([item("a", "first"), item("b")])
    expect(t.text()).toEqual(["0:first", "1:b"])
    t.dispose()
  })
})
