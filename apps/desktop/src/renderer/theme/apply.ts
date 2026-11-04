import { createEffect, createSignal, onCleanup } from "solid-js"
import type { AppState } from "../state/app.tsx"
import { setResolvedTheme } from "./current.ts"
import { paletteCss } from "./tokens.ts"

const fontSizes = { small: "13px", default: "14px", large: "16px" } as const

const mediaSignal = (query: string) => {
  const media = window.matchMedia(query)
  const [matches, setMatches] = createSignal(media.matches)
  const listener = () => setMatches(media.matches)
  media.addEventListener("change", listener)
  onCleanup(() => media.removeEventListener("change", listener))
  return matches
}

/** Keeps the document's theme, text size, motion and language in step with the settings. */
export const applyAppearance = (app: AppState) => {
  const style = document.createElement("style")
  style.textContent = paletteCss()
  document.head.append(style)

  const systemDark = mediaSignal("(prefers-color-scheme: dark)")
  const systemReducedMotion = mediaSignal("(prefers-reduced-motion: reduce)")
  const root = document.documentElement

  let settle = 0
  createEffect(() => {
    const theme =
      app.settings.theme === "system" ? (systemDark() ? "dark" : "light") : app.settings.theme
    if (root.dataset.theme && root.dataset.theme !== theme) {
      // A change of the theme changes every avatar at once, with no motion (spec 002). The colours
      // of an avatar have a soft change for a new hue, so the soft change is off until the new
      // theme has been drawn.
      root.dataset.themeSwitching = "true"
      cancelAnimationFrame(settle)
      settle = requestAnimationFrame(() => {
        settle = requestAnimationFrame(() => delete root.dataset.themeSwitching)
      })
    }
    root.dataset.theme = theme
    setResolvedTheme(theme)
  })
  createEffect(() => {
    const mode = app.settings.reduceMotion
    root.dataset.reduceMotion = String(mode === "system" ? systemReducedMotion() : mode === "on")
  })
  createEffect(() => {
    root.style.fontSize = fontSizes[app.settings.textSize]
  })
  createEffect(() => {
    root.lang = app.locale()
    document.title = app.t("app.name")
  })
}
