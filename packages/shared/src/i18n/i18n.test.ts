import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
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

  // Spec 000: interface text and documents do not say that a model or an agent learns, trains or
  // evolves. The line that says ROBot does not train the model comes back with the chat (W5).
  const english =
    /\b(learn|learns|learned|learning|learner|train|trains|trained|training|trainer|evolve|evolves|evolved|evolving|evolution)\b/i
  const korean = /학습|훈련|트레이닝|배우|배운|배워|익히|진화/

  test("no text says that a model or an agent learns, trains or evolves", () => {
    for (const [key, text] of Object.entries(catalogues.en)) {
      expect({ key, hit: english.test(text) }).toEqual({ key, hit: false })
    }
    for (const [key, text] of Object.entries(catalogues.ko)) {
      expect({ key, hit: korean.test(text) }).toEqual({ key, hit: false })
    }
  })

  test("the README says the same fact in plain words", () => {
    const readme = readFileSync(new URL("../../../../README.md", import.meta.url), "utf8")
    expect(readme).toContain("ROBot does not train or change a model.")
    expect(readme).not.toMatch(
      /\b(learn|learns|learned|learning|evolve|evolves|evolved|evolving)\b/i,
    )
    // Every use of "train" is the sentence that says ROBot does not do it.
    const rest = readme.replace("ROBot does not train or change a model.", "")
    expect(rest).not.toMatch(/\b(train|trains|trained|training)\b/i)
  })

  test("fills placeholders", () => {
    expect(translate("en", "settings.about.version", { version: "1.2.3" })).toBe("Version 1.2.3")
    expect(translate("ko", "settings.about.version", { version: "1.2.3" })).toBe("버전 1.2.3")
  })
})
