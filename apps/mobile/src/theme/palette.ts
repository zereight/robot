/** Colour tokens of the phone. The same names and values as the desktop, so both look alike. */
export interface Palette {
  readonly background: string
  readonly surface: string
  readonly elevated: string
  readonly pressed: string
  readonly selected: string
  readonly border: string
  readonly text: string
  readonly textMuted: string
  readonly accent: string
  readonly accentText: string
  readonly success: string
  readonly danger: string
  readonly focus: string
  /** Text on top of an agent face. */
  readonly ink: string
}

export const palettes: Record<"dark" | "light", Palette> = {
  dark: {
    background: "#19191b",
    surface: "#151516",
    elevated: "#202023",
    pressed: "#252528",
    selected: "#2e2e32",
    border: "#2c2c30",
    text: "#ededee",
    textMuted: "#a1a1a6",
    accent: "#4f66d9",
    accentText: "#ffffff",
    success: "#3bb27a",
    danger: "#e8625a",
    focus: "#8ea0ff",
    ink: "#1b1d23",
  },
  light: {
    background: "#ffffff",
    surface: "#f3f3f4",
    elevated: "#ffffff",
    pressed: "#ebebed",
    selected: "#e1e1e4",
    border: "#dcdce0",
    text: "#171717",
    textMuted: "#56565c",
    accent: "#3953c8",
    accentText: "#ffffff",
    success: "#1d8a57",
    danger: "#c43c34",
    focus: "#3953c8",
    ink: "#1b1d23",
  },
}

/**
 * The colours of the app mark and of the marks that belong to its family (the face of an agent,
 * the mark of the user, the mark of a channel). The same in both themes: the mark has its own
 * dark tile. The same values as the desktop.
 */
export const mark = { tile: "#0a0817", eyes: "#eafff8", glow: "#7affd4" } as const

export const space = { xs: 4, s: 8, m: 12, l: 16, xl: 24 } as const
export const radius = { s: 4, m: 8, l: 12, round: 999 } as const
export const text = { xs: 12, s: 14, m: 16, l: 18, xl: 22 } as const

/** The relative luminance of a hex colour (WCAG 2). */
const luminance = (hex: string) => {
  const value = Number.parseInt(hex.slice(1), 16)
  const channel = (shift: number) => {
    const c = ((value >> shift) & 255) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
}

/** The contrast ratio of two hex colours (WCAG 2). */
export const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
