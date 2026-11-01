import { describe, expect, test } from "bun:test"
import { en } from "./en.ts"
import { catalogues, placeholders, translate } from "./index.ts"

describe("translation catalogues", () => {
  for (const [locale, catalogue] of Object.entries(catalogues)) {
    test(`${locale} has the same keys and placeholders as English`, () => {
      expect(Object.keys(catalogue).sort()).toEqual(Object.keys(en).sort())
      for (const [key, text] of Object.entries(en)) {
        expect(placeholders(catalogue[key as keyof typeof en])).toEqual(placeholders(text))
      }
    })
  }

  test("fills placeholders", () => {
    expect(translate("en", "settings.about.version", { version: "1.2.3" })).toBe("Version 1.2.3")
    expect(translate("ko", "settings.about.version", { version: "1.2.3" })).toBe("버전 1.2.3")
  })
})
