import { describe, expect, test } from "bun:test"
import { islandBounds, type Notch, notchReader } from "./notch.ts"

const notch: Notch = { x: 663, width: 185, height: 32 }

describe("When the island asks for the notch of the screen", () => {
  describe("with a screen that has a notch", () => {
    test("it reads the notch one time, however many shapes it shows", async () => {
      let reads = 0
      const read = notchReader(async () => {
        reads++
        return notch
      })
      const results = await Promise.all([read(), read(), read(), read(), read()])
      for (const result of results) expect(result).toEqual(notch)
      await read()
      await read()
      expect(reads).toBe(1)
    })

    test("a later caller gets the same answer, not a new one", async () => {
      let reads = 0
      const read = notchReader(async () => {
        reads++
        return notch
      })
      const first = await read()
      const second = await read()
      expect(second).toEqual(first as Notch)
      expect(reads).toBe(1)
    })
  })

  describe("with a screen that has no notch", () => {
    test("it gives null, and it reads one time as well", async () => {
      let reads = 0
      const read = notchReader(async () => {
        reads++
        return null
      })
      expect(await read()).toBeNull()
      expect(await read()).toBeNull()
      expect(reads).toBe(1)
    })

    test("a read that fails gives null and is not tried again", async () => {
      let reads = 0
      const read = notchReader(async () => {
        reads++
        return null
      })
      expect(await read()).toBeNull()
      expect(await read()).toBeNull()
      expect(reads).toBe(1)
    })
  })
})

describe("When the island window is placed", () => {
  // The built-in screen of a Mac with a notch: the menu bar is 34 px tall.
  const screen = {
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    workArea: { x: 0, y: 34, width: 1462, height: 948 },
  }
  const bar = { width: 409, height: 34 }

  test("with a notch, the window starts at the top edge, centred", () => {
    expect(islandBounds(screen, notch, bar)).toEqual({ x: 552, y: 0, width: 409, height: 34 })
  })

  test("the window is at least as tall as the notch", () => {
    expect(islandBounds(screen, notch, { width: 409, height: 20 }).height).toBe(32)
  })

  test("with no notch, or one that is not known yet, the window sits under the menu bar", () => {
    expect(islandBounds(screen, null, bar).y).toBe(34)
  })

  test("a menu bar that is too short for a notch keeps the window under the menu bar", () => {
    const flat = { ...screen, workArea: { ...screen.workArea, y: 24 } }
    expect(islandBounds(flat, notch, bar).y).toBe(24)
  })
})
