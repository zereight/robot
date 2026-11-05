---
name: ROBot
description: A night desk for a small team of AI agents. Deep violet-neutrals, one accent that shows where you are, one glow that shows what is alive.
colors:
  rail: "#0b0b12"
  sidebar: "#15151e"
  main: "#1e1e26"
  elevated: "#292933"
  hover: "#33333d"
  selected: "#40404c"
  border: "#454550"
  text: "#f4f4f7"
  text-muted: "#b4b5bf"
  accent: "#6a56d8"
  accent-ink: "#b3afff"
  accent-text: "#fdfdfd"
  accent-hover: "#5a44c4"
  success: "#48deb3"
  danger: "#ff9492"
  danger-hover: "#ffaba7"
  danger-text: "#0d0c13"
  focus: "#b3afff"
typography:
  display:
    fontFamily: "system-ui, -apple-system, Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "system-ui, -apple-system, Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-0.015em"
  title:
    fontFamily: "system-ui, -apple-system, Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "system-ui, -apple-system, Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "system-ui, -apple-system, Segoe UI, Apple SD Gothic Neo, Malgun Gothic, Noto Sans KR, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.4
  mono:
    fontFamily: "ui-monospace, SF Mono, Menlo, Consolas, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    typography: "label"
  button-primary-hover:
    backgroundColor: "{colors.accent-hover}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-primary-disabled:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-text}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-danger:
    backgroundColor: "{colors.danger}"
    textColor: "{colors.danger-text}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  input-search:
    backgroundColor: "{colors.main}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "5px 10px"
  place-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-muted}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "34px"
  place-row-selected:
    backgroundColor: "{colors.selected}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 8px"
    height: "34px"
  message-row:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    padding: "8px 16px"
  panel-header:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.text}"
    padding: "0 16px"
    height: "48px"
---

# Design System: ROBot

## 1. Overview

**Creative North Star: "The Night Desk"**

ROBot is a desk lamp in a dark room. The room is deep violet-black, not grey, because the app
mark is a night sky and the interface should belong to it. Most of the screen sits at a low
lightness, so the few things that matter can glow without shouting.

The system is built on one idea: **two lights, two meanings.** The accent violet marks the place
the user is and the thing they can press. The mint glow marks what is alive: a working agent, a
running task. They never swap roles. Nothing else glows. A screen with no work in it has no
glow at all, and that is the correct look for an idle app.

Surfaces carry the structure. A panel is a step in lightness, not a box with a border around
it. Borders exist to seal an edge at a boundary, not to draw furniture. This is what separates a
calm tool from a wireframe.

This system explicitly rejects the generic AI tool (violet-to-cyan gradients, glass cards, glow
borders), the SaaS dashboard (hero numbers, equal card grids, an eyebrow above every section),
the dense terminal (monospace everywhere, no hierarchy) and the Slack clone (it borrows the
layout of a chat server, never its look).

**Key Characteristics:**

- Deep violet-tinted neutrals at seven lightness steps, each step visible without a border.
- One accent (violet, hue 285) for position and action. One glow (mint, hue 170) for life.
- Prose-size body text. A glance at arm's length must be enough to read a sentence.
- Flat surfaces, no decorative gradients, sentence case, one line icon set.
- Motion under 300 ms, and only for state.

## 2. Colors

A dark violet room with one lamp and one living thing in it.

The whole neutral ramp carries a small chroma (0.014 to 0.022) at hue 285. That hue is taken
from the app mark's night tile (hue 286), so the surfaces and the icon are the same night, not a
grey desk with a purple sticker on it. The chroma stays under 0.025: this is a tinted neutral,
not a coloured surface. Above that the room reads as "purple app", which is the anti-reference.

### Primary

- **Lamp Violet** (`#6a56d8`, oklch 0.545 0.190 285): The accent. It marks the selected server
  tile, the selected place row's badge, a primary button, and a count that needs the user. It is
  the only colour a filled control may take. It appears on well under 10% of any screen.
- **Lamp Ink** (`#b3afff`, oklch 0.790 0.120 285): The same hue, lifted for use as text and as
  the focus ring on dark surfaces. It is the accent you can read. Links, the focused control's
  outline, and accent-coloured words use this, never the fill violet.

### Secondary

- **Night Mint** (`#48deb3`, oklch 0.810 0.140 170): The glow. It is taken from the app mark's
  eye glow (hue 169.5). It means one thing only: this agent, channel or task is working right
  now. It is never decoration, never a "success" badge on a finished thing, and never a border.

### Neutral

- **Room Black** (`#0b0b12`): The server rail, behind everything. The darkest step.
- **Desk Side** (`#15151e`): The place list and the activity panel. The second step, so the
  list reads as a different plane from the conversation.
- **Paper** (`#1e1e26`): The conversation surface, the default background, and the fill of a
  search field.
- **Raised Card** (`#292933`): Anything that lifts off the paper: the actions bar over a
  message, a menu, a dialog body.
- **Hover Wash** (`#33333d`): The pointer is over this row.
- **Selection** (`#40404c`): This row is the current one. One step above hover, so a selected
  row that the pointer crosses does not lose its state.
- **Seam** (`#454550`): The 1 px line at a real boundary: under a header, between the rail and
  the list, around a dialog. It reaches 1.75:1 against the paper, which is enough to see a seam
  and not enough to draw furniture.

- **Read Ink** (`#f4f4f7`): Body text.
- **Quiet Ink** (`#b4b5bf`): Labels, timestamps, role lines, unselected place names. It reaches
  8.12:1 on the paper, so a small grey label is still a readable label.

### Named Rules

**The Two Lights Rule.** The accent violet is for position and action. The mint glow is for work
in progress. No third colour carries meaning. If a new state needs a colour, it maps to one of
these two or to the danger red, and nothing else.

**The Tinted-Neutral Rule.** Every neutral carries 0.014 to 0.022 chroma at hue 285. Never a
pure grey, and never above 0.025. A pure grey next to the app mark looks like a different
product; above 0.025 the room becomes a purple app.

**The Seam Rule.** A border is 1 px at `{colors.border}` and appears only where two regions
actually meet. It is never used to outline a card, a row on hover, or a chip that already has a
background step.

**The Lift Rule.** A colour under the pointer comes from a token, and it moves away from the text
on that control, so the label is easier to read while the pointer is over it, never harder. Never
`filter: brightness()`: it cannot be checked against the text, and it moves a light theme and a
dark theme the same way when one of them needs to go the other way.

## 3. Typography

**Display Font:** system UI stack (system-ui, with Apple SD Gothic Neo and Malgun Gothic before
the generic sans, so Korean is native on both macOS and Windows)
**Body Font:** the same stack. One family for the whole product.
**Label/Mono Font:** ui-monospace, for commands, paths, and keyboard shortcuts only.

**Character:** The app speaks in one voice at several sizes. There is no display face and no
pairing, because a tool that is read forty times an hour should not change its voice between a
heading and a sentence. The weight contrast does the work: 400 for prose, 500 for a control or a
selected row, 600 for a heading or a section name. Nothing above 600. Nothing below 400.

### Hierarchy

- **Display** (600, 1.875rem, line-height 1.2, tracking -0.02em): A page title only. Today,
  Workflows, Tasks. At most one per screen.
- **Headline** (600, 1.5rem, line-height 1.3, tracking -0.015em): The name of a thing being
  edited, such as an agent or a workflow step.
- **Title** (600, 1.25rem, line-height 1.35): A section name inside a page, a dialog title.
- **Body** (400, 1rem, line-height 1.55): Everything the user actually reads: a message, a
  description, a paragraph of a handbook, a code block, an error line, a reason that explains a
  state. Capped at 68ch.
- **Label** (500, 0.875rem, line-height 1.4): A control's text, a place row's name, a table
  column head, a count, a tag, a timestamp. Never used for a sentence.
- **Mono** (400, 0.875rem, line-height 1.5): A command, a file path, a shortcut key.

The root size is 14 px by default and the user can set 13 px or 16 px. Every step above is a
rem value against that root, so one setting moves the whole interface. The smallest step is
0.875rem, which is 12.25 px at the default root and 11.4 px at the small one: that is the
floor at which a Korean syllable still reads. Two neighbouring steps are always at least 1.11
apart.

### Named Rules

**The Prose Rule.** A sentence the user must read is never smaller than `body`. This covers a
code block, an error line and a reason that explains a state, not only a message. If one of
them is set at `label` size, that is a defect, not a tight layout. `label` is for a word: a
count, a tag, a timestamp, a column head, a place name.

**The Floor Rule.** No text step goes below 0.875rem, because at the small text size that is
11.4 px, where a Korean syllable starts to blur.

**The Three-Weight Rule.** 400, 500, 600. Nothing lighter, nothing heavier, and no italic in the
interface chrome. Emphasis inside a message uses 600 or a real semantic element.

## 4. Elevation

This system is **flat by tonal layering**. There is no shadow vocabulary in the interface. Depth
comes from one thing: the lightness step between two adjacent surfaces. Seven steps are defined,
and two adjacent steps are always at least 1.06:1 in contrast, which is the point at which a
seam becomes visible on a laptop screen without a border.

The one exception is the dialog scrim, which is `rgb(0 0 0 / 0.45)`. It is not a shadow; it is
the page going dark behind a decision.

**The Flat-By-Default Rule.** A surface at rest has no shadow and no outline. If a component
needs to float above another, it moves one step up the surface ladder. It does not gain a
shadow. A shadow in this app means the system has failed to find the right step.

## 5. Components

### Buttons

- **Shape:** Gently curved (`{rounded.md}`, 8 px). A pressable part inside a padded box takes
  4 px, so the curve stays parallel to its parent.
- **Primary:** Fill `{colors.accent}`, text `{colors.accent-text}`, padding `6px 12px`, weight
  500. One per region, and only for the action the user came to do.
- **Hover / Focus:** Fill moves to `{colors.accent-hover}`, a token that steps away from the
  button's own text so the label reads easier under the pointer, never harder. A ghost button
  takes `{colors.hover}`. Focus is a 2 px `{colors.focus}` outline at 2 px offset, never a glow,
  and a rule that sets `outline: none` must draw its own ring in the same sheet.
- **Disabled:** Fades to 0.5 opacity, takes `not-allowed` as the cursor, and drops the hover
  treatment. A button that cannot be pressed must not look like one that can. 134 places pass
  `disabled`; this is not a rare state.
- **Ghost:** No fill at rest, `{colors.text-muted}` text, `{colors.hover}` on hover, text to
  `{colors.text}`. This is the default button for everything that is not the main action.
- **Danger:** Fill `{colors.danger}`, text `{colors.danger-text}`. It deletes or removes a thing
  that exists. It reads at 7.11:1 on the light theme and 9.18:1 on the dark one. Under the
  pointer it moves to `{colors.danger-hover}`, on the same rule as the accent.

### Chips

- **Style:** `{colors.selected}` fill, `{colors.text-muted}` text, `{rounded.sm}`, 0 6px padding,
  weight 400. A role badge or a label under a name.
- **State:** A chip that can be pressed takes `{colors.hover}` and text `{colors.text}`. There is
  no outlined chip; if it needs an edge it needs a fill.

### Cards / Containers

- **Corner Style:** `{rounded.lg}` (12 px) for a dialog and a large container. Never above 12 px
  on a card. `{rounded.md}` for a row, a control, a small panel.
- **Background:** `{colors.elevated}` when the container lifts off the paper, `{colors.sidebar}`
  when it is a side region.
- **Shadow Strategy:** None. See Elevation.
- **Border:** Only at a real seam. See the Seam Rule.
- **Internal Padding:** `{spacing.lg}` (16 px) for a dialog, `{spacing.sm}` (8 px) for a row.

### Inputs / Fields

- **Style:** 1 px `{colors.border}`, fill `{colors.main}`, `{rounded.md}`, 5px 10px padding.
- **Focus:** Border to `{colors.focus}`. No box-shadow ring, no glow.
- **Error / Disabled:** Error text in `{colors.danger}` at `label` size under the field. A
  disabled field drops to `{colors.text-muted}` and keeps its border.
- **Placeholder:** Must reach 4.5:1 on `{colors.main}`. A placeholder is text the user reads.

### Navigation

- **Server rail:** `{colors.rail}` background, one 44 px round tile per server, 8 px gap. The
  selected tile takes `{colors.accent}` with `{colors.accent-text}` and changes from a circle to
  a 30% radius, plus a 4 px bar at the left edge in `{colors.text}`.
- **Page buttons:** `{rounded.md}`, transparent at rest, `{colors.hover}` on hover,
  `{colors.selected}` with `{colors.text}` for the current page. The count badge is
  `{colors.accent}` fill with `{colors.accent-text}`.
- **Place list:** `{colors.sidebar}` background. A section name is `label` at 600 in
  `{colors.text-muted}`, turning `{colors.text}` on hover. A row is 34 px (28 px in compact
  mode) at `{rounded.md}`.

### Signature: The Working Dot

The one glowing thing in the interface. A 9 px disc in `{colors.success}` sits at the corner of
an agent's face or a channel's `#` mark, ringed by a 2 px gap of the sidebar colour and a 4 px
halo of the same mint at 30%. While the work runs it breathes in 1.4 s: opacity 0.55 to 1 and
scale 0.8 to 1. It has no direction and no second motion. With reduce motion it is a still mint
dot. It means "working", never "done" and never "good".

## 6. Do's and Don'ts

### Do:

- **Do** keep every neutral at 0.014 to 0.022 chroma at hue 285, so the interface is the same
  night as the app mark.
- **Do** verify every text colour at 4.5:1 against every surface it can sit on, and every
  meaning-bearing glyph at 3:1. `theme/tokens.test.ts` is the source of truth, not the eye.
- **Do** keep two adjacent surface steps at 1.06:1 or more, so a panel is visible without a
  border.
- **Do** set a sentence at `body` size (1rem) or larger, always.
- **Do** use `{colors.accent-ink}` for accent text on dark surfaces and `{colors.accent}` only
  as a fill.
- **Do** keep every motion under 300 ms and give each one a reduced-motion answer.
- **Do** use sentence case in every label, heading and button.

### Don't:

- **Don't** use the generic AI tool look: no violet-to-cyan gradient, no glass card, no glowing
  border, no robot mascot, no gradient text.
- **Don't** build the SaaS dashboard: no hero metric, no grid of equal cards, no small uppercase
  tracked eyebrow above a section.
- **Don't** ship the dense terminal: no monospace outside mono content, no hairline grey line
  used as decoration, no flat hierarchy.
- **Don't** copy the Slack clone look. The layout may resemble a chat server; the surface
  treatment must not.
- **Don't** use a shadow as ornament. A surface that must float moves one step up the ladder.
- **Don't** use `border-left` or `border-right` above 1 px as a coloured accent on any card,
  row, callout or alert.
- **Don't** put a border and a soft wide shadow on the same element. This system has no shadow,
  so the pair cannot happen; if one appears, the component is wrong.
- **Don't** round a card above 12 px, or a section, input or row above 8 px. A pill is for a
  tag or a badge only.
- **Don't** tint a neutral toward warm "because the app feels warm". Warmth lives in the mark
  and the glow, not in the paper.
- **Don't** carry a state in colour alone. A working agent has a moving dot and a word. A failed
  step has an icon and a word.
- **Don't** ship a disabled button that looks like a live one. It fades, it refuses the pointer,
  and it drops its hover treatment. The app passes `disabled` in 134 places.
- **Don't** set `outline: none` without drawing a ring in the same sheet. The global
  `:focus-visible` rule is the only thing that shows a keyboard user where they are.
- **Don't** change a colour with `filter` or `opacity`. Add a token for the colour under the
  pointer instead, so both themes can be checked.
