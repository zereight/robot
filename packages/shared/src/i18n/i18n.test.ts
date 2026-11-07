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
  // evolves. One sentence is the exception, as in the README: spec 000 says "ROBot does not train
  // or change a model.", and the line on the memory page (008) says it in the same words. The
  // exception covers that sentence in that one key and nothing else.
  const english =
    /\b(learn|learns|learned|learning|learner|train|trains|trained|training|trainer|evolve|evolves|evolved|evolving|evolution)\b/i
  const korean = /학습|훈련|트레이닝|배우|배운|배워|익히|진화/

  const NEGATED_KEY = "memory.hint"
  const NEGATED = {
    en: "ROBot does not train or change a model.",
    ko: "ROBot은 모델을 학습시키거나 바꾸지 않습니다.",
  } as const

  /** The text without the one negated sentence, which only the key `memory.hint` may hold, once. */
  const withoutNegated = (locale: "en" | "ko", key: string, text: string) => {
    if (key !== NEGATED_KEY) return text
    expect(text.split(NEGATED[locale]).length - 1).toBe(1)
    return text.replace(NEGATED[locale], "")
  }

  test("no text says that a model or an agent learns, trains or evolves", () => {
    for (const [key, text] of Object.entries(catalogues.en)) {
      const hit = english.test(withoutNegated("en", key, text))
      expect({ key, hit }).toEqual({ key, hit: false })
    }
    for (const [key, text] of Object.entries(catalogues.ko)) {
      const hit = korean.test(withoutNegated("ko", key, text))
      expect({ key, hit }).toEqual({ key, hit: false })
    }
  })

  test("only the key memory.hint holds the negated sentence", () => {
    for (const locale of ["en", "ko"] as const) {
      for (const [key, text] of Object.entries(catalogues[locale])) {
        expect({ key, has: text.includes(NEGATED[locale]) }).toEqual({
          key,
          has: key === NEGATED_KEY,
        })
      }
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
