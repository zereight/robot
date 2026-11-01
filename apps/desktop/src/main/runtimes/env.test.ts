import { describe, expect, test } from "bun:test"
import { runtimeEnv } from "./env.ts"

describe("runtimeEnv", () => {
  test("keys and gateways are removed, so that the subscription pays", () => {
    const env = runtimeEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/a",
        ANTHROPIC_API_KEY: "k",
        ANTHROPIC_BASE_URL: "http://x",
        CLAUDE_CODE_USE_BEDROCK: "1",
        OPENAI_API_KEY: "k",
        CODEX_API_KEY: "k",
        KEEP: "yes",
      },
      "/home/a",
    )
    expect(env.KEEP).toBe("yes")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.CODEX_API_KEY).toBeUndefined()
  })

  test("the usual tool folders are added to a short PATH", () => {
    if (process.platform === "win32") return
    const env = runtimeEnv({ PATH: "/usr/bin" }, "/home/a")
    expect(env.PATH?.split(":")).toEqual([
      "/usr/bin",
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/home/a/.local/bin",
    ])
  })
})
