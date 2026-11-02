import type { AgentFilePreview } from "@robot/shared"
import { Ellipsis, Plus } from "lucide-solid"
import { createSignal, onCleanup, Show } from "solid-js"
import { agentPlaceView } from "./agents/AgentChat.tsx"
import { NewAgentDialog } from "./agents/AgentDialogs.tsx"
import {
  AgentFileProblemDialog,
  ExportAgentsDialog,
  ImportAgentsDialog,
} from "./agents/AgentFileDialogs.tsx"
import { ArchiveSection } from "./agents/ArchiveSection.tsx"
import { Face } from "./agents/Face.tsx"
import { watchReactions } from "./agents/reactions.ts"
import { ChannelDialog } from "./channels/ChannelDialog.tsx"
import { ChannelPanel } from "./channels/ChannelPanel.tsx"
import { ChannelHeader, ChannelView } from "./channels/ChannelView.tsx"
import { FirstRunDialog } from "./firstrun/FirstRun.tsx"
import { describeError, type ErrorText } from "./lib/errors.ts"
import { call } from "./lib/rpc.ts"
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
import { Menu } from "./ui/Menu.tsx"
import { Presence } from "./ui/Presence.tsx"
import { Toasts } from "./ui/Toasts.tsx"
import { UsagePage } from "./usage/UsagePage.tsx"
import { WorkflowsPage } from "./workflows/WorkflowsPage.tsx"

export const App = () => {
  const app = useApp()
  const { t } = app
  const agents = useAgents()
  const channels = useChannels()
  const ui = useUi()
  onCleanup(watchReactions())
  // A click on a notification, or on the island, opens the place and shows the message.
  onCleanup(
    window.robot.on("app.openPlace", (target) => {
      ui.selectPlace({ kind: target.kind, id: target.id })
      setFocusMessage(target.messageId)
    }),
  )
  // A notice from a workflow opens the page of workflows.
  onCleanup(window.robot.on("app.openPage", ({ page }) => ui.selectPage(page)))
  const [newChannel, setNewChannel] = createSignal(false)
  const [newAgent, setNewAgent] = createSignal(false)
  const [exportAgents, setExportAgents] = createSignal(false)
  const [importPreview, setImportPreview] = createSignal<AgentFilePreview>()
  const [fileProblem, setFileProblem] = createSignal<ErrorText>()

  /** Asks for an agent file. A readable file opens the dialog that lists its agents. */
  const startImport = async () => {
    const serverId = ui.server()?.id
    if (!serverId) return
    try {
      const found = await call("agentFile.open", { serverId })
      if (found) setImportPreview(found)
    } catch (e) {
      setFileProblem(describeError(e))
    }
  }

  return (
    <>
      <Shell
        face={(place) => {
          const agent = agents.byId(place.id)
          return agent ? (
            <Face face={agent.face} image={agent.faceImage} size={24} agentId={agent.id} />
          ) : null
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
          section === "agents" ? (
            <>
              <Menu
                label={t("places.menu.agents")}
                icon={<Ellipsis size={16} />}
                testId="agents-menu"
                items={[
                  {
                    label: t("agentFile.menu.export"),
                    onSelect: () => setExportAgents(true),
                    testId: "agents-menu-export",
                  },
                  {
                    label: t("agentFile.menu.importFile"),
                    onSelect: () => void startImport(),
                    testId: "agents-menu-import-file",
                  },
                  {
                    label: t("sections.new"),
                    onSelect: () => ui.startNewSection("agent"),
                    testId: "agents-menu-new-section",
                  },
                ]}
              />
              <IconButton
                label={t("agents.new")}
                onClick={() => setNewAgent(true)}
                data-testid="new-agent"
              >
                <Plus size={16} />
              </IconButton>
            </>
          ) : (
            <>
              <Menu
                label={t("places.menu.channels")}
                icon={<Ellipsis size={16} />}
                testId="channels-menu"
                items={[
                  {
                    label: t("sections.new"),
                    onSelect: () => ui.startNewSection("channel"),
                    testId: "channels-menu-new-section",
                  },
                ]}
              />
              <IconButton
                label={t("channels.new")}
                onClick={() => setNewChannel(true)}
                data-testid="new-channel"
              >
                <Plus size={16} />
              </IconButton>
            </>
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
          notifications: () => <NotificationsSection />,
        }}
      />
      <Presence when={newAgent()}>
        {() => <NewAgentDialog onClose={() => setNewAgent(false)} />}
      </Presence>
      <Presence when={exportAgents()}>
        {() => <ExportAgentsDialog onClose={() => setExportAgents(false)} />}
      </Presence>
      <Presence when={importPreview()}>
        {(preview) => (
          <ImportAgentsDialog preview={preview} onClose={() => setImportPreview(undefined)} />
        )}
      </Presence>
      <Presence when={fileProblem()}>
        {(problem) => (
          <AgentFileProblemDialog problem={problem} onClose={() => setFileProblem(undefined)} />
        )}
      </Presence>
      <Presence when={newChannel()}>
        {() => <ChannelDialog onClose={() => setNewChannel(false)} />}
      </Presence>
      <Presence when={!app.settings.firstRunDone}>{() => <FirstRunDialog />}</Presence>
      <Toasts />
    </>
  )
}
