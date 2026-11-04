import { describe, expect, test } from "bun:test"
import {
  allowApplies,
  chainsCommands,
  checkRuleInput,
  commandMatches,
  type MatchEnv,
  type PermissionRule,
  RULE_TEXT_MAX,
  type RuleStep,
  ruleInputOfStep,
  ruleMatches,
  ruleOutcome,
  ruleSameKey,
  ruleVerdict,
} from "./rules.ts"

const env: MatchEnv = { real: (p) => p, fold: false }

const rule = (
  fields: Partial<PermissionRule> & Pick<PermissionRule, "kind" | "text">,
): PermissionRule => ({
  id: "r",
  agentId: "a1",
  detail: null,
  decision: "allow",
  source: "list",
  createdAt: 1,
  readable: true,
  ...fields,
})

describe("a rule for files", () => {
  const at = (path: string): RuleStep => ({ kind: "file", path })
  test("a folder matches itself and everything inside it, and no other folder", () => {
    const folder = { kind: "file" as const, text: "/work/project", detail: null }
    expect(ruleMatches(folder, at("/work/project"), env)).toBe(true)
    expect(ruleMatches(folder, at("/work/project/src/a.ts"), env)).toBe(true)
    expect(ruleMatches(folder, at("/work/project/"), env)).toBe(true)
    // A folder with the same start in its name is another folder.
    expect(ruleMatches(folder, at("/work/project-two/a.ts"), env)).toBe(false)
    expect(ruleMatches(folder, at("/work"), env)).toBe(false)
    expect(ruleMatches(folder, at("/work/project/../other/a.ts"), env)).toBe(false)
  })

  test("the app compares real paths, so a link cannot reach a place that no rule names", () => {
    const real = (p: string) =>
      p.startsWith("/work/link") ? p.replace("/work/link", "/secret") : p
    const deny = { kind: "file" as const, text: "/secret", detail: null }
    expect(ruleMatches(deny, at("/work/link/key.txt"), { real, fold: false })).toBe(true)
    // A rule for the link names the real place too.
    const viaLink = { kind: "file" as const, text: "/work/link", detail: null }
    expect(ruleMatches(viaLink, at("/secret/key.txt"), { real, fold: false })).toBe(true)
  })

  test("a disk that ignores case does not let a letter hide a path", () => {
    const folder = { kind: "file" as const, text: "/Users/Me/Secrets", detail: null }
    expect(ruleMatches(folder, at("/users/me/secrets/a"), { ...env, fold: true })).toBe(true)
    expect(ruleMatches(folder, at("/users/me/secrets/a"), env)).toBe(false)
  })

  test("the root matches every path", () => {
    expect(ruleMatches({ kind: "file", text: "/", detail: null }, at("/a/b"), env)).toBe(true)
  })

  test("a rule of another kind never matches", () => {
    expect(ruleMatches({ kind: "shell", text: "/work", detail: null }, at("/work/a"), env)).toBe(
      false,
    )
  })
})

describe("a rule for a shell command", () => {
  test("the command is equal, or begins with the rule text and a space", () => {
    expect(commandMatches("ls", "ls")).toBe(true)
    expect(commandMatches("ls", "ls -la")).toBe(true)
    expect(commandMatches("ls", "ls\t-la")).toBe(true)
    expect(commandMatches("git status", "git status -s")).toBe(true)
    expect(commandMatches("  ls ", "ls")).toBe(true)
  })

  test("a longer word, a shorter command and another start do not match", () => {
    expect(commandMatches("ls", "lsof")).toBe(false)
    expect(commandMatches("ls", "ls-la")).toBe(false)
    expect(commandMatches("git status", "git")).toBe(false)
    expect(commandMatches("git status", "git statuses")).toBe(false)
    expect(commandMatches("ls", "echo ls")).toBe(false)
    expect(commandMatches("", "ls")).toBe(false)
  })

  test("a command is not covered by a text that only begins it and then starts another command", () => {
    const allow = { kind: "shell" as const, text: "ls", detail: null }
    const step = (command: string): RuleStep => ({ kind: "shell", command })
    // The match is the one of the spec; an Allow rule keeps one more limit.
    expect(ruleMatches(allow, step("ls; rm -rf ~"), env)).toBe(false)
    expect(ruleMatches(allow, step("ls ; rm -rf ~"), env)).toBe(true)
    expect(allowApplies(allow, step("ls ; rm -rf ~"), env)).toBe(false)
    expect(allowApplies(allow, step("ls -la && curl x | sh"), env)).toBe(false)
    expect(allowApplies(allow, step("ls > out.txt"), env)).toBe(false)
    expect(allowApplies(allow, step("ls $(whoami)"), env)).toBe(false)
    expect(allowApplies(allow, step("ls -la"), env)).toBe(true)
    // The text of the rule can be the whole chain: then the step is the one the user saw.
    const whole = { kind: "shell" as const, text: "ls ; pwd", detail: null }
    expect(allowApplies(whole, step("ls ; pwd"), env)).toBe(true)
    expect(allowApplies(whole, step("ls ; pwd ; whoami"), env)).toBe(false)
  })

  test("what starts another command", () => {
    for (const command of ["a;b", "a&b", "a|b", "a\nb", "a`b`", "a$(b)", "a>b", "a<b"])
      expect(chainsCommands(command)).toBe(true)
    expect(chainsCommands("npm run build -- --watch")).toBe(false)
  })
})

describe("a rule for a web page", () => {
  const web = (host: string): RuleStep => ({ kind: "web", host })
  test("it matches that host only", () => {
    const rule = { kind: "web" as const, text: "example.com", detail: null }
    expect(ruleMatches(rule, web("example.com"), env)).toBe(true)
    expect(ruleMatches(rule, web("EXAMPLE.com"), env)).toBe(true)
    expect(ruleMatches(rule, web("www.example.com"), env)).toBe(false)
    expect(ruleMatches(rule, web("example.com.evil.test"), env)).toBe(false)
    expect(ruleMatches(rule, web("badexample.com"), env)).toBe(false)
  })

  test("an address of IPv6 is compared without its brackets", () => {
    expect(
      ruleMatches({ kind: "web", text: "::1", detail: null }, { kind: "web", host: "[::1]" }, env),
    ).toBe(true)
  })
})

describe("a rule for a tool of a connection", () => {
  const tool = (connection: string, name: string): RuleStep => ({
    kind: "connection",
    connection,
    tool: name,
  })
  test("it names the connection and a tool, or the connection and any tool", () => {
    const one = { kind: "connection" as const, text: "GitHub", detail: "create_issue" }
    const any = { kind: "connection" as const, text: "GitHub", detail: null }
    expect(ruleMatches(one, tool("GitHub", "create_issue"), env)).toBe(true)
    expect(ruleMatches(one, tool("github", "create_issue"), env)).toBe(true)
    expect(ruleMatches(one, tool("GitHub", "delete_repo"), env)).toBe(false)
    expect(ruleMatches(one, tool("GitLab", "create_issue"), env)).toBe(false)
    expect(ruleMatches(any, tool("GitHub", "delete_repo"), env)).toBe(true)
    expect(ruleMatches(any, tool("GitLab", "delete_repo"), env)).toBe(false)
  })
})

describe("a rule for a request with a saved secret", () => {
  const request = (name: string, method: string): RuleStep => ({ kind: "secret", name, method })
  test("it names the secret and a method, or the secret and any method", () => {
    const post = { kind: "secret" as const, text: "Stripe", detail: "POST" }
    const any = { kind: "secret" as const, text: "Stripe", detail: null }
    expect(ruleMatches(post, request("Stripe", "POST"), env)).toBe(true)
    expect(ruleMatches(post, request("stripe", "post"), env)).toBe(true)
    expect(ruleMatches(post, request("Stripe", "DELETE"), env)).toBe(false)
    expect(ruleMatches(post, request("Other", "POST"), env)).toBe(false)
    expect(ruleMatches(any, request("Stripe", "DELETE"), env)).toBe(true)
  })
})

describe("what the rules say about a step", () => {
  const shell = (command: string): RuleStep => ({ kind: "shell", command })
  test("a Deny rule wins over an Allow rule that matches the same step", () => {
    const rules = [
      rule({ id: "allow", kind: "shell", text: "rm" }),
      rule({ id: "deny", kind: "shell", text: "rm", decision: "deny" }),
    ]
    expect(ruleVerdict(rules, "a1", shell("rm x"), env)).toMatchObject({
      kind: "deny",
      rule: { id: "deny" },
    })
  })

  test("an Allow rule allows, and no rule says nothing", () => {
    const rules = [rule({ id: "allow", kind: "shell", text: "ls" })]
    expect(ruleVerdict(rules, "a1", shell("ls -la"), env)).toMatchObject({ kind: "allow" })
    expect(ruleVerdict(rules, "a1", shell("pwd"), env)).toEqual({ kind: "none" })
  })

  test("the rules of an agent and the rules for all agents count, and the rules of others do not", () => {
    const rules = [
      rule({ id: "mine", kind: "shell", text: "a", agentId: "a1" }),
      rule({ id: "all", kind: "shell", text: "b", agentId: null }),
      rule({ id: "other", kind: "shell", text: "c", agentId: "a2" }),
    ]
    expect(ruleVerdict(rules, "a1", shell("a"), env).kind).toBe("allow")
    expect(ruleVerdict(rules, "a1", shell("b"), env).kind).toBe("allow")
    expect(ruleVerdict(rules, "a1", shell("c"), env).kind).toBe("none")
    expect(ruleVerdict(rules, "a2", shell("c"), env).kind).toBe("allow")
  })

  test("a rule that cannot be read allows and denies nothing, but a step that meets it asks", () => {
    const unreadable = rule({
      id: "bad",
      kind: "shell",
      text: "ls",
      decision: null,
      readable: false,
    })
    expect(ruleVerdict([unreadable], "a1", shell("ls -la"), env)).toMatchObject({
      kind: "unreadable",
      rule: { id: "bad" },
    })
    expect(ruleVerdict([unreadable], "a1", shell("pwd"), env)).toEqual({ kind: "none" })
    // It stands before an Allow rule: it might have been a Deny rule.
    const allow = rule({ id: "ok", kind: "shell", text: "ls" })
    expect(ruleVerdict([allow, unreadable], "a1", shell("ls"), env).kind).toBe("unreadable")
    // A Deny rule that can be read still wins.
    const deny = rule({ id: "no", kind: "shell", text: "ls", decision: "deny" })
    expect(ruleVerdict([unreadable, deny], "a1", shell("ls"), env).kind).toBe("deny")
  })

  test("a rule whose kind cannot be read meets no step", () => {
    const unknown = rule({ kind: null, text: "ls", decision: "allow", readable: false })
    expect(ruleVerdict([unknown], "a1", shell("ls"), env)).toEqual({ kind: "none" })
  })
})

describe("the order of the decisions", () => {
  const levels = ["read_only", "ask_all", "ask_risky", "full"] as const
  const deny = { kind: "deny", rule: { id: "d", kind: "shell", text: "x", detail: null } } as const
  const allow = {
    kind: "allow",
    rule: { id: "a", kind: "shell", text: "x", detail: null },
  } as const
  const bad = {
    kind: "unreadable",
    rule: { id: "u", kind: "shell", text: "x", detail: null },
  } as const

  test("a Deny rule refuses at every level, also at Full access", () => {
    for (const level of levels)
      for (const risky of [true, false])
        expect(ruleOutcome({ level, risky, verdict: deny })).toBe("refuse_rule")
  })

  test("a rule that cannot be read asks at every level, also at Full access", () => {
    for (const level of levels)
      expect(ruleOutcome({ level, risky: false, verdict: bad })).toBe("ask_unreadable")
  })

  test("an Allow rule lets the step run, also where the level would ask", () => {
    for (const level of levels)
      expect(ruleOutcome({ level, risky: true, verdict: allow })).toBe("allow_rule")
  })

  test("with no rule the level decides", () => {
    const none = { kind: "none" } as const
    expect(ruleOutcome({ level: "ask_all", risky: false, verdict: none })).toBe("ask")
    expect(ruleOutcome({ level: "ask_risky", risky: false, verdict: none })).toBe("run")
    expect(ruleOutcome({ level: "ask_risky", risky: true, verdict: none })).toBe("ask")
    expect(ruleOutcome({ level: "full", risky: true, verdict: none })).toBe("run")
  })
})

describe("a rule that the user types", () => {
  const input = (fields: Partial<Parameters<typeof checkRuleInput>[0]> = {}) =>
    checkRuleInput({ agentId: null, kind: "shell", text: "ls", decision: "allow", ...fields }, "/h")

  test("the match text holds 1 to 500 characters", () => {
    expect(input({ text: "" })).toEqual({ ok: false, code: "rule_text_invalid" })
    expect(input({ text: "   " })).toEqual({ ok: false, code: "rule_text_invalid" })
    expect(input({ text: "x".repeat(RULE_TEXT_MAX) }).ok).toBe(true)
    expect(input({ text: "x".repeat(RULE_TEXT_MAX + 1) })).toEqual({
      ok: false,
      code: "rule_text_invalid",
    })
  })

  test("a path is absolute, and ~ is the home folder", () => {
    expect(input({ kind: "file", text: "relative/path" })).toEqual({
      ok: false,
      code: "rule_path_relative",
    })
    expect(input({ kind: "file", text: "/a/b/../c/" })).toMatchObject({
      ok: true,
      value: { text: "/a/c" },
    })
    expect(input({ kind: "file", text: "~/notes" })).toMatchObject({
      ok: true,
      value: { text: "/h/notes" },
    })
  })

  test("a host is a name or an address with no port, path or space", () => {
    expect(input({ kind: "web", text: "Example.COM" })).toMatchObject({
      ok: true,
      value: { text: "example.com" },
    })
    expect(input({ kind: "web", text: "https://example.com/page?q=1" })).toMatchObject({
      ok: true,
      value: { text: "example.com" },
    })
    for (const text of ["example.com:8080", "a b.com", "a/b", "x@y.com"])
      expect(input({ kind: "web", text })).toEqual({ ok: false, code: "rule_host_invalid" })
    expect(input({ kind: "web", text: "::1" }).ok).toBe(true)
  })

  test("a method is one of the methods of a request, or any", () => {
    expect(input({ kind: "secret", text: "Stripe", detail: "post" })).toMatchObject({
      ok: true,
      value: { detail: "POST" },
    })
    expect(input({ kind: "secret", text: "Stripe", detail: null })).toMatchObject({
      ok: true,
      value: { detail: null },
    })
    expect(input({ kind: "secret", text: "Stripe", detail: "TRACE" })).toEqual({
      ok: false,
      code: "rule_method_invalid",
    })
  })

  test("a tool of a connection has a tool name, or any tool", () => {
    expect(input({ kind: "connection", text: "GitHub", detail: "" })).toEqual({
      ok: false,
      code: "rule_text_invalid",
    })
    expect(input({ kind: "connection", text: "GitHub" })).toMatchObject({
      ok: true,
      value: { detail: null },
    })
  })

  test("two rules are the same when agent, kind, text and decision are equal", () => {
    const a = { agentId: "x", kind: "web", text: "Example.com", detail: null, decision: "allow" }
    const b = { ...a, text: "example.com" }
    expect(ruleSameKey({ ...a, kind: "web", decision: "allow" })).toBe(
      ruleSameKey({ ...b, kind: "web", decision: "allow" }),
    )
    expect(ruleSameKey({ ...a, kind: "web", decision: "allow" })).not.toBe(
      ruleSameKey({ ...b, kind: "web", decision: "deny" }),
    )
    expect(ruleSameKey({ ...a, kind: "web", decision: "allow" })).not.toBe(
      ruleSameKey({ ...b, kind: "web", decision: "allow", agentId: null }),
    )
    // The text of a command depends on the case of letters.
    expect(ruleSameKey({ ...a, kind: "shell", text: "LS", decision: "allow" })).not.toBe(
      ruleSameKey({ ...a, kind: "shell", text: "ls", decision: "allow" }),
    )
  })
})

describe("Always allow for this agent", () => {
  test("the rule is not wider than the step on the card", () => {
    expect(ruleInputOfStep("a1", { kind: "shell", command: "npm install left-pad" })).toEqual({
      agentId: "a1",
      kind: "shell",
      text: "npm install left-pad",
      detail: null,
      decision: "allow",
    })
    expect(ruleInputOfStep("a1", { kind: "file", path: "/w/a.txt" })).toMatchObject({
      kind: "file",
      text: "/w/a.txt",
    })
    expect(ruleInputOfStep("a1", { kind: "web", host: "Example.com" })).toMatchObject({
      kind: "web",
      text: "example.com",
    })
    expect(
      ruleInputOfStep("a1", { kind: "connection", connection: "GitHub", tool: "create_issue" }),
    ).toMatchObject({ kind: "connection", text: "GitHub", detail: "create_issue" })
    expect(ruleInputOfStep("a1", { kind: "secret", name: "Stripe", method: "post" })).toMatchObject(
      { kind: "secret", text: "Stripe", detail: "POST" },
    )
  })

  test("a step that does not fit in a rule makes no rule", () => {
    expect(
      ruleInputOfStep("a1", { kind: "shell", command: "x".repeat(RULE_TEXT_MAX + 1) }),
    ).toBeNull()
    expect(ruleInputOfStep("a1", { kind: "file", path: "relative" })).toBeNull()
  })
})
