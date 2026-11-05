/** Colour tokens. Each theme defines the same names. */
export interface Palette {
  rail: string
  sidebar: string
  main: string
  elevated: string
  hover: string
  selected: string
  border: string
  text: string
  textMuted: string
  accent: string
  accentText: string
  /**
   * The accent under the pointer. It moves away from the text on the button, so the label gets
   * easier to read while the pointer is over it, never harder (DESIGN.md, "The Lift Rule").
   */
  accentHover: string
  /** The accent as text and links. It is lighter in the dark theme, so it reads on dark surfaces. */
  accentInk: string
  success: string
  danger: string
  /** The danger colour under the pointer, on the same rule as `accentHover`. */
  dangerHover: string
  /**
   * The text of a danger button that is filled with the danger colour (spec 000, "Danger
   * buttons"). It reads on the danger colour in both themes.
   */
  dangerText: string
  focus: string
  /** The app mark, as a small badge. The app mark does not change with the theme: it has its own dark tile. */
  markTile: string
  markEyes: string
  markGlow: string
  /**
   * The mark of the user and the mark of a channel (spec 002). They follow the theme: a dark disc
   * with a glyph of light in the dark theme, a light disc with a dark glyph in the light theme.
   */
  avatarTile: string
  avatarGlyph: string
  /** The colour of the glow of the glyph. The light theme has no glow, and this is its rim. */
  avatarGlow: string
  /** The thin rim of the disc. */
  avatarRim: string
  /** The second, fainter ring of the dark theme. */
  avatarHalo: string
}

export const palettes: Record<"dark" | "light", Palette> = {
  dark: {
    rail: "#0b0b12",
    sidebar: "#15151e",
    main: "#1e1e26",
    elevated: "#292933",
    hover: "#33333d",
    selected: "#40404c",
    border: "#454550",
    text: "#f4f4f7",
    textMuted: "#b4b5bf",
    accent: "#6a56d8",
    accentText: "#fdfdfd",
    accentHover: "#5a44c4",
    accentInk: "#b3afff",
    success: "#48deb3",
    danger: "#ff9492",
    dangerHover: "#ffaba7",
    dangerText: "#0d0c13",
    focus: "#b3afff",
    markTile: "#0a0817",
    markEyes: "#eafff8",
    markGlow: "#7affd4",
    avatarTile: "#0a0817",
    avatarGlyph: "#eafff8",
    avatarGlow: "#7affd4",
    avatarRim: "#7affd466",
    avatarHalo: "#7affd417",
  },
  light: {
    rail: "#dddde7",
    sidebar: "#ececf5",
    main: "#f5f5fc",
    elevated: "#fcfcff",
    hover: "#e7e7f1",
    selected: "#d5d5e5",
    border: "#c8c8d6",
    text: "#16161e",
    textMuted: "#565661",
    accent: "#523bb7",
    accentText: "#fdfdfd",
    accentHover: "#4427a4",
    accentInk: "#4e38ac",
    success: "#006a4c",
    danger: "#ab1a23",
    dangerHover: "#970010",
    dangerText: "#fdfdfd",
    focus: "#523bb7",
    markTile: "#0a0817",
    markEyes: "#eafff8",
    markGlow: "#7affd4",
    avatarTile: "#e1f7ef",
    avatarGlyph: "#0a3a2c",
    avatarGlow: "#17705a",
    avatarRim: "#17705a",
    avatarHalo: "transparent",
  },
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

/** CSS rules that define the colour variables for both themes. */
export const paletteCss = () =>
  Object.entries(palettes)
    .map(([theme, palette]) => {
      const vars = Object.entries(palette)
        .map(([name, value]) => `--c-${kebab(name)}: ${value};`)
        .join(" ")
      return `:root[data-theme="${theme}"] { ${vars} color-scheme: ${theme}; }`
    })
    .join("\n")
