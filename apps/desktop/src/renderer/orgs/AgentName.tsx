import { Show } from "solid-js"
import { useOrgs } from "../state/orgs.tsx"
import styles from "./prefix.module.css"

/**
 * The name of an agent as a label (spec 035): the organization prefix "[Docs]" in front of the
 * stored name. The prefix is muted and has a note with the whole name of the organization. A screen
 * reader reads "<name>, <whole organization name>" (the span is one image with that name, so the
 * text is not read twice and a copy of the text holds the shown name only). An agent in no
 * organization, and the switch off, show the name alone. The label draws from the agent as it is
 * now, so it changes at once.
 */
export const AgentName = (props: { id: string; name: string }) => {
  const orgs = useOrgs()
  const shown = () => orgs.shown(props.id, props.name)
  return (
    <Show when={shown().prefix} fallback={props.name}>
      {(prefix) => (
        <span role="img" aria-label={shown().label} data-org-name>
          <span
            class={styles.prefix}
            title={shown().organization ?? undefined}
            data-testid="org-prefix"
          >
            {prefix()}
          </span>{" "}
          {props.name}
        </span>
      )}
    </Show>
  )
}
