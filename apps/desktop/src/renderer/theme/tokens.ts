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
  /** The accent as text and links. It is lighter in the dark theme, so it reads on dark surfaces. */
  accentInk: string
  success: string
  danger: string
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
    rail: "#0f0f10",
    sidebar: "#151516",
    main: "#19191b",
    elevated: "#202023",
    hover: "#252528",
    selected: "#2e2e32",
    border: "#2c2c30",
    text: "#ededee",
    textMuted: "#a1a1a6",
    accent: "#4f66d9",
    accentText: "#ffffff",
    accentInk: "#8ea0ff",
    success: "#3bb27a",
    danger: "#ea7069",
    focus: "#8ea0ff",
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
    rail: "#e9e9eb",
    sidebar: "#f3f3f4",
    main: "#ffffff",
    elevated: "#ffffff",
    hover: "#ebebed",
    selected: "#e1e1e4",
    border: "#dcdce0",
    text: "#171717",
    textMuted: "#56565c",
    accent: "#3953c8",
    accentText: "#ffffff",
    accentInk: "#3953c8",
    success: "#187147",
    danger: "#b43730",
    focus: "#3953c8",
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
