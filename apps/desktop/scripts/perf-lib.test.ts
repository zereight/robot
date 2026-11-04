import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempDir } from "../src/main/test-temp.ts"
import {
  checkSizes,
  compareMarkdown,
  compareReports,
  frameGaps,
  isReport,
  lateParts,
  measureSizes,
  medianAndWorst,
  type PerfReport,
  percentile,
  reportMarkdown,
  safeLabel,
  sizeGroup,
} from "./perf-lib.ts"

const report = (label: string, values: Record<string, number | null>): PerfReport => ({
  format: 1,
  label,
  createdAt: "2026-11-02T10:00:00.000Z",
  app: { version: "0.1.0", path: "/app" },
  system: {
    platform: "darwin",
    arch: "arm64",
    release: "25.0.0",
    cpu: "Test CPU",
    cpus: 8,
    memoryGb: 16,
  },
  notes: ["Cold means that the caches of the window engine are cleared."],
  measures: Object.entries(values).map(([id, value]) => ({ id, name: id, unit: "ms", value })),
  samples: {},
})

describe("numbers", () => {
  test("median and worst of the samples", () => {
    expect(medianAndWorst("launch.cold", "Cold launch", "ms", [300, 100, 200, 900, 250])).toEqual([
      { id: "launch.cold.median", name: "Cold launch, median", unit: "ms", value: 250 },
      { id: "launch.cold.worst", name: "Cold launch, worst", unit: "ms", value: 900 },
    ])
    expect(medianAndWorst("x", "X", "ms", [])[0]?.value).toBeNull()
  })

  test("percentile by the nearest rank", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1)
    expect(percentile(values, 95)).toBe(95)
    expect(percentile([5], 95)).toBe(5)
    expect(percentile([], 95)).toBeNull()
  })

  test("frame gaps and late parts", () => {
    expect(frameGaps([0, 16, 33, 83])).toEqual([16, 17, 50])
    const sent = [
      { index: 0, at: 1000 },
      { index: 1, at: 1050 },
      { index: 2, at: 1100 },
    ]
    const drawn = new Map([
      [0, 1040],
      [1, 1200],
    ])
    // Part 1 shows 150 ms late, part 2 never shows.
    expect(lateParts(sent, drawn, 100)).toBe(2)
  })
})

describe("reports", () => {
  test("Markdown has the label, the measures and the notes; unknown is a dash", () => {
    const md = reportMarkdown(report("before", { "launch.cold.median": 812.5, typing: null }))
    expect(md).toContain("# Performance report: before")
    expect(md).toContain("| launch.cold.median | 812.5 ms |")
    expect(md).toContain("| typing | — |")
    expect(md).toContain("caches of the window engine")
  })

  test("compare shows both values and the change in percent", () => {
    const a = report("before", { launch: 200, typing: 10, gone: 5, zero: 0 })
    const b = report("after", { launch: 250, typing: 9, added: 1, zero: 3 })
    const rows = compareReports(a, b)
    expect(rows.find((r) => r.id === "launch")).toMatchObject({
      before: 200,
      after: 250,
      change: 25,
    })
    expect(rows.find((r) => r.id === "typing")?.change).toBe(-10)
    expect(rows.find((r) => r.id === "gone")).toMatchObject({ after: null, change: null })
    expect(rows.find((r) => r.id === "added")).toMatchObject({ before: null, change: null })
    expect(rows.find((r) => r.id === "zero")?.change).toBeNull()
    const md = compareMarkdown(a, b)
    expect(md).toContain("| Measure | before | after | Change |")
    expect(md).toContain("| launch | 200 ms | 250 ms | +25% |")
  })

  test("a report file is checked and a label is safe as a file name", () => {
    expect(isReport(report("a", {}))).toBe(true)
    expect(isReport({ label: "a" })).toBe(false)
    expect(safeLabel(" after fix ")).toBe("after-fix")
    expect(() => safeLabel("../x")).toThrow()
    expect(() => safeLabel("  ")).toThrow()
  })
})

describe("sizes", () => {
  test("groups the built files of the window and of the main process", () => {
    expect(sizeGroup("main/index.js")).toBe("main")
    expect(sizeGroup("preload/index.cjs")).toBe("preload")
    expect(sizeGroup("renderer/assets/index-abc.js")).toBe("window.js")
    expect(sizeGroup("renderer/assets/index-abc.css")).toBe("window.css")
    expect(sizeGroup("renderer/index.html")).toBe("window.other")
    expect(sizeGroup("stray.txt")).toBeNull()
  })

  test("measures a build folder and leaves out source maps", () => {
    const out = tempDir("robot-sizes-")
    mkdirSync(join(out, "main"))
    mkdirSync(join(out, "renderer/assets"), { recursive: true })
    writeFileSync(join(out, "main/index.js"), "x".repeat(100))
    writeFileSync(join(out, "main/index.js.map"), "x".repeat(999))
    writeFileSync(join(out, "renderer/assets/a.js"), "x".repeat(30))
    writeFileSync(join(out, "renderer/assets/b.js"), "x".repeat(20))
    writeFileSync(join(out, "renderer/index.html"), "x".repeat(7))
    expect(measureSizes(out)).toEqual({ main: 100, "window.js": 50, "window.other": 7 })
  })

  test("fails a growth of more than 10 percent and a group with no baseline", () => {
    const baseline = { main: 1000, "window.js": 2000, old: 50 }
    expect(checkSizes({ main: 1100, "window.js": 1500 }, baseline).ok).toBe(true)
    const grown = checkSizes({ main: 1101, "window.js": 2000 }, baseline)
    expect(grown.ok).toBe(false)
    expect(grown.rows.find((r) => r.group === "main")).toMatchObject({ ok: false, change: 10.1 })
    const added = checkSizes({ main: 1000, "window.js": 2000, "window.css": 10 }, baseline)
    expect(added.ok).toBe(false)
    expect(added.rows.find((r) => r.group === "window.css")?.ok).toBe(false)
  })
})
