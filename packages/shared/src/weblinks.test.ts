import { describe, expect, test } from "bun:test"
import { openableLink } from "./weblinks.ts"

describe("openableLink", () => {
  test("a full address stays as is", () => {
    expect(openableLink("https://example.com/guide?a=1")).toBe("https://example.com/guide?a=1")
    expect(openableLink("http://example.com/")).toBe("http://example.com/")
    expect(openableLink("mailto:me@example.com")).toBe("mailto:me@example.com")
    expect(openableLink("  https://example.com/  ")).toBe("https://example.com/")
    expect(openableLink("HTTPS://EXAMPLE.COM/")).toBe("HTTPS://EXAMPLE.COM/")
  })
  test("a scheme-less host gets https", () => {
    expect(openableLink("www.example.com/guide")).toBe("https://www.example.com/guide")
    expect(openableLink("example.com")).toBe("https://example.com")
    expect(openableLink("example.com:8080/a?b=1#c")).toBe("https://example.com:8080/a?b=1#c")
    expect(openableLink("//example.com/x")).toBe("https://example.com/x")
    expect(openableLink("localhost:3000/docs")).toBe("http://localhost:3000/docs")
    expect(openableLink("//localhost:3000/docs")).toBe("http://localhost:3000/docs")
  })
  test("a bare mail address gets mailto", () => {
    expect(openableLink("me@example.com")).toBe("mailto:me@example.com")
  })
  test("what is not an outside address gives null", () => {
    expect(openableLink("")).toBeNull()
    expect(openableLink("./guide.md")).toBeNull()
    expect(openableLink("/docs/guide")).toBeNull()
    expect(openableLink("#part")).toBeNull()
    expect(openableLink("?q=1")).toBeNull()
    expect(openableLink("ftp://example.com/f")).toBeNull()
    expect(openableLink("tel:+821012345678")).toBeNull()
    expect(openableLink("javascript:alert(1)")).toBeNull()
    expect(openableLink("nota host/??")).toBeNull()
  })
})
