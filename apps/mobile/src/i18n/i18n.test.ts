import { describe, expect, test } from "bun:test"
import { LINK_ERROR_CODES } from "@robot/link"
import { en } from "./en.ts"
import {
  catalogues,
  errorText,
  fileSizeText,
  placeholders,
  resolveLocale,
  translate,
} from "./index.ts"
import { ko } from "./ko.ts"

describe("the catalogues of the phone", () => {
  test("Korean has every key of English, with the same placeholders", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort())
    for (const [key, text] of Object.entries(en)) {
      expect({ key, p: placeholders(ko[key as keyof typeof en]) }).toEqual({
        key,
        p: placeholders(text),
      })
    }
  })

  test("no key ends in a quote character, and no text is empty", () => {
    for (const locale of ["en", "ko"] as const) {
      for (const [key, text] of Object.entries(catalogues[locale])) {
        expect(key).not.toMatch(/["'`\u2018\u2019\u201c\u201d]$/)
        expect(text.trim().length).toBeGreaterThan(0)
      }
    }
  })

  test("Korean uses the polite informal form, not the formal one", () => {
    for (const text of Object.values(ko)) expect(text).not.toMatch(/(습니다|십시오|합니까)/)
  })

  test("every link error has its own line in both languages", () => {
    for (const locale of ["en", "ko"] as const) {
      for (const code of LINK_ERROR_CODES) {
        const line = errorText(locale, code, "this")
        expect({ code, line }).not.toEqual({
          code,
          line: translate(locale, "error.generic", { code }),
        })
      }
    }
    expect(errorText("en", "update_app", "server")).toBe("Update the app on the computer.")
    expect(errorText("ko", "update_app", "this")).toBe("이 휴대폰의 앱을 업데이트해 주세요.")
  })

  test("a code that only a server knows uses the words of the desktop, or a plain line", () => {
    expect(errorText("en", "no_such_code_at_all")).toBe("This did not work. (no_such_code_at_all)")
  })

  test("the language follows the system, and English is the fallback", () => {
    expect(resolveLocale("system", ["ko-KR", "en-US"])).toBe("ko")
    expect(resolveLocale("system", ["fr-FR", "en-GB"])).toBe("en")
    expect(resolveLocale("system", ["de"])).toBe("en")
    expect(resolveLocale("ko", ["en-US"])).toBe("ko")
  })

  test("file sizes", () => {
    expect(fileSizeText("en", 512)).toBe("512 B")
    expect(fileSizeText("en", 2048)).toBe("2 KB")
    expect(fileSizeText("ko", 3 * 1024 * 1024)).toBe("3MB")
    expect(fileSizeText("en", 1.5 * 1024 * 1024)).toBe("1.5 MB")
  })
})
