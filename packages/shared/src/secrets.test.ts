import { describe, expect, test } from "bun:test"
import {
  authHeader,
  checkRequestAddress,
  classifyHost,
  classifyIp,
  isLoginUser,
  isSecretName,
  isSecretValue,
  LOGINS_PER_WORKFLOW,
  parseOrigin,
  parseSecretAuth,
  redactSecretValue,
  SECRET_VALUE_MAX,
  sameAuth,
} from "./secrets.ts"

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64")

describe("the name and the value of a saved secret", () => {
  test("a name has 1 to 40 letters, digits, - and _", () => {
    expect(isSecretName("test_api")).toBe(true)
    expect(isSecretName("A-b_9")).toBe(true)
    expect(isSecretName("x".repeat(40))).toBe(true)
    expect(isSecretName("x".repeat(41))).toBe(false)
    expect(isSecretName("")).toBe(false)
    expect(isSecretName("has space")).toBe(false)
    expect(isSecretName("dot.name")).toBe(false)
  })

  test("a value holds 1 to 16384 characters and no line break", () => {
    expect(isSecretValue("k")).toBe(true)
    expect(isSecretValue("x".repeat(SECRET_VALUE_MAX))).toBe(true)
    expect(isSecretValue("x".repeat(SECRET_VALUE_MAX + 1))).toBe(false)
    expect(isSecretValue("")).toBe(false)
    expect(isSecretValue("a\nb")).toBe(false)
    expect(isSecretValue("a\rb")).toBe(false)
  })
})

describe("the way to send", () => {
  test("bearer, a named header, or a basic sign-in", () => {
    expect(parseSecretAuth("bearer", undefined, undefined)).toEqual({ kind: "bearer" })
    expect(parseSecretAuth("header", "X-Api-Key", undefined)).toEqual({
      kind: "header",
      header: "X-Api-Key",
    })
    expect(parseSecretAuth("basic", undefined, "ada")).toEqual({ kind: "basic", user: "ada" })
  })

  test("a header the app sets itself, a bad name, or a user with a colon is refused", () => {
    expect(parseSecretAuth("header", "Host", undefined)).toBeNull()
    expect(parseSecretAuth("header", "Authorization", undefined)).toBeNull()
    expect(parseSecretAuth("header", "Bad Header", undefined)).toBeNull()
    expect(parseSecretAuth("header", "", undefined)).toBeNull()
    expect(parseSecretAuth("basic", undefined, "a:b")).toBeNull()
    expect(parseSecretAuth("basic", undefined, "")).toBeNull()
    expect(parseSecretAuth("cookie", undefined, undefined)).toBeNull()
  })

  test("the header that carries the value", () => {
    expect(authHeader({ kind: "bearer" }, "tok")).toEqual(["Authorization", "Bearer tok"])
    expect(authHeader({ kind: "header", header: "X-Key" }, "tok")).toEqual(["X-Key", "tok"])
    expect(authHeader({ kind: "basic", user: "ada" }, "pw")).toEqual([
      "Authorization",
      `Basic ${b64("ada:pw")}`,
    ])
  })

  test("a header name ignores case when two ways are compared", () => {
    expect(sameAuth({ kind: "header", header: "X-Key" }, { kind: "header", header: "x-key" })).toBe(
      true,
    )
    expect(sameAuth({ kind: "bearer" }, { kind: "basic", user: "a" })).toBe(false)
  })
})

describe("addresses", () => {
  test("link-local and cloud metadata addresses are blocked", () => {
    expect(classifyIp("169.254.169.254")).toBe("blocked")
    expect(classifyIp("169.254.1.2")).toBe("blocked")
    expect(classifyIp("100.100.100.200")).toBe("blocked")
    expect(classifyIp("fe80::1")).toBe("blocked")
    expect(classifyIp("fd00:ec2::254")).toBe("blocked")
    expect(classifyIp("::ffff:169.254.169.254")).toBe("blocked")
    expect(classifyIp("0.0.0.0")).toBe("blocked")
    expect(classifyHost("metadata.google.internal")).toBe("blocked")
  })

  test("this computer and the local network are local", () => {
    for (const ip of ["127.0.0.1", "127.8.9.1", "::1", "10.0.0.5", "172.16.0.1", "192.168.1.9"])
      expect(classifyIp(ip)).toBe("local")
    expect(classifyIp("fd12:3456::1")).toBe("local")
    expect(classifyIp("::ffff:127.0.0.1")).toBe("local")
    expect(classifyHost("localhost")).toBe("local")
    expect(classifyHost("[::1]")).toBe("local")
    expect(classifyHost("printer.local")).toBe("local")
  })

  test("other addresses are public", () => {
    expect(classifyIp("8.8.8.8")).toBe("public")
    expect(classifyIp("172.32.0.1")).toBe("public")
    expect(classifyHost("api.example.com")).toBe("public")
  })

  test("an origin is https, or http on a local host, with no path, query or sign-in part", () => {
    expect(parseOrigin("https://api.example.com")).toEqual({
      ok: true,
      origin: "https://api.example.com",
      local: false,
    })
    expect(parseOrigin("https://API.example.com:443/")).toEqual({
      ok: true,
      origin: "https://api.example.com",
      local: false,
    })
    expect(parseOrigin("http://127.0.0.1:8080")).toEqual({
      ok: true,
      origin: "http://127.0.0.1:8080",
      local: true,
    })
    expect(parseOrigin("http://api.example.com")).toEqual({ ok: false, error: "http_public" })
    expect(parseOrigin("https://api.example.com/v1")).toEqual({ ok: false, error: "parts" })
    expect(parseOrigin("https://u:p@api.example.com")).toEqual({ ok: false, error: "parts" })
    expect(parseOrigin("https://api.example.com?x=1")).toEqual({ ok: false, error: "parts" })
    expect(parseOrigin("ftp://api.example.com")).toEqual({ ok: false, error: "scheme" })
    expect(parseOrigin("http://169.254.169.254")).toEqual({ ok: false, error: "blocked" })
    expect(parseOrigin("not an address")).toEqual({ ok: false, error: "invalid" })
  })

  test("a request needs the same scheme, host and port as the origin", () => {
    const origin = "https://api.example.com"
    expect(checkRequestAddress("https://api.example.com/v1/items?q=1", origin, false).ok).toBe(true)
    expect(checkRequestAddress("https://api.example.com:8443/v1", origin, false)).toEqual({
      ok: false,
      error: "other_origin",
    })
    expect(checkRequestAddress("http://api.example.com/v1", origin, false)).toEqual({
      ok: false,
      error: "other_origin",
    })
    expect(checkRequestAddress("https://evil.example.com/v1", origin, false)).toEqual({
      ok: false,
      error: "other_origin",
    })
    expect(checkRequestAddress("https://x@api.example.com/v1", origin, false)).toEqual({
      ok: false,
      error: "parts",
    })
  })

  test("a request to this computer needs the switch", () => {
    const origin = "http://127.0.0.1:4000"
    expect(checkRequestAddress("http://127.0.0.1:4000/a", origin, false)).toEqual({
      ok: false,
      error: "local_off",
    })
    expect(checkRequestAddress("http://127.0.0.1:4000/a", origin, true).ok).toBe(true)
    expect(checkRequestAddress("http://127.0.0.1:4001/a", origin, true)).toEqual({
      ok: false,
      error: "other_origin",
    })
  })
})

describe("redaction of the value in an answer", () => {
  const value = "s3cr3t-Value_42!"

  test("the value as it is", () => {
    expect(redactSecretValue(`token=${value}.`, value)).toBe("token=[redacted].")
  })

  test("base64, with and without padding, and the URL-safe form", () => {
    const text = `a ${b64(value)} b ${b64(value).replace(/=+$/, "")} c ${b64(value).replace(/\+/g, "-").replace(/\//g, "_")}`
    const out = redactSecretValue(text, value)
    expect(out).not.toContain(b64(value).replace(/=+$/, ""))
    expect(out.match(/\[redacted\]/g)?.length).toBe(3)
  })

  test("base64 of a longer text that holds the value, at each byte offset", () => {
    for (const prefix of ["", "x", "xy", "xyz", '{"key":"']) {
      const blob = b64(`${prefix}${value}","more":"data"}`)
      const out = redactSecretValue(blob, value)
      expect(out).toContain("[redacted]")
      // What stays decodes to text without the value.
      const kept = out.split("[redacted]").join("")
      expect(Buffer.from(kept, "base64").toString("utf8")).not.toContain(value)
    }
  })

  test("URL encoding, also with + for spaces", () => {
    const spaced = "my key/with=chars"
    expect(redactSecretValue(`q=${encodeURIComponent(spaced)}`, spaced)).toBe("q=[redacted]")
    expect(redactSecretValue(`q=${encodeURIComponent(spaced).replace(/%20/g, "+")}`, spaced)).toBe(
      "q=[redacted]",
    )
    // The hex digits of a percent sign may come in lower case.
    expect(redactSecretValue(`q=${encodeURIComponent(spaced).toLowerCase()}`, spaced)).toBe(
      "q=[redacted]",
    )
  })

  test("hex in lower and upper case", () => {
    const hex = Buffer.from(value, "utf8").toString("hex")
    expect(redactSecretValue(`h=${hex}`, value)).toBe("h=[redacted]")
    expect(redactSecretValue(`h=${hex.toUpperCase()}`, value)).toBe("h=[redacted]")
  })

  test("the base64 pair of a basic sign-in", () => {
    const auth = { kind: "basic", user: "ada" } as const
    const header = authHeader(auth, value)[1]
    expect(redactSecretValue(`you sent ${header}`, value, auth)).toBe("you sent Basic [redacted]")
  })

  test("text without the value stays", () => {
    expect(redactSecretValue("nothing here", value)).toBe("nothing here")
  })
})

describe("the name and the user of a saved login", () => {
  test("a login name follows the same rule as a secret name", () => {
    expect(isSecretName("test_user-1")).toBe(true)
    expect(isSecretName("")).toBe(false)
    expect(isSecretName("has space")).toBe(false)
    // A workflow holds at most 50 logins; a password at most 16384 characters.
    expect(LOGINS_PER_WORKFLOW).toBe(50)
    expect(SECRET_VALUE_MAX).toBe(16384)
  })

  test("a user name is plain text of 1 to 200 characters", () => {
    expect(isLoginUser("ada")).toBe(true)
    expect(isLoginUser("")).toBe(false)
    expect(isLoginUser("a".repeat(201))).toBe(false)
    expect(isLoginUser("has\nbreak")).toBe(false)
  })
})
