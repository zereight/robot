import "./styles/global.css"
import { render } from "solid-js/web"
import { App } from "./App.tsx"
import { AppProvider, loadInitial, useApp } from "./state/app.tsx"
import { applyAppearance } from "./theme/apply.ts"

const Appearance = () => {
  applyAppearance(useApp())
  return null
}

const root = document.getElementById("root")
if (root) {
  const initial = await loadInitial()
  render(
    () => (
      <AppProvider info={initial.info} settings={initial.settings}>
        <Appearance />
        <App />
      </AppProvider>
    ),
    root,
  )
}
