import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"

// Style rules for the style sheets of the main window.
//
// The tokens live in global.css: text steps, radius steps, motion times and curves. A style sheet
// uses them, so one change moves the whole app and "reduce motion" stops every motion. A value
// that is written by hand skips the token and goes out of step.
//
// The lists below hold values that were already there when the rules began. A new value that is
// not a token fails the test. A listed value that is gone must leave the list.

const root = join(import.meta.dir, "..")

// The status island is its own window. It does not load global.css, so it cannot use the tokens.
const skipped = new Set(["island/island.css"])

type Declaration = { file: string; line: number; prop: string; value: string }

function sheets(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...sheets(path))
    else if (entry.name.endsWith(".css") && !skipped.has(relative(root, path))) found.push(path)
  }
  return found.sort()
}

function declarations(): Declaration[] {
  const found: Declaration[] = []
  for (const path of sheets(root)) {
    // Comments become spaces of the same length, so a line number stays right.
    const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, (c) =>
      c.replace(/\S/g, " "),
    )
    for (const m of text.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)) {
      found.push({
        file: relative(root, path),
        line: text.slice(0, m.index).split("\n").length,
        prop: m[1] as string,
        value: (m[2] as string).replace(/\s+/g, " ").trim(),
      })
    }
  }
  return found
}

const all = declarations()

function key(d: Declaration): string {
  return `${d.file} | ${d.prop}: ${d.value}`
}

// Checks one rule. `existing` lists the known exceptions, one entry for each use.
function rule(name: string, hint: string, bad: (d: Declaration) => boolean, existing: string[]) {
  describe(name, () => {
    const found = all.filter(bad)
    const allowed = [...existing]
    const fresh: string[] = []
    for (const d of found) {
      const at = allowed.indexOf(key(d))
      if (at === -1) fresh.push(`${d.file}:${d.line} ${d.prop}: ${d.value}`)
      else allowed.splice(at, 1)
    }
    test(`no new value outside the tokens. ${hint}`, () => {
      expect(fresh).toEqual([])
    })
    test("every listed exception is still in use. Remove one that is gone", () => {
      expect(allowed).toEqual([])
    })
  })
}

const radiusStep = "var\\(--radius-[sml]\\)"
const radiusValue = new RegExp(
  `^(?:(?:${radiusStep}|0|50%|999px|calc\\(${radiusStep} - [0-9]+px\\)) ?)+$`,
)

rule(
  "text size",
  "Use var(--text-xs) to var(--text-2xl).",
  // A size in em is relative to the text around it, so it follows the step of that text.
  (d) => d.prop === "font-size" && !/^(?:var\(--text-[a-z0-9]+\)|inherit|[0-9.]+em)$/.test(d.value),
  [
    "chat/chat.module.css | font-size: 1.25rem",
    "chat/chat.module.css | font-size: 0.8rem",
    "devices/devices.module.css | font-size: 2rem",
    "shell/shell.module.css | font-size: 0.7rem",
    "shell/shell.module.css | font-size: 0.9rem",
  ],
)

rule(
  "radius",
  "Use var(--radius-s), var(--radius-m) or var(--radius-l).",
  (d) => /^border(?:-[a-z]+)*-radius$/.test(d.prop) && !radiusValue.test(d.value),
  [
    "shell/shell.module.css | border-radius: 30%",
    "shell/shell.module.css | border-radius: 2px",
    "shell/shell.module.css | border-radius: 9px",
    "ui/controls.module.css | border-radius: 10px",
    "workflows/workflows.module.css | border-radius: 10px",
  ],
)

const motionProps = /^(?:transition|animation)(?:-(?:duration|delay|timing-function))?$/
rule(
  "motion",
  "Use var(--motion-fast), var(--motion-medium) or var(--motion-slow), and var(--ease-out), var(--ease-in-out) or var(--ease-drawer). A loop that never ends is not checked.",
  (d) => {
    if (!motionProps.test(d.prop) || /\binfinite\b/.test(d.value)) return false
    // "visibility" switches at once, so its curve does not show. Split the parts at the commas.
    const value = d.value
      .split(/,(?![^(]*\))/)
      .filter((part) => !/^\s*visibility\b/.test(part))
      .join(",")
    const time = /(?<![\w.-])(?!0m?s\b)[0-9.]+m?s\b/.test(value)
    const curve =
      /(?<![\w-])(?:ease-in-out|ease-in|ease-out|ease|linear)(?![\w-])|cubic-bezier\(/.test(value)
    return time || curve
  },
  [],
)

rule(
  "colour",
  "Use a var(--c-...) colour. A black shadow or scrim may use rgb(0 0 0 / n).",
  (d) => {
    const value = d.value.replace(/rgb\(0 0 0 \/ [0-9.]+\)/g, "")
    return /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(value)
  },
  [
    "workflows/workflows.module.css | border-color: #3a9b57",
    "workflows/workflows.module.css | --note-tone: #e0b400",
    "workflows/workflows.module.css | --note-tone: #3b82f6",
    "workflows/workflows.module.css | --note-tone: #22a55b",
    "workflows/workflows.module.css | --note-tone: #e0558f",
  ],
)

// DESIGN.md, "Don't": a coloured stripe on the side of a block is decoration, not an edge. A
// quote or a call-out shows its kind with a tinted surface or a leading mark instead. The stripe
// may be written as left, right, or as the logical inline start, which changes side in Korean.
rule(
  "side stripe",
  "Do not draw a coloured stripe on the side of a block. Use a tinted surface or a leading mark.",
  (d) =>
    /^border-(?:(?:left|right|inline-start|inline-end)(?:-width)?|inline-(?:start|end)-width)$/.test(
      d.prop,
    ) && /^[2-9][0-9]*px\b/.test(d.value),
  [],
)
