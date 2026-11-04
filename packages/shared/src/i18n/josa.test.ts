import { describe, expect, test } from "bun:test"
import { translate } from "./index.ts"
import { resolveJosa } from "./josa.ts"

describe("Korean particles after a name (resolveJosa)", () => {
  test("a Korean name picks the particle by its last syllable", () => {
    expect(resolveJosa("민준을(를) 삭제할까요?")).toBe("민준을 삭제할까요?")
    expect(resolveJosa("지수을(를) 삭제할까요?")).toBe("지수를 삭제할까요?")
    expect(resolveJosa("민준이(가) 왔어요")).toBe("민준이 왔어요")
    expect(resolveJosa("지수이(가) 왔어요")).toBe("지수가 왔어요")
    expect(resolveJosa("민준은(는)")).toBe("민준은")
    expect(resolveJosa("지수은(는)")).toBe("지수는")
    expect(resolveJosa("민준와(과)")).toBe("민준과")
    expect(resolveJosa("지수과(와)")).toBe("지수와")
  })

  test("a Latin name that ends in a vowel letter has no final consonant", () => {
    expect(resolveJosa("Bo을(를)")).toBe("Bo를")
    expect(resolveJosa("Ada이(가)")).toBe("Ada가")
    expect(resolveJosa("Dee은(는)")).toBe("Dee는")
  })

  test("a Latin name that ends in l, m or n has one", () => {
    expect(resolveJosa("Ben을(를)")).toBe("Ben을")
    expect(resolveJosa("Tom이(가)")).toBe("Tom이")
    expect(resolveJosa("Bill은(는)")).toBe("Bill은")
  })

  test("a digit is read in Korean", () => {
    expect(resolveJosa("Agent 2을(를)")).toBe("Agent 2를")
    expect(resolveJosa("Agent 3을(를)")).toBe("Agent 3을")
    expect(resolveJosa("Agent 1을(를)")).toBe("Agent 1을")
  })

  test("으로 and 로: ㄹ and no final consonant take 로", () => {
    expect(resolveJosa("서울(으)로")).toBe("서울로")
    expect(resolveJosa("집(으)로")).toBe("집으로")
    expect(resolveJosa("부산(으)로")).toBe("부산으로")
    expect(resolveJosa("지수(으)로")).toBe("지수로")
  })

  test("the particle stands behind a closing mark: the word inside gives the sound", () => {
    expect(resolveJosa("Ada(Mac)이(가)")).toBe("Ada(Mac)이(가)")
    expect(resolveJosa("민준(폰)이(가)")).toBe("민준(폰)이")
    expect(resolveJosa("“지수”을(를)")).toBe("“지수”를")
  })

  test("a name with an uncertain sound keeps the pair, which fits any name", () => {
    expect(resolveJosa("Bob을(를)")).toBe("Bob을(를)")
    expect(resolveJosa("Max이(가)")).toBe("Max이(가)")
    expect(resolveJosa("🙂을(를)")).toBe("🙂을(를)")
  })

  test("text with no pair does not change", () => {
    expect(resolveJosa("Delete the agent?")).toBe("Delete the agent?")
    expect(resolveJosa("")).toBe("")
  })

  test("translate fills the name and then picks the particle", () => {
    expect(translate("ko", "agents.delete.title", { name: "Bo" })).toBe("Bo를 삭제할까요?")
    expect(translate("ko", "agents.delete.title", { name: "Ben" })).toBe("Ben을 삭제할까요?")
    expect(translate("ko", "agents.delete.title", { name: "Bob" })).toBe("Bob을(를) 삭제할까요?")
    expect(translate("en", "agents.delete.title", { name: "Bo" })).toBe("Delete Bo?")
  })
})
