import "./styles/global.css"
import { render } from "solid-js/web"
import { App } from "./App.tsx"
import { AppProvider, loadInitial, useApp } from "./state/app.tsx"
import { DevicesProvider } from "./state/devices.tsx"
import { ProvidersProvider } from "./state/providers.tsx"
import { loadUi, UiProvider } from "./state/ui.tsx"
import { applyAppearance } from "./theme/apply.ts"

const Appearance = () => {
  applyAppearance(useApp())
  return null
}

const root = document.getElementById("root")
if (root) {
  const [initial, layout] = await Promise.all([loadInitial(), loadUi()])
  document.documentElement.dataset.platform = initial.info.platform
  render(
    () => (
      <AppProvider info={initial.info} settings={initial.settings}>
        <UiProvider ui={layout.ui} servers={layout.servers}>
          <Appearance />
          <ProvidersProvider>
            <DevicesProvider>
              <App />
            </DevicesProvider>
          </ProvidersProvider>
        </UiProvider>
      </AppProvider>
    ),
    root,
  )
}
