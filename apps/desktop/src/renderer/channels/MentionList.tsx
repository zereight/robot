import type { Agent, MentionEntry } from "@robot/shared"
import { Users } from "lucide-solid"
import { For, Show } from "solid-js"
import { Face } from "../agents/Face.tsx"
import { AgentName } from "../orgs/AgentName.tsx"
import { useApp } from "../state/app.tsx"
import { useOrgs } from "../state/orgs.tsx"
import styles from "./channels.module.css"

/**
 * The `@` list above the message box of a channel (spec 004, "Mention"). The box keeps the focus,
 * so the list takes no keys: the box moves the mark and picks.
 */
export const MentionList = (props: {
  label: string
  entries: readonly MentionEntry<Agent>[]
  highlight: number
  onPick: (entry: MentionEntry<Agent>) => void
}) => {
  const { t } = useApp()
  const orgs = useOrgs()
  return (
    <div class={styles.mentions} role="listbox" aria-label={props.label} data-testid="mention-list">
      <For each={props.entries}>
        {(entry, index) => (
          <button
            type="button"
            role="option"
            class={styles.mention}
            aria-selected={props.highlight === index()}
            // The box keeps the focus, so a click does not end the typing.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => props.onPick(entry)}
            data-testid="mention-option"
            data-member={entry.kind === "all" ? "@all" : entry.member.name}
          >
            {entry.kind === "all" ? (
              <>
                <span class={styles.mentionAllIcon} aria-hidden="true">
                  <Users size={12} />
                </span>
                <span class={styles.mentionName}>@all</span>
                <span class={styles.mentionRole}>{t("channels.mentionAll")}</span>
              </>
            ) : (
              <>
                <Face face={entry.member.face} image={entry.member.faceImage} size={20} />
                {/* With a prefix the line shows "[Docs] Ada"; the pick still puts "@Ada" in the box
                    (spec 035, "Mention"). Without one it shows "@Ada" as before. */}
                <span class={styles.mentionName}>
                  <Show when={orgs.prefixOrg(entry.member.id)} fallback={<>@{entry.member.name}</>}>
                    <AgentName id={entry.member.id} name={entry.member.name} />
                  </Show>
                </span>
                <Show when={entry.member.role}>
                  <span class={styles.mentionRole}>{entry.member.role}</span>
                </Show>
              </>
            )}
          </button>
        )}
      </For>
    </div>
  )
}
