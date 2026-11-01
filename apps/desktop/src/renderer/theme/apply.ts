import { createEffect, createSignal, onCleanup } from "solid-js"
import type { AppState } from "../state/app.tsx"
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

  createEffect(() => {
    const theme =
      app.settings.theme === "system" ? (systemDark() ? "dark" : "light") : app.settings.theme
    root.dataset.theme = theme
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
