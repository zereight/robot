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

  test("opencode keeps its keys, because the user set up its providers with them", () => {
    const env = runtimeEnv(
      { PATH: "/usr/bin", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k", OPENROUTER_API_KEY: "k" },
      "/home/a",
      "opencode",
    )
    expect(env.OPENAI_API_KEY).toBe("k")
    expect(env.ANTHROPIC_API_KEY).toBe("k")
    expect(env.OPENROUTER_API_KEY).toBe("k")
    // It does not update itself while the app uses it.
    expect(env.OPENCODE_DISABLE_AUTOUPDATE).toBe("1")
    expect(
      runtimeEnv({ PATH: "/usr/bin" }, "/home/a", "pi").OPENCODE_DISABLE_AUTOUPDATE,
    ).toBeUndefined()
  })

  test("cursor keeps its account key and drops a gateway key", () => {
    const env = runtimeEnv(
      { PATH: "/usr/bin", CURSOR_API_KEY: "k", OPENAI_API_KEY: "o" },
      "/home/a",
      "cursor",
    )
    expect(env.CURSOR_API_KEY).toBe("k")
    expect(env.OPENAI_API_KEY).toBeUndefined()
  })

  test("git variables are removed, so a git of the program cannot reach another repository", () => {
    for (const kind of [undefined, "pi", "opencode"] as const) {
      const env = runtimeEnv(
        {
          PATH: "/usr/bin",
          GIT_DIR: "pinned",
          GIT_INDEX_FILE: "pinned",
          GIT_WORK_TREE: "pinned",
          KEEP: "yes",
        },
        "/home/a",
        kind,
      )
      expect(env.GIT_DIR).toBeUndefined()
      expect(env.GIT_INDEX_FILE).toBeUndefined()
      expect(env.GIT_WORK_TREE).toBeUndefined()
      expect(env.KEEP).toBe("yes")
    }
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
