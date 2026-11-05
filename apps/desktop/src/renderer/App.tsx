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
import { openThread } from "./chat/threads.ts"
import { DevicesSection } from "./devices/DevicesSection.tsx"
import { JoinDialog } from "./devices/JoinDialog.tsx"
import { SyncGuardDialog, SyncRequestDialog } from "./devices/SyncDialogs.tsx"
import { FirstRunDialog } from "./firstrun/FirstRun.tsx"
import { describeError, type ErrorText } from "./lib/errors.ts"
import { call } from "./lib/rpc.ts"
import { NotificationsSection } from "./notifications/NotificationsSection.tsx"
import { OrgChartPage } from "./orgchart/OrgChartPage.tsx"
import { ProvidersSection } from "./providers/ProvidersSection.tsx"
import { RoutinesView } from "./routines/RoutinesPage.tsx"
import { ConnectionsSection } from "./settings/ConnectionsSection.tsx"
import { Shell } from "./shell/Shell.tsx"
import { closeSkillForm, SkillFormDialog, skillForm } from "./skills/SkillForm.tsx"
import { SkillsSection } from "./skills/SkillsSection.tsx"
import { useAgents } from "./state/agents.tsx"
import { useApp } from "./state/app.tsx"
import { useChannels } from "./state/channels.tsx"
import { setFocusMessage } from "./state/focus.ts"
import { useUi } from "./state/ui.tsx"
import { TasksPage } from "./tasks/TasksPage.tsx"
import { TodayPage } from "./today/TodayPage.tsx"
import { ChannelMark } from "./ui/ChannelMark.tsx"
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
      // A reply in a thread opens that thread (spec 003).
      if (target.kind === "agent" && !target.serverId) openThread(target.id, target.threadId)
      ui.selectPlace({ kind: target.kind, id: target.id }, target.serverId ?? ui.localServer()?.id)
      setFocusMessage(target.messageId)
    }),
  )
  // A notice from a workflow opens the workflows page. A paused routine opens the routines
  // page. A notice of the Teams link opens Settings, Teams (spec 028).
  onCleanup(
    window.robot.on("app.openPage", ({ page, serverId }) => {
      if (serverId) ui.selectServer(serverId)
      if (page === "teams") ui.openSettings("teams")
      else ui.selectPage(page)
    }),
  )
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
          // A channel shows its picture, or the mark with the `#` (spec 004, "Picture").
          if (place.kind === "channel")
            return (
              <ChannelMark
                picture={channels.byId(place.id)?.picture}
                size={24}
                testId="channel-mark"
              />
            )
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
          // A client creates agents and channels on a server only when the server lets it (012).
          // The menus (agent files, user sections) belong to this computer: a client has none.
          !ui.canChange() ? null : section === "agents" ? (
            <>
              <Show when={!ui.linked()}>
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
              </Show>
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
              <Show when={!ui.linked()}>
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
              </Show>
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
          today: () => <TodayPage />,
          usage: () => <UsagePage />,
          tasks: () => <TasksPage />,
          // Another server is another chart: the page opens again, so it frames the new chart.
          orgchart: () => (
            <Show when={ui.server()?.id} keyed>
              {(_id) => <OrgChartPage />}
            </Show>
          ),
          routines: () => <RoutinesView />,
          workflows: () => <WorkflowsPage />,
        }}
        settingsSections={{
          archive: () => <ArchiveSection />,
          providers: () => <ProvidersSection />,
          devices: () => <DevicesSection />,
          notifications: () => <NotificationsSection />,
          connections: () => <ConnectionsSection />,
          skills: () => <SkillsSection />,
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
      <Presence when={skillForm()}>
        {(form) => <SkillFormDialog open={form} onClose={closeSkillForm} />}
      </Presence>
      <JoinDialog />
      <SyncRequestDialog />
      <SyncGuardDialog />
      <Toasts />
    </>
  )
}
