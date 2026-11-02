import { Plus } from "lucide-solid"
import { createSignal, onCleanup, Show } from "solid-js"
import { agentPlaceView } from "./agents/AgentChat.tsx"
import { NewAgentDialog } from "./agents/AgentDialogs.tsx"
import { ArchiveSection } from "./agents/ArchiveSection.tsx"
import { Face } from "./agents/Face.tsx"
import { ChannelDialog } from "./channels/ChannelDialog.tsx"
import { ChannelPanel } from "./channels/ChannelPanel.tsx"
import { ChannelHeader, ChannelView } from "./channels/ChannelView.tsx"
import { DevicesSection } from "./devices/DevicesSection.tsx"
import { JoinDialog } from "./devices/JoinDialog.tsx"
import { SyncGuardDialog, SyncRequestDialog } from "./devices/SyncDialogs.tsx"
import { FirstRunDialog } from "./firstrun/FirstRun.tsx"
import { NotificationsSection } from "./notifications/NotificationsSection.tsx"
import { ProvidersSection } from "./providers/ProvidersSection.tsx"
import { Shell } from "./shell/Shell.tsx"
import { useAgents } from "./state/agents.tsx"
import { useApp } from "./state/app.tsx"
import { useChannels } from "./state/channels.tsx"
import { setFocusMessage } from "./state/focus.ts"
import { useUi } from "./state/ui.tsx"
import { TasksPage } from "./tasks/TasksPage.tsx"
import { IconButton } from "./ui/controls.tsx"
import { Presence } from "./ui/Presence.tsx"
import { UsagePage } from "./usage/UsagePage.tsx"
import { WorkflowsPage } from "./workflows/WorkflowsPage.tsx"

export const App = () => {
  const app = useApp()
  const { t } = app
  const agents = useAgents()
  const channels = useChannels()
  const ui = useUi()
  // A click on a notification, or on the island, opens the place and shows the message.
  onCleanup(
    window.robot.on("app.openPlace", (target) => {
      ui.selectPlace({ kind: target.kind, id: target.id }, target.serverId ?? ui.localServer()?.id)
      setFocusMessage(target.messageId)
    }),
  )
  const [newChannel, setNewChannel] = createSignal(false)
  const [newAgent, setNewAgent] = createSignal(false)

  return (
    <>
      <Shell
        face={(place) => {
          const agent = agents.byId(place.id)
          return agent ? <Face face={agent.face} image={agent.faceImage} size={24} /> : null
        }}
        placeExists={(ref) =>
          ref.kind === "agent"
            ? agents.byId(ref.id) !== undefined
            : channels.byId(ref.id) !== undefined
        }
        renderPlace={(ref) => {
          if (ref.kind === "agent") return agentPlaceView(() => agents.byId(ref.id))
          const channel = () => channels.byId(ref.id)
          return {
            header: <Show when={channel()}>{(c) => <ChannelHeader channel={c()} />}</Show>,
            body: <Show when={channel()}>{(c) => <ChannelView channel={c()} />}</Show>,
            panel: <Show when={channel()}>{(c) => <ChannelPanel channel={c()} />}</Show>,
          }
        }}
        sectionAction={(section) =>
          // A client creates agents and channels on a server only when the server lets it (012).
          !ui.canChange() ? null : section === "agents" ? (
            <IconButton
              label={t("agents.new")}
              onClick={() => setNewAgent(true)}
              data-testid="new-agent"
            >
              <Plus size={16} />
            </IconButton>
          ) : (
            <IconButton
              label={t("channels.new")}
              onClick={() => setNewChannel(true)}
              data-testid="new-channel"
            >
              <Plus size={16} />
            </IconButton>
          )
        }
        pages={{
          usage: () => <UsagePage />,
          tasks: () => <TasksPage />,
          workflows: () => <WorkflowsPage />,
        }}
        settingsSections={{
          archive: () => <ArchiveSection />,
          providers: () => <ProvidersSection />,
          devices: () => <DevicesSection />,
          notifications: () => <NotificationsSection />,
        }}
      />
      <Presence when={newAgent()}>
        {() => <NewAgentDialog onClose={() => setNewAgent(false)} />}
      </Presence>
      <Presence when={newChannel()}>
        {() => <ChannelDialog onClose={() => setNewChannel(false)} />}
      </Presence>
      <Presence when={!app.settings.firstRunDone}>{() => <FirstRunDialog />}</Presence>
      <JoinDialog />
      <SyncRequestDialog />
      <SyncGuardDialog />
    </>
  )
}
