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
  // evolves. The one line that says ROBot does not train the model is the only text with these words.
  const english =
    /\b(learn|learns|learned|learning|learner|train|trains|trained|training|trainer|evolve|evolves|evolved|evolving|evolution)\b/i
  const korean = /학습|훈련|트레이닝|배우|배운|배워|익히|진화/

  test("no text says that a model or an agent learns, trains or evolves, except the one line", () => {
    for (const [key, text] of Object.entries(catalogues.en)) {
      if (key !== "honest.line")
        expect({ key, hit: english.test(text) }).toEqual({ key, hit: false })
    }
    for (const [key, text] of Object.entries(catalogues.ko)) {
      if (key !== "honest.line")
        expect({ key, hit: korean.test(text) }).toEqual({ key, hit: false })
    }
  })

  test("the muted line names instructions, memory, knowledge, skills and that ROBot does not train", () => {
    const line = catalogues.en["honest.line"]
    for (const word of ["instructions", "memory", "knowledge", "skills", "does not train"]) {
      expect(line).toContain(word)
    }
    const text = catalogues.ko["honest.line"]
    for (const word of ["지침", "메모리", "지식", "스킬", "훈련하지 않습니다"]) {
      expect(text).toContain(word)
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
