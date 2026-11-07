import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { palettes } from "../theme/tokens.ts"

// Style rules for the style sheets of the main window.
//
// The tokens live in global.css: text steps, radius steps, motion times and curves. A style sheet
// uses them, so one change moves the whole app and "reduce motion" stops every motion. A value
// that is written by hand skips the token and goes out of step.
//
// The lists below hold values that were already there when the rules began. A new value that is
// not a token fails the test. A listed value that is gone must leave the list.

const root = join(import.meta.dir, "..")

const skipped = new Set<string>()

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
  ["devices/devices.module.css | font-size: 2rem"],
)

// DESIGN.md, "The Prose Rule". The step scale is what carries the hierarchy, so the scale itself
// is checked: the smallest step must stay readable when the user picks the small text size, and
// two neighbouring steps must stay far enough apart for a heading to read as a heading. The root
// sizes come from theme/apply.ts: small 13 px, default 14 px, large 16 px.
describe("text scale", () => {
  const steps = textSteps()
  const SMALL_ROOT = 13
  // A Korean syllable stops being readable below about 11 px at 100 percent zoom.
  const FLOOR = 11

  test("the smallest step stays readable at the small text size", () => {
    expect((steps[0] as number) * SMALL_ROOT).toBeGreaterThanOrEqual(FLOOR)
  })

  test("two neighbouring steps keep a gap a heading can stand on", () => {
    for (let i = 1; i < steps.length; i += 1) {
      expect((steps[i] as number) / (steps[i - 1] as number)).toBeGreaterThanOrEqual(1.1)
    }
  })

  test("the scale has a middle step that the sheets actually use", () => {
    const uses = all.filter((d) => d.value === "var(--text-m)").length
    expect(uses).toBeGreaterThan(0)
  })
})

/** The rem values of --text-xs to --text-2xl, in the order they are written in global.css. */
function textSteps(): number[] {
  const css = readFileSync(join(root, "styles/global.css"), "utf8")
  return ["xs", "s", "m", "l", "xl", "2xl"].map((name) => {
    const found = css.match(new RegExp(`--text-${name}:\\s*([0-9.]+)rem`))
    if (!found) throw new Error(`--text-${name} is missing from global.css`)
    return Number.parseFloat(found[1] as string)
  })
}

rule(
  "radius",
  "Use var(--radius-s), var(--radius-m) or var(--radius-l).",
  (d) => /^border(?:-[a-z]+)*-radius$/.test(d.prop) && !radiusValue.test(d.value),
  ["shell/shell.module.css | border-radius: 30%", "ui/controls.module.css | border-radius: 10px"],
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
  [],
)

// DESIGN.md, "Don't": a focus ring is never removed without a replacement. `:focus-visible` in
// global.css draws the ring that the keyboard uses, so a rule that drops the outline leaves the
// user with no way to see where the keyboard is. A part that wants its own ring sets one in the
// same sheet; this rule catches the sheet that only removes it.
rule(
  "focus ring",
  "Do not set outline: none. Replace the ring in the same sheet, or leave the global one.",
  (d) => d.prop === "outline" && /^none$/.test(d.value),
  [
    "providers/providers.module.css | outline: none",
    "settings/connections.module.css | outline: none",
    "settings/settings.module.css | outline: none",
    "ui/controls.module.css | outline: none",
  ],
)

// DESIGN.md, "The Lift Rule": a colour under the pointer comes from a token, so both themes hold
// their contrast. `filter: brightness()` is not a colour: it cannot be checked against the text on
// the button, and it moves a light theme and a dark theme in the same direction.
rule(
  "colour filter",
  "Do not change a colour with filter or opacity. Add a token for the colour under the pointer.",
  (d) => d.prop === "filter" && /brightness|saturate|contrast|hue-rotate/.test(d.value),
  [],
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

// A `var(--name)` with no fallback and no definition is not an error in CSS: the declaration is
// dropped, and a padding or a gap quietly becomes 0. So the sheet loads and looks broken, and
// nothing says why. The names that exist are the colour tokens (theme/tokens.ts), a name that a
// sheet declares, and a name that a script sets on an element. `var(--name, fallback)` is a
// choice to run without the name, so it is not checked. A name that one sheet declares for its own
// parts counts for every sheet: this finds a name that nobody defines, not one used out of scope.
function definedNames(): Set<string> {
  const names = new Set<string>()
  for (const palette of Object.values(palettes)) {
    for (const name of Object.keys(palette)) {
      names.add(`--c-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
    }
  }
  for (const path of sheets(root)) {
    for (const m of readFileSync(path, "utf8").matchAll(/(--[a-z0-9-]+)\s*:/g)) {
      names.add(m[1] as string)
    }
  }
  for (const path of scripts(root)) {
    for (const m of readFileSync(path, "utf8").matchAll(
      /["'`](--[a-z0-9-]+)["'`]|(--[a-z0-9-]+):/g,
    )) {
      names.add((m[1] ?? m[2]) as string)
    }
  }
  return names
}

function scripts(dir: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...scripts(path))
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) found.push(path)
  }
  return found.sort()
}

const defined = definedNames()
rule(
  "undefined variable",
  "Define the name in global.css, or use a name that exists. A name with no definition drops the whole declaration.",
  (d) =>
    [...d.value.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,?)/g)].some(
      (m) => m[2] === "" && !defined.has(m[1] as string),
    ),
  [],
)

// specs/039 (Looping motion). A mark that shows "work runs" moves with one period in every place:
// every spinner uses --motion-spin, every pulse uses --motion-pulse, and a pulse is slower than a
// spinner. No other animation repeats. Each looping rule has a rule that stops it with reduce
// motion, and the mark stays in its place (the rule sets `animation: none` and nothing that hides).
describe("looping motion (specs/039)", () => {
  type Block = { file: string; selector: string; body: string }

  function blocks(): Block[] {
    const found: Block[] = []
    for (const path of sheets(root)) {
      const text = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ")
      for (const m of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        found.push({
          file: relative(root, path),
          selector: (m[1] as string).replace(/\s+/g, " ").trim(),
          body: (m[2] as string).replace(/\s+/g, " ").trim(),
        })
      }
    }
    return found
  }

  const all = blocks()
  const loops = all.filter((b) => /(?:^|[;\s])animation\s*:[^;]*\binfinite\b/.test(b.body))
  const period = (name: string) => {
    const css = readFileSync(join(root, "styles/motion.css"), "utf8")
    const found = css.match(new RegExp(`${name}:\\s*([0-9.]+)ms`))
    if (!found) throw new Error(`${name} is missing from motion.css`)
    return Number.parseFloat(found[1] as string)
  }

  test("the page has at least one spinner and one pulse", () => {
    expect(loops.some((b) => b.body.includes("var(--motion-spin)"))).toBe(true)
    expect(loops.some((b) => b.body.includes("var(--motion-pulse)"))).toBe(true)
  })

  test("a looping animation uses the period of the spinner or of the pulse, and no other", () => {
    const bad = loops
      .filter((b) => !/var\(--motion-(?:spin|pulse)\)/.test(b.body))
      .map((b) => `${b.file} ${b.selector}`)
    expect(bad).toEqual([])
  })

  test("a spinner turns, a pulse does not, and a pulse is slower than a spinner", () => {
    for (const b of loops) {
      if (b.body.includes("var(--motion-spin)")) expect(b.body).toMatch(/\blinear\b/)
    }
    expect(period("--motion-pulse")).toBeGreaterThan(period("--motion-spin"))
  })

  test("reduce motion makes the durations of the ending motions zero, not the loops", () => {
    // The loops are not under these tokens; the next test stops them one by one.
    const css = readFileSync(join(root, "styles/global.css"), "utf8")
    const reduced = css.match(/:root\[data-reduce-motion="true"\]\s*\{([^}]*)\}/)
    expect(reduced?.[1]).toBeDefined()
    expect(reduced?.[1]).not.toContain("--motion-spin")
    expect(reduced?.[1]).not.toContain("--motion-pulse")
  })

  test("every looping rule has a rule that stops it with reduce motion and leaves it in place", () => {
    const missing: string[] = []
    for (const loop of loops) {
      // A rule like `.a .b` is stopped by `:root[data-reduce-motion="true"] .a .b`.
      const stop = all.find(
        (b) =>
          b.file === loop.file &&
          b.selector === `:root[data-reduce-motion="true"] ${loop.selector}` &&
          /\banimation\s*:\s*none\b/.test(b.body),
      )
      if (!stop) missing.push(`${loop.file} ${loop.selector}`)
      else
        expect(stop.body).not.toMatch(/\b(?:display|visibility|opacity)\s*:\s*(?:none|hidden|0)\b/)
    }
    expect(missing).toEqual([])
  })
})
