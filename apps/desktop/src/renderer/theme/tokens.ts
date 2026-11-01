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
}

export const palettes: Record<"dark" | "light", Palette> = {
  dark: {
    rail: "#141519",
    sidebar: "#1a1b20",
    main: "#202127",
    elevated: "#272830",
    hover: "#2b2d35",
    selected: "#33353f",
    border: "#30323b",
    text: "#e9eaee",
    textMuted: "#a4a7b1",
    accent: "#4f66d9",
    accentText: "#ffffff",
    success: "#3bb27a",
    danger: "#e8625a",
    focus: "#8ea0ff",
  },
  light: {
    rail: "#e7e8ec",
    sidebar: "#f1f2f5",
    main: "#ffffff",
    elevated: "#ffffff",
    hover: "#e8e9ed",
    selected: "#dfe1e6",
    border: "#d8dae0",
    text: "#1b1d23",
    textMuted: "#575b66",
    accent: "#3953c8",
    accentText: "#ffffff",
    success: "#1d8a57",
    danger: "#c43c34",
    focus: "#3953c8",
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
