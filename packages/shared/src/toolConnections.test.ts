import { describe, expect, test } from "bun:test"
import {
  CONNECTION_RESULT_MAX,
  CONNECTIONS_MAX,
  type ConnectionEntryInput,
  checkConnection,
  checkConnectionAddress,
  checkConnectionName,
  checkEntries,
  commandLine,
  connectionCallIsRisky,
  connectionSlug,
  connectionsFull,
  cutResult,
  MODEL_TOOL_NAME_MAX,
  NO_TOOL_FOUND_TEXT,
  needsToolSearch,
  RESULT_CUT_NOTE,
  readOnlyMarkCounts,
  type SearchableTool,
  searchResultText,
  searchTools,
  TOOL_SEARCH_RESULTS_MAX,
  type ToolConnectionInput,
  toolAliases,
  toolSearchWords,
} from "./toolConnections.ts"

const program: ToolConnectionInput = {
  name: "Notes",
  kind: "program",
  command: "node",
  args: ["server.js"],
  folder: "",
  env: [],
  address: "",
  headers: [],
  agents: "all",
}

describe("the name of a connection", () => {
  test("has 1 to 40 characters and is unique when case is ignored", () => {
    expect(checkConnectionName("", [])).toBe("empty")
    expect(checkConnectionName("   ", [])).toBe("empty")
    expect(checkConnectionName("a".repeat(40), [])).toBeNull()
    expect(checkConnectionName("a".repeat(41), [])).toBe("long")
    expect(checkConnectionName("Notes", ["notes"])).toBe("taken")
    expect(checkConnectionName("노트", ["메모"])).toBeNull()
  })

  test("a server holds at most 20 connections", () => {
    expect(connectionsFull(CONNECTIONS_MAX - 1)).toBe(false)
    expect(connectionsFull(CONNECTIONS_MAX)).toBe(true)
  })
})

describe("the address of a web connection", () => {
  test("uses https; only this computer may use http", () => {
    expect(checkConnectionAddress("https://tools.example.com/mcp")).toBeNull()
    expect(checkConnectionAddress("http://example.com")).toBe("scheme")
    expect(checkConnectionAddress("http://127.0.0.1:9000")).toBeNull()
    expect(checkConnectionAddress("http://localhost:9000/mcp")).toBeNull()
    expect(checkConnectionAddress("http://[::1]:9000")).toBeNull()
    expect(checkConnectionAddress("ftp://example.com")).toBe("scheme")
    expect(checkConnectionAddress("not an address")).toBe("invalid")
  })

  test("has no sign-in part", () => {
    expect(checkConnectionAddress("https://me:pw@example.com")).toBe("credentials")
    expect(checkConnectionAddress("https://me@example.com")).toBe("credentials")
  })
})

describe("environment values and headers", () => {
  const entry = (name: string, value = "v", secret = false): ConnectionEntryInput => ({
    name,
    value,
    secret,
  })

  test("a name is a word for a value and a token for a header", () => {
    expect(checkEntries([entry("API_KEY")], "env")).toBeNull()
    expect(checkEntries([entry("1BAD")], "env")).toBe("name")
    expect(checkEntries([entry("has space")], "env")).toBe("name")
    expect(checkEntries([entry("Authorization")], "header")).toBeNull()
    expect(checkEntries([entry("Bad Header")], "header")).toBe("name")
  })

  test("no two names are the same; a header ignores case", () => {
    expect(checkEntries([entry("A"), entry("A")], "env")).toBe("duplicate")
    expect(checkEntries([entry("A"), entry("a")], "env")).toBeNull()
    expect(checkEntries([entry("X-Key"), entry("x-key")], "header")).toBe("duplicate")
  })

  test("a header value holds no line break", () => {
    expect(checkEntries([entry("X", "a\r\nInjected: 1")], "header")).toBe("value")
    expect(checkEntries([entry("X", "a\nb")], "env")).toBeNull()
  })
})

describe("the whole form", () => {
  test("a program needs a command; a web connection needs a good address", () => {
    expect(checkConnection(program, [])).toBeNull()
    expect(checkConnection({ ...program, command: "  " }, [])).toBe("command_empty")
    expect(
      checkConnection({ ...program, kind: "web", address: "http://example.com", command: "" }, []),
    ).toBe("address_scheme")
    expect(
      checkConnection({ ...program, kind: "web", address: "https://example.com", command: "" }, []),
    ).toBeNull()
  })

  test("only the fields of the chosen kind count", () => {
    expect(checkConnection({ ...program, address: "nonsense" }, [])).toBeNull()
    expect(
      checkConnection({ ...program, kind: "web", address: "https://x.example", command: "" }, []),
    ).toBeNull()
  })

  test("the name is checked first", () => {
    expect(checkConnection({ ...program, name: "" }, [])).toBe("name_empty")
    expect(checkConnection(program, ["NOTES"])).toBe("name_taken")
  })

  test("the command line shows the arguments that hold a space in quotes", () => {
    expect(commandLine("npx", ["-y", "server"])).toBe("npx -y server")
    expect(commandLine("node", ["my server.js"])).toBe('node "my server.js"')
    expect(commandLine("echo", [""])).toBe('echo ""')
  })
})

describe("the names that the model sees", () => {
  test("a word of a name is lower case letters, digits and a dash", () => {
    expect(connectionSlug("My Notes!")).toBe("my-notes")
    expect(connectionSlug("  --a__b--  ")).toBe("a-b")
    expect(connectionSlug("노트")).toBe("")
    expect(connectionSlug("x".repeat(60)).length).toBeLessThanOrEqual(24)
  })

  test("each tool gets one name with the right shape", () => {
    const aliases = toolAliases([
      { id: "id-one", name: "Notes", tools: [{ name: "search" }, { name: "add.note" }] },
    ])
    expect([...aliases.keys()]).toEqual(["mcp__notes__search", "mcp__notes__add_note"])
    expect(aliases.get("mcp__notes__add_note")).toEqual({
      connectionId: "id-one",
      tool: "add.note",
    })
    for (const alias of aliases.keys()) expect(alias).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  test("a name in Hangul still gets a word, and two connections never share one", () => {
    const aliases = toolAliases([
      { id: "abcdef123", name: "노트", tools: [{ name: "t" }] },
      { id: "zzzzzz999", name: "메모", tools: [{ name: "t" }] },
      { id: "n1xxxxxxx", name: "Notes", tools: [{ name: "t" }] },
      { id: "n2yyyyyyy", name: "notes", tools: [{ name: "t" }] },
    ])
    const names = [...aliases.keys()]
    expect(new Set(names).size).toBe(4)
    expect(names[0]).toBe("mcp__cabcdef__t")
    expect(names[3]?.startsWith("mcp__notes-n2yyyy__")).toBe(true)
  })

  test("a long name is cut and a clash gets a number", () => {
    const long = "t".repeat(100)
    const aliases = toolAliases([
      {
        id: "i",
        name: "A",
        tools: [{ name: long }, { name: long }, { name: "x y" }, { name: "x_y" }],
      },
    ])
    const names = [...aliases.keys()]
    expect(new Set(names).size).toBe(4)
    for (const n of names) expect(n.length).toBeLessThanOrEqual(MODEL_TOOL_NAME_MAX)
    expect(names[2]).toBe("mcp__a__x_y")
    expect(names[3]).toBe("mcp__a__x_y_2")
  })

  test("the name reads back into the connection and the tool", () => {
    // The outside-content code splits `mcp__<word>__<tool>` at the double underscore.
    const aliases = toolAliases([
      { id: "i", name: "Github Tools", tools: [{ name: "make_issue" }] },
    ])
    const [alias] = [...aliases.keys()]
    expect(alias).toBe("mcp__github-tools__make_issue")
    expect(alias?.split("__")).toEqual(["mcp", "github-tools", "make_issue"])
  })
})

describe("the cut of a result", () => {
  test("a result of 100000 characters stays whole", () => {
    const text = "a".repeat(CONNECTION_RESULT_MAX)
    expect(cutResult(text)).toEqual({ text, cut: false })
  })

  test("a longer result is cut at 100000 characters, with a note", () => {
    const out = cutResult("b".repeat(200_000))
    expect(out.cut).toBe(true)
    expect(out.text.startsWith("b".repeat(CONNECTION_RESULT_MAX))).toBe(true)
    expect(out.text.endsWith(RESULT_CUT_NOTE)).toBe(true)
    expect(out.text.length).toBe(CONNECTION_RESULT_MAX + 1 + RESULT_CUT_NOTE.length)
  })

  test("counts characters, not units: a pair of units is one character", () => {
    const text = "😀".repeat(CONNECTION_RESULT_MAX)
    expect(cutResult(text).cut).toBe(false)
    expect(cutResult(`${text}x`).cut).toBe(true)
  })
})

describe("tool search", () => {
  const tool = (connection: string, name: string, description: string): SearchableTool => ({
    connection,
    tool: name,
    description,
    alias: `mcp__${connection.toLowerCase()}__${name}`,
  })
  const all = [
    tool("Weather", "forecast", "Weather forecast for a city"),
    tool("Weather", "alerts", "Storm alerts"),
    tool("Notes", "search", "Search the notes. Finds weather notes too"),
    tool("Notes", "add", "Add a note"),
  ]

  test("the step starts above 20 tools", () => {
    expect(needsToolSearch(20)).toBe(false)
    expect(needsToolSearch(21)).toBe(true)
  })

  test("a tool matches a word in its name or its description, with case ignored", () => {
    expect(searchTools(all, "WEATHER").map((t) => t.alias)).toEqual([
      "mcp__notes__search",
      "mcp__weather__forecast",
    ])
    expect(searchTools(all, "storm").map((t) => t.tool)).toEqual(["alerts"])
  })

  test("the tools with the most matching words come first", () => {
    expect(searchTools(all, "weather forecast city").map((t) => t.tool)).toEqual([
      "forecast",
      "search",
    ])
  })

  test("equal tools come in the order of the connection and then the tool", () => {
    const sameHits = [tool("B", "z", "x"), tool("A", "y", "x"), tool("A", "b", "x")]
    expect(searchTools(sameHits, "x").map((t) => `${t.connection}.${t.tool}`)).toEqual([
      "A.b",
      "A.y",
      "B.z",
    ])
  })

  test("at most 10 tools come back", () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      tool("C", `t${String(i).padStart(2, "0")}`, "weather"),
    )
    expect(searchTools(many, "weather")).toHaveLength(TOOL_SEARCH_RESULTS_MAX)
  })

  test("words that match nothing say so", () => {
    expect(searchTools(all, "zebra")).toEqual([])
    expect(searchResultText([])).toBe(NO_TOOL_FOUND_TEXT)
    expect(searchTools(all, "   ")).toEqual([])
  })

  test("the words are split at spaces and commas, with no repeats", () => {
    expect(toolSearchWords("Weather, weather  city;x")).toEqual(["weather", "city", "x"])
  })

  test("the answer names the call name, the connection and the tool", () => {
    const text = searchResultText(searchTools(all, "forecast"))
    expect(text).toContain("mcp__weather__forecast")
    expect(text).toContain('connection "Weather"')
    expect(text).toContain('tool "forecast"')
    expect(text).toContain("Weather forecast for a city")
  })
})

describe("the read-only mark (spec 018, Rules)", () => {
  test("a call is not risky only with the mark, the switch on, and no outside content", () => {
    const risky = (readOnlyMark: boolean, trusted: boolean, outside: boolean) =>
      connectionCallIsRisky({ readOnlyMark, trusted, outside })
    expect(risky(true, true, false)).toBe(false)
    // The switch is off: every call is risky.
    expect(risky(true, false, false)).toBe(true)
    // A tool with no mark is risky, with the switch on too.
    expect(risky(false, true, false)).toBe(true)
    expect(risky(false, false, false)).toBe(true)
    // A turn that holds outside content makes the call risky again.
    expect(risky(true, true, true)).toBe(true)
  })

  test("the mark counts at Ask for risky steps and Ask when unsure only", () => {
    expect(readOnlyMarkCounts("ask_risky")).toBe(true)
    expect(readOnlyMarkCounts("ask_unsure")).toBe(true)
    expect(readOnlyMarkCounts("ask_all")).toBe(false)
    expect(readOnlyMarkCounts("read_only")).toBe(false)
    expect(readOnlyMarkCounts("full")).toBe(false)
  })
})
