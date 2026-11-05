import { createSignal, For, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { useOrgs } from "../state/orgs.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { NEW_ORG, OrgDialog } from "./OrgDialog.tsx"
import styles from "./orgs.module.css"

/**
 * A plain list of the organizations with the button "New organization" (spec 030, flows 1 and 2).
 * It is a stop-gap way in: the org chart (029) opens the same form from its nodes and its button,
 * and then this list goes. A linked computer sees the list of its server. Without the switch "Can
 * create and change agents" it opens the form read only and has no button "New organization".
 */
export const OrgList = () => {
  const { t } = useApp()
  const ui = useUi()
  const orgs = useOrgs()
  // The form that is open: an id, `NEW_ORG`, or none.
  const [open, setOpen] = createSignal<string>()
  const parentName = (id: string) => {
    const parent = orgs.parentOf(id)
    return parent ? orgs.byId(parent)?.name : undefined
  }
  return (
    <section data-testid="org-list-section" aria-label={t("orgs.title")}>
      <div class={styles.listHead}>
        <h3 class={styles.label}>{t("orgs.title")}</h3>
        <Show when={ui.canChange()}>
          <Button onClick={() => setOpen(NEW_ORG)} data-testid="org-new">
            {t("orgs.new")}
          </Button>
        </Show>
      </div>
      <p class={styles.hint}>{t("orgs.hint")}</p>
      <Show
        when={orgs.orgs().length > 0}
        fallback={
          <p class={styles.hint} data-testid="org-list-empty">
            {t("orgs.empty")}
          </p>
        }
      >
        <ul class={styles.list} data-testid="org-list">
          <For each={orgs.orgs()}>
            {(org) => (
              <li>
                <button
                  type="button"
                  class={styles.listRow}
                  aria-label={t("orgs.open", { name: org.name })}
                  onClick={() => setOpen(org.id)}
                  data-testid="org-row"
                  data-name={org.name}
                >
                  <span class={styles.listName} data-user-data>
                    {org.name}
                  </span>
                  <Show when={parentName(org.id)}>
                    {(parent) => (
                      <span class={styles.hint} data-testid="org-row-parent" data-user-data>
                        {t("orgs.sub", { parent: parent() })}
                      </span>
                    )}
                  </Show>
                  <Show when={org.memberIds.length === 0}>
                    <span class={styles.hint} data-testid="org-row-empty">
                      {t("orgs.noMembers")}
                    </span>
                  </Show>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <Show when={open()}>
        {(id) => <OrgDialog id={id()} onClose={() => setOpen(undefined)} />}
      </Show>
    </section>
  )
}
