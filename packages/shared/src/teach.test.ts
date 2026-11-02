import { describe, expect, test } from "bun:test"
import { skillProblems } from "./skills.ts"
import {
  addStep,
  isSecretField,
  parseDraft,
  redactAddress,
  stepLine,
  type TeachEvent,
  type TeachStep,
  teachEventOf,
  teachPrompt,
  toStep,
} from "./teach.ts"

type Typed = Extract<TeachEvent, { kind: "type" }>
const typed = (label: string, text: string, extra: Partial<Typed> = {}): Typed => ({
  kind: "type",
  label,
  text,
  password: false,
  autocomplete: "",
  ...extra,
})

describe("teach: secret fields", () => {
  test("a password field records no text, whatever its label", () => {
    const step = toStep(typed("Login", "hunter22", { password: true }))
    expect(step).toEqual({ kind: "secret", label: "Login" })
    expect(stepLine(step)).toBe("Typed a secret into Login")
  })

  test("a label that names a password, a code, a token, a key or a card number hides the text", () => {
    for (const label of [
      "Password",
      "One-time code",
      "API token",
      "License key",
      "Card number",
      "비밀번호",
    ]) {
      const step = toStep(typed(label, "s3cret-value"))
      expect(step.kind).toBe("secret")
      expect(JSON.stringify(step)).not.toContain("s3cret-value")
    }
  })

  test("an autocomplete hint of a secret hides the text", () => {
    expect(isSecretField(typed("Number", "4111", { autocomplete: "cc-number" }))).toBe(true)
  })

  test("an ordinary field keeps its text", () => {
    expect(stepLine(toStep(typed("Name", "hello")))).toBe('Typed "hello" into Name')
  })

  test("text that looks like a secret is hidden in typed text, labels and titles", () => {
    const key = "sk-abcdefghijklmnopqrstuvwxyz"
    const step = toStep(typed("Note", `use ${key}`))
    expect(JSON.stringify(step)).not.toContain(key)
    expect(JSON.stringify(step)).toContain("[redacted]")
    const page = toStep({ kind: "page", url: "https://a.test/", title: `Key ${key}` })
    expect(JSON.stringify(page)).not.toContain(key)
  })
})

describe("teach: addresses", () => {
  test("secret parameters, user names and secret shapes become [redacted]", () => {
    const out = redactAddress(
      "https://me:pw@site.test/cb?code=abc123&token=xyz&page=2&q=ghp_abcdefghijklmnopqrstuvwxyz",
    )
    expect(out).not.toContain("abc123")
    expect(out).not.toContain("xyz")
    expect(out).not.toContain("me:pw")
    expect(out).not.toContain("ghp_")
    expect(out).toContain("page=2")
    expect(out).toContain("code=[redacted]")
  })

  test("an address with nothing secret stays as it is", () => {
    expect(redactAddress("https://site.test/reports?week=12")).toBe(
      "https://site.test/reports?week=12",
    )
  })
})

describe("teach: steps", () => {
  test("scrolls that follow each other are one step; the last direction counts", () => {
    let steps: readonly TeachStep[] = []
    for (const down of [true, true, false]) steps = addStep(steps, { kind: "scroll", down })
    expect(steps).toEqual([{ kind: "scroll", down: false }])
    steps = addStep(steps, { kind: "key", key: "Enter" })
    steps = addStep(steps, { kind: "scroll", down: true })
    expect(steps.length).toBe(3)
  })

  test("the same page twice in a row is one step", () => {
    let steps: readonly TeachStep[] = []
    steps = addStep(steps, { kind: "page", url: "https://a.test/", title: "" })
    steps = addStep(steps, { kind: "page", url: "https://a.test/", title: "A" })
    expect(steps).toEqual([{ kind: "page", url: "https://a.test/", title: "A" }])
  })

  test("each kind of step reads as plain words", () => {
    expect(stepLine({ kind: "click", role: "button", label: "Press" })).toBe(
      'Clicked the button "Press"',
    )
    expect(stepLine({ kind: "click", role: "", label: "Hello" })).toBe('Clicked "Hello"')
    expect(stepLine({ kind: "choose", label: "Country", choice: "Korea" })).toBe(
      'Chose "Korea" in Country',
    )
    expect(stepLine({ kind: "key", key: "Enter" })).toBe("Pressed Enter")
    expect(stepLine({ kind: "page", url: "https://a.test/", title: "A" })).toBe(
      'Opened the page "A" at https://a.test/',
    )
  })

  test("the prompt holds the result and the numbered steps, and ends with the form", () => {
    const prompt = teachPrompt("Get the report", [
      { kind: "click", role: "button", label: "Press" },
      { kind: "secret", label: "Password" },
    ])
    expect(prompt).toContain("The result of the task: Get the report")
    expect(prompt).toContain('1. Clicked the button "Press"')
    expect(prompt).toContain("2. Typed a secret into Password")
    expect(prompt.split("\n").at(-1)).toBe("Reply with the JSON object only.")
  })
})

describe("teach: the answer of the model", () => {
  test("a JSON object, also in a code fence, gives the draft", () => {
    const draft = parseDraft(
      '```json\n{"name": "/Weekly report", "description": "Get it", "instructions": "1. Open"}\n```',
    )
    expect(draft).toEqual({ name: "Weekly report", description: "Get it", instructions: "1. Open" })
  })

  test("no object, or no instructions, gives nothing", () => {
    expect(parseDraft("I cannot help.")).toBeUndefined()
    expect(parseDraft('{"name": "x"}')).toBeUndefined()
  })

  test("long fields are cut to the limits of a skill", () => {
    const draft = parseDraft(
      JSON.stringify({ name: "n".repeat(80), description: "d".repeat(300), instructions: "i" }),
    )
    expect(draft?.name.length).toBe(40)
    expect(draft?.description.length).toBe(140)
    expect(skillProblems(draft as never)).toEqual([])
  })
})

describe("teach: steps from the page are checked", () => {
  test("known shapes pass and anything else is dropped", () => {
    expect(teachEventOf({ kind: "click", role: "button", label: "Go" })).toEqual({
      kind: "click",
      role: "button",
      label: "Go",
    })
    expect(teachEventOf({ kind: "key", key: "Enter" })).toEqual({ kind: "key", key: "Enter" })
    expect(teachEventOf({ kind: "key", key: "a" })).toBeUndefined()
    expect(teachEventOf({ kind: "page", url: "https://x.test", title: "" })).toBeUndefined()
    expect(teachEventOf({ kind: "type", label: "A", text: 3 })).toBeUndefined()
    expect(teachEventOf(null)).toBeUndefined()
  })
})

describe("skills: the checks of the form", () => {
  test("name, description and instructions limits", () => {
    expect(skillProblems({ name: " / ", description: "", instructions: "x" })[0]?.code).toBe(
      "skill_name_empty",
    )
    expect(
      skillProblems({ name: "n".repeat(41), description: "", instructions: "x" })[0]?.code,
    ).toBe("skill_name_long")
    expect(
      skillProblems({ name: "a", description: "d".repeat(141), instructions: "x" })[0]?.code,
    ).toBe("skill_description_long")
    expect(skillProblems({ name: "a", description: "", instructions: "  " })[0]?.code).toBe(
      "skill_empty",
    )
  })
})
