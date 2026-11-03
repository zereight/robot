import { describe, expect, test } from "bun:test"
import { pageUserAgent } from "./userAgent.ts"

const electron =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ROBot/0.1.0-alpha.9 Chrome/140.0.0.0 Electron/45.2.1 Safari/537.36"
const chromium =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

describe("pageUserAgent", () => {
  test("removes the Electron token and the app name", () => {
    expect(pageUserAgent(electron, "ROBot")).toBe(chromium)
  })

  test("keeps a user agent that has neither token", () => {
    expect(pageUserAgent(chromium, "ROBot")).toBe(chromium)
  })

  test("gives the same result when it runs on its own result", () => {
    const once = pageUserAgent(electron, "ROBot")
    expect(pageUserAgent(once, "ROBot")).toBe(once)
  })

  test("takes an app name that has special characters as plain text", () => {
    const raw = chromium.replace("Chrome/", "R.Bot+1/2.0 Chrome/")
    expect(pageUserAgent(raw, "R.Bot+1")).toBe(chromium)
    // The dot does not match any character.
    const other = chromium.replace("Chrome/", "RxBot+1/2.0 Chrome/")
    expect(pageUserAgent(other, "R.Bot+1")).toBe(other)
  })
})
