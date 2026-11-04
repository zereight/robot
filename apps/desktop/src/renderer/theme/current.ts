import { createSignal } from "solid-js"

export type Theme = "dark" | "light"

const [theme, setTheme] = createSignal<Theme>("dark")

/**
 * The theme that shows now: the choice of the user, or the theme of the system when the choice is
 * "system". A drawing that cannot read the colour variables of the document (the face of an agent
 * is drawn from the colours of its hue) reads the theme here.
 */
export const resolvedTheme = theme

/** Only `applyAppearance` sets the theme. */
export const setResolvedTheme = setTheme
