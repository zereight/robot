import { describe, expect, test } from "bun:test"
import { pageActScript, pageReadScript, pageStateScript } from "./pageControls.ts"

describe("page control scripts", () => {
  test("the built scripts compile", () => {
    const scripts = [
      pageActScript("click", "#go"),
      pageActScript("click", "2"),
      pageActScript("type", "#email", "a@b.c"),
      pageReadScript(20_000),
      pageStateScript(),
    ]
    for (const script of scripts) expect(() => new Function(script)).not.toThrow()
  })

  test("a hostile target stays a string and cannot break the script", () => {
    const hostile = '`"); alert($' + "{x}); //\nsecond line"
    for (const script of [
      pageActScript("click", hostile),
      pageActScript("type", hostile, hostile),
    ]) {
      expect(() => new Function(script)).not.toThrow()
      expect(script).toContain(JSON.stringify(hostile))
    }
  })
})
