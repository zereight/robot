import { DevicesSection } from "./devices/DevicesSection.tsx"
import { JoinDialog } from "./devices/JoinDialog.tsx"
import { FirstRunDialog } from "./firstrun/FirstRun.tsx"
import { ProvidersSection } from "./providers/ProvidersSection.tsx"
import { ConnectionsSection } from "./settings/ConnectionsSection.tsx"
import { Shell } from "./shell/Shell.tsx"
import { closeSkillForm, SkillFormDialog, skillForm } from "./skills/SkillForm.tsx"
import { SkillsSection } from "./skills/SkillsSection.tsx"
import { useApp } from "./state/app.tsx"
import { Presence } from "./ui/Presence.tsx"
import { Toasts } from "./ui/Toasts.tsx"

export const App = () => {
  const app = useApp()
  return (
    <>
      <Shell
        settingsSections={{
          providers: () => <ProvidersSection />,
          devices: () => <DevicesSection />,
          connections: () => <ConnectionsSection />,
          skills: () => <SkillsSection />,
        }}
      />
      <Presence when={!app.settings.firstRunDone}>{() => <FirstRunDialog />}</Presence>
      <Presence when={skillForm()}>
        {(form) => <SkillFormDialog open={form} onClose={closeSkillForm} />}
      </Presence>
      <JoinDialog />
      <Toasts />
    </>
  )
}
