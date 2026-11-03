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
  success: string
  danger: string
  focus: string
  /** The app mark, as a small badge. The same in both themes: the badge has its own dark tile. */
  markTile: string
  markEyes: string
  markGlow: string
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
    success: "#3bb27a",
    danger: "#e8625a",
    focus: "#8ea0ff",
    markTile: "#0a0817",
    markEyes: "#eafff8",
    markGlow: "#7affd4",
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
    success: "#1d8a57",
    danger: "#c43c34",
    focus: "#3953c8",
    markTile: "#0a0817",
    markEyes: "#eafff8",
    markGlow: "#7affd4",
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
