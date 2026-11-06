import "./styles/global.css"
import { render } from "solid-js/web"
import { App } from "./App.tsx"
import { AgentsProvider } from "./state/agents.tsx"
import { AppProvider, loadInitial, useApp } from "./state/app.tsx"
import { DevicesProvider } from "./state/devices.tsx"
import { ProvidersProvider } from "./state/providers.tsx"
import { startQuiet } from "./state/quiet.ts"
import { TeamsProvider } from "./state/teams.tsx"
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
  // Listen for the quiet turns (spec 005) from the start, so that a view that opens later has them.
  startQuiet()
  render(
    () => (
      <AppProvider info={initial.info} settings={initial.settings}>
        <UiProvider ui={layout.ui} servers={layout.servers}>
          <Appearance />
          <ProvidersProvider>
            <DevicesProvider>
              <AgentsProvider>
                <TeamsProvider>
                  <App />
                </TeamsProvider>
              </AgentsProvider>
            </DevicesProvider>
          </ProvidersProvider>
        </UiProvider>
      </AppProvider>
    ),
    root,
  )
}
