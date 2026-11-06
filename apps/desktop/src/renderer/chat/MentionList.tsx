import type { Agent } from "@robot/shared"
import { For, Show } from "solid-js"
import { Face } from "../agents/Face.tsx"
import styles from "./mentions.module.css"

/**
 * The `@` list above the message box of a direct chat (spec 003, "Mention another agent"). The box
 * keeps the focus, so the list takes no keys: the box moves the mark and picks.
 */
export const MentionList = (props: {
  label: string
  entries: readonly Agent[]
  highlight: number
  onPick: (agent: Agent) => void
}) => (
  <div class={styles.mentions} role="listbox" aria-label={props.label} data-testid="mention-list">
    <For each={props.entries}>
      {(member, index) => (
        <button
          type="button"
          role="option"
          class={styles.mention}
          aria-selected={props.highlight === index()}
          // The box keeps the focus, so a click does not end the typing.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => props.onPick(member)}
          data-testid="mention-option"
          data-member={member.name}
        >
          <Face face={member.face} image={member.faceImage} size={20} />
          <span class={styles.mentionName}>@{member.name}</span>
          <Show when={member.role}>
            <span class={styles.mentionRole}>{member.role}</span>
          </Show>
        </button>
      )}
    </For>
  </div>
)
