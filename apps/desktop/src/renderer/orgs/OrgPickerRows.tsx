import type { OrgToolChoice, OrgToolValue } from "@robot/shared"
import { For } from "solid-js"
import { useApp } from "../state/app.tsx"
import { useOrgs } from "../state/orgs.tsx"
import { Segmented } from "../ui/controls.tsx"
import styles from "./orgs.module.css"

/**
 * The organizations in the picker of a skill or a connection (spec 017, 018, 030 "Tools"): each row
 * has the mark "organization" and the three values "Inherit", "On" and "Off". A row that is not in
 * `values` shows "Inherit". The rows are list items: put them inside a list.
 */
export const OrgPickerRows = (props: {
  /** The test ids: `skill-org`, `connection-org`, and so on. */
  prefix: "skill" | "connection"
  values: ReadonlyMap<string, OrgToolValue>
  onChange: (orgId: string, choice: OrgToolChoice) => void
}) => {
  const { t } = useApp()
  const orgs = useOrgs()
  return (
    <For each={orgs.orgs()}>
      {(org) => (
        <li class={styles.pickRow} data-testid={`${props.prefix}-org`} data-org={org.name}>
          <span class={styles.pickName}>{org.name}</span>
          <span class={styles.pickMark} data-testid={`${props.prefix}-org-mark`}>
            {t("tools.orgMark")}
          </span>
          <Segmented
            label={org.name}
            testId={`${props.prefix}-org-value`}
            value={props.values.get(org.id) ?? "inherit"}
            onChange={(choice) => props.onChange(org.id, choice)}
            options={[
              { value: "inherit", label: t("orgs.tools.inherit") },
              { value: "on", label: t("orgs.tools.on") },
              { value: "off", label: t("orgs.tools.off") },
            ]}
          />
        </li>
      )}
    </For>
  )
}
