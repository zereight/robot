import {
  type TeamsTargetKind,
  teamsLinksTo,
  teamsMarkShows,
  teamsStateWordKey,
} from "@robot/shared"
import { Link2 } from "lucide-solid"
import { Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { useTeams } from "../state/teams.tsx"
import { useUi } from "../state/ui.tsx"
import styles from "./teams.module.css"

/**
 * The muted mark "Linked to Teams" in the header of the agent that the Teams link
 * serves (spec 028). It names the state when the state is not On. A click opens Settings, Teams.
 * Only the computer that holds the link shows it: a linked device sees no mark here.
 */
export const TeamsMark = (props: { kind: TeamsTargetKind; id: string }) => {
  const { t } = useApp()
  const ui = useUi()
  const teams = useTeams()
  const word = () => {
    const key = teamsStateWordKey(teams.view().state)
    return key ? t(key) : null
  }
  return (
    <Show
      when={
        !ui.linked() &&
        teamsMarkShows(teams.view()) &&
        teamsLinksTo(teams.view(), props.kind, props.id)
      }
    >
      <button
        type="button"
        class={styles.mark}
        aria-label={`${word() ? t("teams.mark.state", { state: word() as string }) : t("teams.mark")}. ${t("teams.mark.open")}`}
        title={t("teams.mark.open")}
        data-attention={word() !== null}
        data-state={teams.view().state}
        onClick={() => ui.openSettings("teams")}
        data-testid="teams-mark"
      >
        <Link2 size={12} aria-hidden="true" />
        <span>{t("teams.mark")}</span>
        <Show when={word()}>{(w) => <span data-testid="teams-mark-state">· {w()}</span>}</Show>
      </button>
    </Show>
  )
}
