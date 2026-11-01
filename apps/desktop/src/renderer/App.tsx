import { Plus } from "lucide-solid"
import { createSignal, Show } from "solid-js"
import { agentPlaceView } from "./agents/AgentChat.tsx"
import { NewAgentDialog } from "./agents/AgentDialogs.tsx"
import { ArchiveSection } from "./agents/ArchiveSection.tsx"
import { Face } from "./agents/Face.tsx"
import { Shell } from "./shell/Shell.tsx"
import { useAgents } from "./state/agents.tsx"
import { useApp } from "./state/app.tsx"
import { IconButton } from "./ui/controls.tsx"

export const App = () => {
  const { t } = useApp()
  const agents = useAgents()
  const [newAgent, setNewAgent] = createSignal(false)

  return (
    <>
      <Shell
        face={(place) => {
          const agent = agents.byId(place.id)
          return agent ? <Face face={agent.face} image={agent.faceImage} size={24} /> : null
        }}
        placeExists={(ref) => ref.kind === "agent" && agents.byId(ref.id) !== undefined}
        renderPlace={(ref) => agentPlaceView(() => agents.byId(ref.id))}
        sectionAction={(section) =>
          section === "agents" ? (
            <IconButton
              label={t("agents.new")}
              onClick={() => setNewAgent(true)}
              data-testid="new-agent"
            >
              <Plus size={16} />
            </IconButton>
          ) : null
        }
        settingsSections={{ archive: () => <ArchiveSection /> }}
      />
      <Show when={newAgent()}>
        <NewAgentDialog onClose={() => setNewAgent(false)} />
      </Show>
    </>
  )
}
