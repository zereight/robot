import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  CHECK_REPLY_LINE,
  CHECK_REPLY_MAX,
  CHECK_VERDICT_RULE,
  checkInstruction,
  checkStateText,
  endChars,
} from "@robot/shared"
import {
  type Call,
  callsFor,
  countItems,
  groupState,
  instructionV2,
  instructionV3,
  makeRandom,
  measure,
  parseItems,
  quotas,
  type ReplayItem,
  type ReplayOptions,
  rateOf,
  readCall,
  readCli,
  reportMarkdown,
  runReplay,
  type Scored,
  splitItems,
  startAndEnd,
  V4_NOTE,
} from "./judge-replay-lib.ts"

// All data here is made for the tests. The words LBL, DONE and REPLY mark the text of an item: a
// report must never hold them.

const item = (
  id: string,
  group: string,
  human: ReplayItem["human"],
  extra: Partial<ReplayItem> = {},
) =>
  ({
    id,
    group,
    tag: "synthetic",
    label: `LBL-${id}`,
    doneTest: `DONE-${id}`,
    reply: `REPLY-${id}`,
    human,
    ...extra,
  }) as ReplayItem

const many = (count: number, human: "pass" | "fail", prefix: string) =>
  Array.from({ length: count }, (_, i) => item(`${prefix}${i}`, `g-${prefix}${i}`, human))

// ------------------------------------------------------------------------------------ input

describe("the items", () => {
  const line = (extra: object = {}) =>
    JSON.stringify({
      id: "a",
      group: "g",
      tag: "real",
      label: "L",
      doneTest: "D",
      reply: "R",
      human: "pass",
      ...extra,
    })

  test("reads the lines, skips empty ones and a mark at the start of the file", () => {
    const text = `\uFEFF${line()}\n\n${line({ id: "b", split: "dev", member: "Bo", human: "skip" })}\n`
    const { items, problems } = parseItems(text)
    expect(problems).toEqual([])
    expect(items.map((i) => i.id)).toEqual(["a", "b"])
    expect(items[1]).toMatchObject({ split: "dev", member: "Bo", human: "skip" })
  })

  test("a fault names the line and the field and never shows a value", () => {
    const bad = [
      "this is not json SECRET-VALUE",
      JSON.stringify(["SECRET-VALUE"]),
      line({ tag: "SECRET-VALUE" }),
      line({ id: "c", human: "SECRET-VALUE", split: "SECRET-VALUE" }),
      line({ id: "d", doneTest: "  " }),
      line({ id: "e", members: [{ name: "x" }], messages: "SECRET-VALUE" }),
      line(),
      line(),
    ].join("\n")
    const { items, problems } = parseItems(bad)
    expect(items).toHaveLength(1)
    expect(problems.join("\n")).not.toContain("SECRET-VALUE")
    expect(problems).toContain("line 1: not valid JSON")
    expect(problems).toContain("line 2: not an object")
    expect(problems.some((p) => p.startsWith("line 3:") && p.includes('"tag"'))).toBe(true)
    expect(problems.some((p) => p.startsWith("line 4:") && p.includes('"human"'))).toBe(true)
    expect(problems.some((p) => p.startsWith("line 4:") && p.includes('"split"'))).toBe(true)
    expect(problems.some((p) => p.startsWith("line 5:") && p.includes('"doneTest"'))).toBe(true)
    expect(problems.some((p) => p.startsWith("line 6:") && p.includes('"members"'))).toBe(true)
    expect(problems.some((p) => p.startsWith("line 6:") && p.includes('"messages"'))).toBe(true)
    expect(problems).toContain('line 8: "id" is not unique')
  })
})

describe("an item that is not labeled yet", () => {
  const line = (extra: object = {}) =>
    JSON.stringify({
      id: "a",
      group: "g",
      tag: "real",
      label: "L",
      doneTest: "D",
      reply: "R",
      ...extra,
    })
  const text = [
    line({ id: "a", reply: "SECRET-REPLY" }),
    line({ id: "b", human: "pass" }),
    line({ id: "c", human: "skip" }),
    line({ id: "d" }),
  ].join("\n")

  test("is a fault that names the line and the field, says it is not labeled, and shows no value", () => {
    const { items, problems, unlabeled } = parseItems(text)
    expect(problems).toEqual([
      'line 1: "human" is missing, the item is not labeled yet',
      'line 4: "human" is missing, the item is not labeled yet',
    ])
    expect(problems.join("\n")).not.toContain("SECRET-REPLY")
    // The labeled items are read, and the unlabeled ones are in no list of items.
    expect(items.map((i) => i.id)).toEqual(["b", "c"])
    expect(unlabeled).toBe(0)
  })

  test("a wrong label is another fault from a missing label", () => {
    const { problems } = parseItems(line({ human: "maybe" }))
    expect(problems).toEqual(['line 1: "human" must be pass, fail, skip'])
    expect(parseItems(line({ human: null })).problems).toHaveLength(1)
    expect(parseItems(line({ human: "" })).problems[0]).toContain('"human" must be')
  })

  test("is counted, and never counted as skip, when the reader is told to allow it", () => {
    const parsed = parseItems(text, { allowUnlabeled: true })
    expect(parsed.problems).toEqual([])
    expect(parsed.items.map((i) => i.id)).toEqual(["b", "c"])
    expect(parsed.unlabeled).toBe(2)
    const counts = countItems(parsed.items, splitItems(parsed.items, 1), parsed.unlabeled)
    expect(counts).toMatchObject({ total: 1, skipped: 1, unlabeled: 2 })
    // Without the number the count is 0, and the other counts do not move.
    expect(countItems(parsed.items, splitItems(parsed.items, 1)).unlabeled).toBe(0)
  })

  test("other faults of an unlabeled item still show when the reader allows it", () => {
    const parsed = parseItems(line({ tag: "SECRET-VALUE" }), { allowUnlabeled: true })
    expect(parsed.unlabeled).toBe(0)
    expect(parsed.problems).toHaveLength(1)
    expect(parsed.problems[0]).toContain('"tag"')
    expect(parsed.problems[0]).not.toContain("SECRET-VALUE")
    // An id that is used twice is a fault, also for items with no label.
    expect(parseItems([line(), line()].join("\n"), { allowUnlabeled: true }).problems).toEqual([
      'line 2: "id" is not unique',
    ])
  })
})

// ------------------------------------------------------------------------------------ split

describe("the split", () => {
  const all = [
    ...many(50, "pass", "p"),
    ...many(20, "fail", "f"),
    item("s1", "g", "skip"),
    item("s2", "g", "skip"),
  ]

  test("the shares are 15, 45 and 40 percent, in whole items", () => {
    expect(quotas(20)).toEqual({ train: 3, dev: 9, test: 8 })
    expect(quotas(10)).toEqual({ train: 1, dev: 5, test: 4 })
    expect(quotas(50)).toEqual({ train: 7, dev: 23, test: 20 })
    for (const n of [0, 1, 2, 3, 7, 33, 99])
      expect(Object.values(quotas(n)).reduce((a, b) => a + b, 0)).toBe(n)
  })

  test("each set keeps the share of Pass and Fail, and the sets do not overlap", () => {
    const sets = splitItems(all, 7)
    const counts = countItems(all, sets)
    expect(counts.bySet.train).toEqual({ pass: 7, fail: 3 })
    expect(counts.bySet.dev).toEqual({ pass: 23, fail: 9 })
    expect(counts.bySet.test).toEqual({ pass: 20, fail: 8 })
    // Each item that is not skip is in exactly one set, and a skip item is in none.
    expect(sets.size).toBe(70)
    expect(sets.has("s1")).toBe(false)
    expect(counts.skipped).toBe(2)
    expect(counts.total).toBe(70)
    const names = [...sets.values()]
    expect(new Set(names)).toEqual(new Set(["train", "dev", "test"]))
  })

  test("the same seed gives the same sets, also when the lines come in another order", () => {
    const a = splitItems(all, 7)
    const b = splitItems([...all].reverse(), 7)
    expect([...a].sort()).toEqual([...b].sort())
    const c = splitItems(all, 8)
    expect([...c].sort()).not.toEqual([...a].sort())
  })

  test("a given set is kept, and the others fill the rest", () => {
    const fixed = all.map((i) =>
      i.id.startsWith("f") && Number(i.id.slice(1)) < 5 ? { ...i, split: "train" as const } : i,
    )
    expect(fixed.filter((i) => i.split === "train")).toHaveLength(5)
    const sets = splitItems(fixed, 7)
    for (const i of fixed) if (i.split) expect(sets.get(i.id)).toBe(i.split)
    const counts = countItems(fixed, sets)
    // The train set of Fail is over its share by the given items, so no other item goes there.
    expect(counts.bySet.train.fail).toBe(5)
    expect(counts.bySet.dev.fail + counts.bySet.test.fail).toBe(15)
    expect(counts.bySet.train.pass).toBe(7)
  })

  test("a generator with one seed gives one line of numbers", () => {
    const a = makeRandom(5)
    const b = makeRandom(5)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
    expect(makeRandom(6)()).not.toBe(makeRandom(5)())
  })
})

// ---------------------------------------------------------------------------------- measures

let counter = 0
const scored = (
  human: "pass" | "fail",
  outcomes: Scored["outcomes"],
  tag: Scored["tag"] = "synthetic",
) => ({ id: `s${++counter}`, tag, human, outcomes }) as Scored

describe("the measures", () => {
  test("a table with known counts gives the known Met rate and Catch rate", () => {
    const table: Scored[] = [
      ...Array.from({ length: 9 }, () => scored("pass", ["met"])),
      scored("pass", ["not_met"]),
      ...Array.from({ length: 4 }, () => scored("fail", ["not_met"])),
      scored("fail", ["met"]),
    ]
    const m = measure(table, 1, "k")
    expect(m.met.value).toBe(0.9)
    expect(m.met.items).toBe(10)
    expect(m.catch.value).toBe(0.8)
    expect(m.catch.items).toBe(5)
    // Plain accuracy is not given anywhere.
    expect(Object.keys(m).sort()).toEqual(["catch", "flip", "met", "noVerdict"])
    expect(JSON.stringify(m).toLowerCase()).not.toContain("accuracy")
  })

  test("a run with no verdict is a miss in the rate of its own label", () => {
    const m = measure(
      [scored("pass", ["met", "none"]), scored("fail", ["none", "not_met"])],
      1,
      "k",
    )
    expect(m.met.value).toBe(0.5)
    expect(m.catch.value).toBe(0.5)
    expect(m.noVerdict).toEqual({ trials: 4, none: 2 })
  })

  test("the interval is the same for the same seed and holds the point value", () => {
    const clusters = [
      ...Array.from({ length: 18 }, () => ({ hits: 1, trials: 1 })),
      { hits: 0, trials: 1 },
      { hits: 0, trials: 1 },
    ]
    const a = rateOf(clusters, 11, 2000)
    const b = rateOf(clusters, 11, 2000)
    expect(a).toEqual(b)
    expect(a.value).toBe(0.9)
    expect(a.low as number).toBeLessThanOrEqual(0.9)
    expect(a.high as number).toBeGreaterThanOrEqual(0.9)
    // With 20 items at 90% the interval is wide: about 13 points below the value.
    expect(a.low as number).toBeGreaterThan(0.7)
    expect(a.low as number).toBeLessThan(0.85)
    expect(a.high).toBe(1)
    // A rate of 100% has no width, and a group with no item has no rate.
    expect(rateOf([{ hits: 3, trials: 3 }], 1, 500)).toMatchObject({ value: 1, low: 1, high: 1 })
    expect(rateOf([], 1, 500)).toMatchObject({ value: null, low: null, high: null, items: 0 })
  })

  test("an item is one unit of resampling, with all its runs", () => {
    // Two items with 3 runs each give a wider interval than six items with one run each.
    const one = rateOf(
      [
        { hits: 3, trials: 3 },
        { hits: 0, trials: 3 },
      ],
      3,
      2000,
    )
    const six = rateOf(
      [
        ...Array.from({ length: 3 }, () => ({ hits: 1, trials: 1 })),
        ...Array.from({ length: 3 }, () => ({ hits: 0, trials: 1 })),
      ],
      3,
      2000,
    )
    expect(one.value).toBe(0.5)
    expect(one.low as number).toBeLessThan(six.low as number)
  })

  test("the share of items whose verdict changes between runs", () => {
    const m = measure(
      [
        scored("pass", ["met", "met", "met"]),
        scored("pass", ["met", "not_met", "met"]),
        scored("fail", ["not_met", "none", "not_met"]),
        scored("fail", ["met", "not_met", "none"]),
      ],
      1,
      "k",
    )
    expect(m.flip).toEqual({ items: 4, flipped: 2, share: 0.5 })
    expect(measure([], 1, "k").flip.share).toBeNull()
  })
})

// ------------------------------------------------------------------------------------ text

describe("the text of the calls", () => {
  const group = [
    item("a", "g1", "pass", { member: "Bo", channel: "Launch", topic: "Ship it" }),
    item("b", "g1", "skip", { member: "Cy", reply: `${"x".repeat(1800)}THE-END` }),
    item("c", "g1", "fail", { member: "Bo" }),
    item("d", "g2", "pass"),
  ]
  const wanted = (i: ReplayItem) => i.human !== "skip"
  const only = (version: "v1" | "v2" | "v3" | "v4", name: string) =>
    callsFor(version, group, 0, wanted).filter((c) => c.group === name)

  test("V1 is the check as it is: the shared instruction and the shared state text", () => {
    const [call] = only("v1", "g1") as Call[]
    const g1 = group.filter((i) => i.group === "g1")
    expect(call?.system).toBe(checkInstruction())
    expect(call?.user).toBe(checkStateText(groupState(g1, g1)))
    // The reply is cut as the app cuts it: the end of it, to the shared length.
    expect(call?.user).toContain(`${"x".repeat(CHECK_REPLY_MAX - "THE-END".length)}THE-END`)
    expect(call?.user).not.toContain("x".repeat(CHECK_REPLY_MAX))
    expect(call?.user.split("\n").at(-1)).toBe(CHECK_REPLY_LINE)
    // The skip item stays in the text, as the lead saw it. It is not read.
    expect(call?.user).toContain("Part 2: LBL-b")
    expect(call?.reads).toEqual([
      { id: "a", part: 1 },
      { id: "c", part: 3 },
    ])
    expect(call?.user).toContain("Channel: Launch")
    expect(call?.user).toContain("Topic: Ship it")
    expect(call?.user).toContain("- Bo\n- Cy")
  })

  test("the cut of a reply is the one of the app, for the last characters", () => {
    const reply = `${"a".repeat(1000)}${"b".repeat(CHECK_REPLY_MAX)}`
    const one = [item("z", "g", "pass", { reply })]
    const [call] = callsFor("v1", one, 0, wanted)
    expect(call?.user).toContain(endChars(reply, CHECK_REPLY_MAX))
    expect(call?.user).not.toContain("aaaa")
  })

  test("a group with no item to read gives no call", () => {
    expect(callsFor("v1", group, 0, (i) => i.id === "d").map((c) => c.group)).toEqual(["g2"])
    expect(callsFor("v3", group, 0, () => false)).toEqual([])
  })

  test("V2 asks for the reason before the verdict, for both verdicts, and changes nothing else", () => {
    const v2 = instructionV2()
    expect(v2).not.toBe(checkInstruction())
    const rule = v2.split("\n").find((l) => l.startsWith("For each part")) ?? ""
    expect(rule.indexOf('"reason"')).toBeLessThan(rule.indexOf('"verdict":"met"'))
    expect(rule.lastIndexOf('"reason"')).toBeLessThan(rule.indexOf('"verdict":"not_met"'))
    // Every other line is the line of the app.
    expect(v2.split("\n").filter((l) => !l.startsWith("For each part"))).toEqual(
      checkInstruction()
        .split("\n")
        .filter((l) => l !== CHECK_VERDICT_RULE),
    )
    const [call] = only("v2", "g2") as Call[]
    expect(call?.system).toBe(v2)
    expect(call?.user).toBe((only("v1", "g2") as Call[])[0]?.user as string)
  })

  test("V3 sends one part for each call and asks for a verdict only", () => {
    const calls = only("v3", "g1") as Call[]
    expect(calls).toHaveLength(2)
    expect(calls.map((c) => c.reads)).toEqual([[{ id: "a", part: 1 }], [{ id: "c", part: 3 }]])
    for (const call of calls) {
      expect(call.system).toBe(instructionV3())
      expect(call.system).not.toContain("nudge")
      expect(call.system).not.toContain('"action":"ask"')
      expect(call.system).toContain("Do not choose an action")
      expect(call.user.match(/^Part \d+:/gm)).toHaveLength(1)
    }
    expect(calls[1]?.user).toContain("Part 3: LBL-c")
    expect(calls[1]?.user).not.toContain("Part 1: LBL-a")
  })

  test("V4 shows the start and the end of a long reply, in the length of the cut", () => {
    const long = `START${"m".repeat(3000)}FINISH`
    const view = startAndEnd(long)
    expect([...view]).toHaveLength(CHECK_REPLY_MAX)
    expect(view.startsWith("START")).toBe(true)
    expect(view.endsWith("FINISH")).toBe(true)
    expect(view).toContain("the middle of the reply is left out")
    expect(startAndEnd("short reply")).toBe("short reply")
    const exact = "e".repeat(CHECK_REPLY_MAX)
    expect(startAndEnd(exact)).toBe(exact)
    const [call] = callsFor("v4", [item("l", "g", "pass", { reply: long })], 0, wanted)
    expect(call?.user).toContain("START")
    expect(call?.user).toContain("FINISH")
    expect(call?.system).toBe(checkInstruction())
  })

  test("a verdict is read with the shared reader, a part at a time", () => {
    const call = (only("v1", "g1") as Call[])[0] as Call
    const ok = readCall(
      call,
      '```json\n{"verdicts":[{"part":1,"verdict":"met"},{"part":3,"verdict":"Not met","reason":"r"}],"action":"nothing"}\n```',
    )
    expect(ok.outcomes.get("a")).toBe("met")
    expect(ok.outcomes.get("c")).toBe("not_met")
    const gap = readCall(call, '{"verdicts":[{"part":1,"verdict":"met"}],"action":"nothing"}')
    expect(gap.outcomes.get("c")).toBe("none")
    expect(gap).toMatchObject({ missing: 1, unreadable: 0 })
    const none = readCall(call, "I cannot decide.")
    expect([...none.outcomes.values()]).toEqual(["none", "none"])
    expect(none).toMatchObject({ unreadable: 2, missing: 0 })
  })
})

// ---------------------------------------------------------------------------- the command

describe("the command", () => {
  const env = { JUDGE_BASE_URL: "http://127.0.0.1:1/v1", JUDGE_MODEL: "m", JUDGE_API_KEY: "k" }

  test("defaults: 3 runs, the dev set, V1 to V3, and no report unless a folder is given", () => {
    const cli = readCli(["run", "--items", "i.jsonl", "--out", "o"], env)
    expect(cli.options).toMatchObject({
      runs: 3,
      sets: ["dev"],
      versions: ["v1", "v2", "v3"],
      perItem: false,
    })
    expect(cli.endpoint).toEqual({ baseUrl: env.JUDGE_BASE_URL, model: "m", apiKey: "k" })
    expect(() => readCli(["run", "--items", "i.jsonl"], env)).toThrow("--out")
  })

  test("V4 needs its option, and the sets and the runs can be chosen", () => {
    const cli = readCli(
      [
        "run",
        "--items",
        "i",
        "--out",
        "o",
        "--v4",
        "--sets",
        "test,train",
        "--runs",
        "5",
        "--per-item",
      ],
      env,
    )
    expect(cli.options.versions).toEqual(["v1", "v2", "v3", "v4"])
    expect(cli.options.sets).toEqual(["train", "test"])
    expect(cli.options.runs).toBe(5)
    expect(cli.options.perItem).toBe(true)
    expect(
      readCli(["run", "--items", "i", "--out", "o", "--sets", "all"], env).options.sets,
    ).toEqual(["train", "dev", "test"])
  })

  test("a fault names the option and no value, and the key is read from the environment only", () => {
    expect(() => readCli(["run", "--items", "i", "--out", "o", "--runs", "0"], env)).toThrow(
      "--runs",
    )
    expect(() => readCli(["run", "--items", "i", "--out", "o", "--sets", "dev,x"], env)).toThrow(
      "--sets",
    )
    expect(() =>
      readCli(["run", "--items", "i", "--out", "o"], { ...env, JUDGE_MODEL: "" }),
    ).toThrow("JUDGE_MODEL")
    expect(() => readCli(["run", "--items", "i", "--out", "o"], { JUDGE_MODEL: "m" })).toThrow(
      "JUDGE_BASE_URL",
    )
    let message = ""
    try {
      readCli(["run", "--items", "i", "--out", "o", "--key", "SECRET-KEY"], env)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain("Unknown argument")
    expect(message).not.toContain("SECRET-KEY")
    expect(() => readCli(["run", "--items", "i", "--out", "o", "--label", "../x"], env)).toThrow(
      "--label",
    )
    // No key is fine for a local service. "counts" needs no service and no folder.
    expect(
      readCli(["run", "--items", "i", "--out", "o"], { ...env, JUDGE_API_KEY: undefined }).endpoint
        ?.apiKey,
    ).toBeNull()
    expect(readCli(["counts", "--items", "i"], {}).endpoint).toBeNull()
  })
})

// ------------------------------------------------------------------- the whole replay

interface Seen {
  readonly authorization: string | null
  readonly body: {
    model: string
    stream: boolean
    tools?: unknown
    messages: { role: string; content: string }[]
  }
}
const seen: Seen[] = []
const flips = new Map<string, number>()
let broken = false

/** The scripted service. The word in the label of a part says what it answers. */
const wordOf = (label: string) => {
  const word = /LBL-([A-Z]+)/.exec(label)?.[1] ?? ""
  return word
}
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const body = (await req.json()) as Seen["body"]
    seen.push({ authorization: req.headers.get("authorization"), body })
    if (broken) return new Response('{"error":"REPLY-in-the-error"}', { status: 500 })
    const system = body.messages[0]?.content ?? ""
    const user = body.messages[1]?.content ?? ""
    const reasonFirst = system.includes("write the reason first")
    const parts = [...user.matchAll(/^Part (\d+): (.+)$/gm)].map((m) => ({
      number: Number(m[1]),
      word: wordOf(m[2] ?? ""),
      label: m[2] ?? "",
    }))
    let garbage = false
    const verdicts = parts.map((p) => {
      let verdict: "met" | "not_met" = p.word === "MET" || p.word === "WRONG" ? "met" : "not_met"
      if (p.word === "FLIP") {
        const key = `${system}${p.label}`
        const n = (flips.get(key) ?? 0) + 1
        flips.set(key, n)
        verdict = n % 2 === 1 ? "met" : "not_met"
      }
      if (p.word === "GARBAGE") garbage = true
      const reason = "made reason"
      return reasonFirst
        ? { part: p.number, reason, verdict }
        : verdict === "met"
          ? { part: p.number, verdict }
          : { part: p.number, verdict, reason }
    })
    const content = garbage ? "I cannot decide." : JSON.stringify({ verdicts, action: "nothing" })
    return Response.json({ choices: [{ message: { role: "assistant", content } }] })
  },
})
afterAll(() => server.stop())
const endpoint = {
  baseUrl: `http://127.0.0.1:${server.port}/v1`,
  apiKey: "sk-test-key",
  model: "fake-model",
}
const options: ReplayOptions = {
  runs: 3,
  seed: 5,
  sets: ["dev"],
  versions: ["v1", "v2", "v3"],
  resamples: 500,
  concurrency: 3,
  perItem: false,
}

const ITEMS: ReplayItem[] = [
  item("p1", "g1", "pass", { tag: "real", label: "LBL-MET-a", split: "dev" }),
  item("p2", "g1", "fail", { tag: "real", label: "LBL-BAD-a", split: "dev" }),
  item("p8", "g1", "skip", { label: "LBL-BAD-skip" }),
  item("p3", "g2", "pass", { label: "LBL-MET-b", split: "dev" }),
  // A part that a person marks Fail, and that the fake answers wrongly with "Met".
  item("p4", "g2", "fail", { label: "LBL-WRONG-b", split: "dev" }),
  // An answer that cannot be read.
  item("p5", "g3", "pass", { label: "LBL-GARBAGE-c", split: "dev" }),
  // An answer that changes between runs.
  item("p6", "g4", "pass", { label: "LBL-FLIP-d", split: "dev" }),
  item("p7", "g4", "fail", { label: "LBL-BAD-d", split: "dev" }),
  item("p9", "g6", "pass", { label: "LBL-MET-t", split: "test" }),
  item("p10", "g6", "fail", { label: "LBL-BAD-t", split: "test" }),
]

describe("the whole replay against a scripted service", () => {
  test("the rates, the interval, the flip share and the counts are the known ones", async () => {
    seen.length = 0
    flips.clear()
    broken = false
    const report = await runReplay(ITEMS, endpoint, options)
    expect(report.model).toBe("fake-model")
    // Counts: by tag and by label, with the skip item in none.
    expect(report.counts.byTag).toEqual({
      real: { pass: 1, fail: 1 },
      synthetic: { pass: 4, fail: 3 },
    })
    expect(report.counts.bySet).toEqual({
      train: { pass: 0, fail: 0 },
      dev: { pass: 4, fail: 3 },
      test: { pass: 1, fail: 1 },
    })
    expect(report.counts.skipped).toBe(1)
    expect(report.counts.total).toBe(9)
    for (const version of report.versions) {
      const dev = version.sets.dev?.all
      // Pass in dev: p1 3 of 3, p3 3 of 3, p5 0 of 3 (cannot be read), p6 2 of 3 (it flips).
      expect(dev?.met).toMatchObject({ items: 4, trials: 12 })
      expect(dev?.met.value).toBeCloseTo(8 / 12, 10)
      // Fail in dev: p2 3 of 3, p4 0 of 3 (answered wrongly), p7 3 of 3.
      expect(dev?.catch).toMatchObject({ items: 3, trials: 9 })
      expect(dev?.catch.value).toBeCloseTo(6 / 9, 10)
      for (const rate of [dev?.met, dev?.catch]) {
        expect(rate?.low as number).toBeLessThanOrEqual(rate?.value as number)
        expect(rate?.high as number).toBeGreaterThanOrEqual(rate?.value as number)
      }
      // Only p6 changes between runs. The answer that cannot be read is no verdict, not a change.
      expect(dev?.flip).toEqual({ items: 7, flipped: 1, share: 1 / 7 })
      expect(dev?.noVerdict).toEqual({ trials: 21, none: 3 })
      // By tag: the real items are all right, the made ones are not.
      const real = version.sets.dev?.real
      expect(real?.met.value).toBe(1)
      expect(real?.catch.value).toBe(1)
      const made = version.sets.dev?.synthetic
      expect(made?.met.value).toBeCloseTo(5 / 9, 10)
      expect(made?.catch.value).toBeCloseTo(3 / 6, 10)
    }
    // V1 and V2 send one call for each group and run, V3 one call for each part and run.
    const [v1, v2, v3] = report.versions
    expect(v1?.calls).toEqual({ total: 12, failed: 0, unreadable: 3, missing: 0 })
    expect(v2?.calls).toEqual({ total: 12, failed: 0, unreadable: 3, missing: 0 })
    expect(v3?.calls).toEqual({ total: 21, failed: 0, unreadable: 3, missing: 0 })
    expect(report.versions.map((v) => v.note)).toEqual([null, null, null])
    // Only the dev set was measured: no call for the group that holds only test items.
    expect(seen.some((s) => s.body.messages[1]?.content.includes("LBL-MET-t"))).toBe(false)
    expect(seen).toHaveLength(12 + 12 + 21)
  })

  test("the request has no tools, the model, the key and the two texts of the check", async () => {
    seen.length = 0
    flips.clear()
    await runReplay(ITEMS, endpoint, { ...options, runs: 1, versions: ["v1", "v2"] })
    for (const s of seen) {
      expect(s.authorization).toBe("Bearer sk-test-key")
      expect(s.body.model).toBe("fake-model")
      expect(s.body.stream).toBe(false)
      expect("tools" in s.body).toBe(false)
      expect(s.body.messages.map((m) => m.role)).toEqual(["system", "user"])
    }
    const v1 = seen.filter((s) => s.body.messages[0]?.content === checkInstruction())
    expect(v1).toHaveLength(4)
    // The skip item is in the text of its group, as the lead saw it.
    expect(v1.some((s) => s.body.messages[1]?.content.includes("Part 3: LBL-BAD-skip"))).toBe(true)
    expect(seen.filter((s) => s.body.messages[0]?.content === instructionV2())).toHaveLength(4)
  })

  test("V4 runs only when it is asked for, and the report says what it changes", async () => {
    flips.clear()
    const report = await runReplay(ITEMS, endpoint, { ...options, runs: 2, versions: ["v1", "v4"] })
    const v4 = report.versions.find((v) => v.version === "v4")
    expect(v4?.note).toBe(V4_NOTE)
    expect(V4_NOTE).toBe("changes a number in spec 004; not for the app")
    const text = reportMarkdown(report)
    expect(text).toContain("V4: changes a number in spec 004; not for the app")
    expect(JSON.stringify(report)).toContain("changes a number in spec 004; not for the app")
  })

  test("the test set is measured only when it is asked for", async () => {
    flips.clear()
    seen.length = 0
    const report = await runReplay(ITEMS, endpoint, {
      ...options,
      runs: 1,
      versions: ["v1"],
      sets: ["test"],
    })
    expect(Object.keys(report.versions[0]?.sets ?? {})).toEqual(["test"])
    expect(report.versions[0]?.sets.test?.all.met.value).toBe(1)
    expect(report.versions[0]?.sets.test?.all.catch.value).toBe(1)
    expect(report.notes.join("\n")).toContain("The test set was run.")
    expect(seen).toHaveLength(1)
  })

  test("a failed call is no verdict, and the body of the fault is never read", async () => {
    seen.length = 0
    broken = true
    const report = await runReplay(ITEMS, endpoint, { ...options, runs: 2, versions: ["v1"] })
    broken = false
    const v1 = report.versions[0]
    expect(v1?.calls).toEqual({ total: 8, failed: 8, unreadable: 0, missing: 0 })
    expect(v1?.sets.dev?.all.met.value).toBe(0)
    expect(v1?.sets.dev?.all.catch.value).toBe(0)
    expect(v1?.sets.dev?.all.noVerdict).toEqual({ trials: 14, none: 14 })
    expect(JSON.stringify(report)).not.toContain("in-the-error")
  })

  test("a service that cannot be reached gives no verdicts and no crash", async () => {
    const report = await runReplay(
      ITEMS,
      { ...endpoint, baseUrl: "http://127.0.0.1:1/v1", timeoutMs: 2000 },
      { ...options, runs: 1, versions: ["v1"] },
    )
    expect(report.versions[0]?.calls.failed).toBe(4)
  })

  test("the report never holds the text of a reply, a done test or a label, or the key", async () => {
    flips.clear()
    const report = await runReplay(ITEMS, endpoint, {
      ...options,
      versions: ["v1", "v2", "v3", "v4"],
      sets: ["train", "dev", "test"],
      perItem: true,
    })
    const json = JSON.stringify(report, null, 2)
    const markdown = reportMarkdown(report)
    for (const text of [json, markdown]) {
      expect(text).not.toContain("LBL-")
      expect(text).not.toContain("DONE-")
      expect(text).not.toContain("REPLY-")
      expect(text).not.toContain("sk-test-key")
      expect(text.toLowerCase()).not.toContain("accuracy")
    }
    // The rates, the counts and the flip share are in both.
    expect(markdown).toContain("Met rate")
    expect(markdown).toContain("Catch rate")
    expect(markdown).toContain("Changes between runs")
    expect(markdown).toContain("fake-model")
    // With the option, each item shows by id and outcomes only.
    const first = report.versions[0]?.items?.[0]
    expect(Object.keys(first ?? {}).sort()).toEqual(["human", "id", "outcomes", "set", "tag"])
    // No item of the file is a real one in this run? Two are, so there is no note about it.
    expect(report.notes.join("\n")).not.toContain("No item is real")
  })

  test("with no real item, the report says that the rates hold for made cases", async () => {
    const made = ITEMS.map((i) => ({ ...i, tag: "synthetic" as const }))
    const report = await runReplay(made, endpoint, { ...options, runs: 1, versions: ["v1"] })
    expect(report.notes.join("\n")).toContain(
      "No item is real. The rates hold for made cases and not for real use.",
    )
  })

  test("the same seed gives the same report", async () => {
    const run = async () => {
      flips.clear()
      return runReplay(ITEMS, endpoint, { ...options, now: new Date(0), concurrency: 1 })
    }
    const a = await run()
    const b = await run()
    expect(b).toEqual(a)
  })
})

// ------------------------------------------------------------------- the script itself

describe("the script", () => {
  const script = resolve(import.meta.dirname, "judge-replay.ts")
  // The same Bun as the one that runs the tests, not the first "bun" on the PATH. Each test that
  // starts a child process has a timeout of 30 s: on a busy machine the start of a process is slow.
  const run = async (cwd: string, args: string[], env: Record<string, string>) => {
    const child = Bun.spawn([process.execPath, script, ...args], {
      cwd,
      env: { ...process.env, JUDGE_BASE_URL: "", JUDGE_MODEL: "", JUDGE_API_KEY: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code: await child.exited, out, err }
  }
  const lines = ITEMS.map((i) => JSON.stringify(i)).join("\n")

  test("writes the two reports to the folder that was given, and nothing else", async () => {
    flips.clear()
    const dir = mkdtempSync(join(tmpdir(), "judge-replay-"))
    const work = join(dir, "work")
    mkdirSync(work)
    writeFileSync(join(dir, "items.jsonl"), lines)
    const result = await run(
      work,
      [
        "run",
        "--items",
        join(dir, "items.jsonl"),
        "--out",
        join(dir, "out"),
        "--label",
        "t1",
        "--runs",
        "2",
        "--sets",
        "all",
      ],
      {
        JUDGE_BASE_URL: endpoint.baseUrl,
        JUDGE_MODEL: "fake-model",
        JUDGE_API_KEY: "sk-test-key",
      },
    )
    expect(result.code).toBe(0)
    expect(readdirSync(join(dir, "out")).sort()).toEqual(["t1.json", "t1.md"])
    // The folder of the run holds no copy of the items and no output of the model.
    expect(readdirSync(work)).toEqual([])
    const json = readFileSync(join(dir, "out", "t1.json"), "utf8")
    const markdown = readFileSync(join(dir, "out", "t1.md"), "utf8")
    for (const text of [json, markdown, result.out, result.err]) {
      expect(text).not.toContain("LBL-")
      expect(text).not.toContain("DONE-")
      expect(text).not.toContain("REPLY-")
      expect(text).not.toContain("sk-test-key")
    }
    expect((JSON.parse(json) as { runs: number }).runs).toBe(2)
    expect(result.err).toContain("Sending the text of 10 items")
  }, 30_000)

  test("a file with faults, or no folder, writes nothing and shows no value", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-replay-"))
    writeFileSync(join(dir, "bad.jsonl"), `${JSON.stringify({ id: "a", tag: "SECRET-VALUE" })}\n`)
    const env = { JUDGE_BASE_URL: endpoint.baseUrl, JUDGE_MODEL: "m" }
    const bad = await run(
      dir,
      ["run", "--items", join(dir, "bad.jsonl"), "--out", join(dir, "o")],
      env,
    )
    expect(bad.code).toBe(1)
    expect(bad.err).toContain("line 1:")
    expect(bad.err).not.toContain("SECRET-VALUE")
    expect(existsSync(join(dir, "o"))).toBe(false)
    writeFileSync(join(dir, "ok.jsonl"), lines)
    const noOut = await run(dir, ["run", "--items", join(dir, "ok.jsonl")], env)
    expect(noOut.code).toBe(1)
    expect(noOut.err).toContain("--out")
    expect(readdirSync(dir).sort()).toEqual(["bad.jsonl", "ok.jsonl"])
  }, 30_000)

  test("an item with no label stops a run with its line and field, and counts reports the number", async () => {
    flips.clear()
    const dir = mkdtempSync(join(tmpdir(), "judge-replay-"))
    const rows = ITEMS.map((i) => JSON.stringify(i))
    // Two items lose their label: lines 2 and 5.
    for (const index of [1, 4]) {
      const { human: _human, ...rest } = ITEMS[index] as ReplayItem
      rows[index] = JSON.stringify(rest)
    }
    writeFileSync(join(dir, "mixed.jsonl"), rows.join("\n"))
    const env = { JUDGE_BASE_URL: endpoint.baseUrl, JUDGE_MODEL: "m" }
    const refused = await run(
      dir,
      ["run", "--items", join(dir, "mixed.jsonl"), "--out", join(dir, "o")],
      env,
    )
    expect(refused.code).toBe(1)
    expect(refused.err).toContain('line 2: "human" is missing, the item is not labeled yet')
    expect(refused.err).toContain('line 5: "human" is missing, the item is not labeled yet')
    expect(refused.err).not.toMatch(/LBL-|DONE-|REPLY-/)
    expect(existsSync(join(dir, "o"))).toBe(false)
    expect(flips.size).toBe(0)

    const counted = await run(dir, ["counts", "--items", join(dir, "mixed.jsonl")], {})
    expect(counted.code).toBe(0)
    const counts = JSON.parse(counted.out) as { total: number; skipped: number; unlabeled: number }
    // The two unlabeled items are in no other count: not as skip, not as Pass, not as Fail.
    expect(counts).toMatchObject({ total: 7, skipped: 1, unlabeled: 2 })

    // A file where no item has a label: counts works and reports them all, and run refuses.
    const bare = ITEMS.map((i) => {
      const { human: _human, ...rest } = i
      return JSON.stringify(rest)
    }).join("\n")
    writeFileSync(join(dir, "bare.jsonl"), bare)
    const none = await run(dir, ["counts", "--items", join(dir, "bare.jsonl")], {})
    expect(none.code).toBe(0)
    expect(JSON.parse(none.out)).toMatchObject({ total: 0, skipped: 0, unlabeled: 10 })
    const stop = await run(
      dir,
      ["run", "--items", join(dir, "bare.jsonl"), "--out", join(dir, "o")],
      env,
    )
    expect(stop.code).toBe(1)
    expect(stop.err).toContain('line 1: "human" is missing')
  }, 30_000)

  test("counts shows the counts and the split and calls no service", async () => {
    const dir = mkdtempSync(join(tmpdir(), "judge-replay-"))
    writeFileSync(join(dir, "ok.jsonl"), lines)
    const result = await run(dir, ["counts", "--items", join(dir, "ok.jsonl")], {})
    expect(result.code).toBe(0)
    const counts = JSON.parse(result.out) as { total: number; skipped: number }
    expect(counts).toMatchObject({ total: 9, skipped: 1 })
    expect(result.out).not.toContain("LBL-")
  }, 30_000)
})
