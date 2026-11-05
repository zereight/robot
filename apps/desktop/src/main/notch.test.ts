import { describe, expect, test } from "bun:test"
import { type Notch, notchReader } from "./notch.ts"

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
