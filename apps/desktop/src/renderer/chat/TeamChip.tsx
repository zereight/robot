import type { Agent, Org } from "@robot/shared"
import { ChevronDown } from "lucide-solid"
import { createResource, createSignal, For, Show } from "solid-js"
import agentStyles from "../agents/agents.module.css"
import { call } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { setOrgChartTarget } from "../state/orgChartTarget.ts"
import { useOrgs } from "../state/orgs.tsx"
import { useUi } from "../state/ui.tsx"
import { type MenuItem, PopupMenu } from "../ui/Menu.tsx"

/** One chip for one organization that the agent leads (spec 003, "Team chip"). */
const OrgChip = (props: { org: Org }) => {
  const { t } = useApp()
  const ui = useUi()
  const orgs = useOrgs()
  const agents = useAgents()
  const [position, setPosition] = createSignal<{ top: number; left: number }>()
  let trigger: HTMLButtonElement | undefined
  // An archived member stays a member. The list reads them when it opens, and again on a change.
  const [archived] = createResource(
    () => (position() ? ui.server()?.id : undefined),
    (serverId) => call("agents.list", { serverId, archived: true }).catch((): Agent[] => []),
  )
  const nameOf = (id: string) =>
    agents.byId(id)?.name ?? archived()?.find((a) => a.id === id)?.name ?? ""
  const items = (): MenuItem[] => {
    const org = orgs.byId(props.org.id) ?? props.org
    const parent = orgs.byId(orgs.parentOf(org.id) ?? "")
    const lead = org.leadId
    const members = [...org.memberIds].sort((a, b) =>
      a === lead
        ? -1
        : b === lead
          ? 1
          : nameOf(a).localeCompare(nameOf(b), undefined, { sensitivity: "base" }),
    )
    const list: MenuItem[] = []
    if (parent)
      list.push({
        label: t("chat.team.parent", { name: parent.name }),
        onSelect: () => {},
        heading: true,
        testId: "team-parent",
      })
    for (const id of members) {
      const active = agents.byId(id) !== undefined
      const name = nameOf(id)
      list.push({
        label: id === lead ? `${name} · ${t("chat.team.lead")}` : name,
        onSelect: () => ui.selectPlace({ kind: "agent", id }),
        disabled: !active,
        ...(active ? {} : { reason: t("chat.team.archived") }),
        testId: "team-member",
      })
    }
    list.push({
      label: t("chat.team.chart"),
      onSelect: () => {
        setOrgChartTarget(org.id)
        ui.selectPage("orgchart")
      },
      testId: "team-chart",
    })
    return list
  }
  const toggle = () => {
    if (position()) return setPosition(undefined)
    const box = trigger?.getBoundingClientRect()
    if (box) setPosition({ top: box.bottom + 4, left: box.left })
  }
  const count = () => (orgs.byId(props.org.id) ?? props.org).memberIds.length
  const label = () =>
    t("chat.team.chip", { name: (orgs.byId(props.org.id) ?? props.org).name, count: count() })
  return (
    <>
      <button
        ref={trigger}
        type="button"
        class={`${agentStyles.headerModel} ${agentStyles.threadButton}`}
        aria-haspopup="menu"
        aria-expanded={position() !== undefined}
        aria-label={t("chat.team.open", { name: props.org.name })}
        title={label()}
        onClick={toggle}
        data-testid="team-chip"
        data-user-data
      >
        <span class={agentStyles.threadTitle}>{label()}</span>
        <ChevronDown size={12} />
      </button>
      <Show when={position()}>
        {(at) => (
          <PopupMenu
            items={items()}
            top={at().top}
            left={at().left}
            label={t("chat.team.title", { name: props.org.name })}
            testId="team-menu"
            onClose={(refocus) => {
              setPosition(undefined)
              if (refocus) trigger?.focus()
            }}
          />
        )}
      </Show>
    </>
  )
}

/** The chips of the organizations that an agent leads. An agent that leads none shows nothing. */
export const TeamChip = (props: { agentId: string }) => {
  const orgs = useOrgs()
  const led = () => orgs.orgs().filter((o) => o.leadId === props.agentId)
  return <For each={led()}>{(org) => <OrgChip org={org} />}</For>
}
