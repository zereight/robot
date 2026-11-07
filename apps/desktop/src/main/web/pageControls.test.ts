import { describe, expect, test } from "bun:test"
import { pageActScript, pageReadScript, pageSecureScript, pageStateScript } from "./pageControls.ts"

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

  test("a field is secure by the name that it has: code, pin, otp, token, passcode and the like", () => {
    // The script runs on a stand-in document: one visible text field with these words.
    const secure = (name: string, id = "", label = "") => {
      const field = {
        tagName: "INPUT",
        type: "text",
        name,
        id,
        getAttribute: (key: string) => (key === "aria-label" ? label : ""),
        getBoundingClientRect: () => ({ width: 10, height: 10 }),
      }
      const document = { querySelectorAll: () => [field] }
      const getComputedStyle = () => ({ display: "block", visibility: "visible" })
      return new Function("document", "getComputedStyle", `return ${pageSecureScript()}`)(
        document,
        getComputedStyle,
      ) as boolean
    }
    for (const name of ["code", "pin", "otp", "token", "passcode", "pin_code", "login-code", "PIN"])
      expect(secure(name), name).toBe(true)
    expect(secure("x", "verification_code")).toBe(true)
    expect(secure("x", "", "Enter code")).toBe(true)
    for (const name of ["name", "email", "postcode", "zipcode", "pinterest", "encode", "q"])
      expect(secure(name), name).toBe(false)
  })

  test("the act scripts compare the control with the one that a card named", () => {
    const script = pageActScript("click", "3", "", { role: "button", label: "Save", tag: "button" })
    expect(() => new Function(script)).not.toThrow()
    expect(script).toContain('"label":"Save"')
    expect(script).toContain('reason: "changed"')
  })
})
