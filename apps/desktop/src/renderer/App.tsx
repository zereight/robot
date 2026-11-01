import { createSignal, Show } from "solid-js"
import { SettingsPage } from "./settings/SettingsPage.tsx"
import { useApp } from "./state/app.tsx"
import { Button } from "./ui/controls.tsx"

export const App = () => {
  const { t } = useApp()
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  return (
    <main data-testid="app-root" style={{ padding: "48px 40px" }}>
      <h1>{t("home.title")}</h1>
      <p>{t("home.body")}</p>
      <Button data-testid="open-settings" onClick={() => setSettingsOpen(true)}>
        {t("home.openSettings")}
      </Button>
      <Show when={settingsOpen()}>
        <SettingsPage onClose={() => setSettingsOpen(false)} />
      </Show>
    </main>
  )
}
