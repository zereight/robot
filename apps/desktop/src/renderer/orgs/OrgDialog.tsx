import {
  type Agent,
  charLength,
  filterAgents,
  ORG_NAME_MAX,
  type OrgCreate,
  orgDeleteLowerCount,
  orgParentOptions,
  orgPatchOf,
} from "@robot/shared"
import { createMemo, createResource, createSignal, For, Show, untrack } from "solid-js"
import { Face } from "../agents/Face.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useOrgs } from "../state/orgs.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { OrgToolsPart } from "./OrgTools.tsx"
import styles from "./orgs.module.css"

/** The value of `id` that opens the form of a new organization. */
export const NEW_ORG = "new"

/** A member of the form: an agent, active or archived. */
interface MemberChoice {
  readonly agent: Agent
  readonly archived: boolean
}

/**
 * The form of an organization (spec 030, "Flows" 1, 2 and 4). `id` is the id of an organization
 * that exists, or `NEW_ORG`. It depends on no page: the list in the settings, the profile of an
 * agent and the org chart (029) open it the same way.
 *
 * A linked computer (spec 012) reads the organizations over the link. With the switch "Can create
 * and change agents" it makes, edits and deletes them; without it the form is read only. The part
 * "Tools" is read only on every linked computer: skills and connections belong to the computer
 * that holds them.
 */
export const OrgDialog = (props: { id: string; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const orgs = useOrgs()
  // The organization as it was when the form opened. The form keeps what the user typed when a
  // sync changes the organization behind it.
  const org = untrack(() => (props.id === NEW_ORG ? undefined : orgs.byId(props.id)))
  const isNew = props.id === NEW_ORG
  const storedLead =
    org && org.leadId !== null && org.memberIds.includes(org.leadId) ? org.leadId : null
  const was = {
    name: org?.name ?? "",
    memberIds: org?.memberIds ?? [],
    leadId: storedLead,
    parentId: org ? untrack(() => orgs.parentOf(org.id)) : null,
  }

  const [name, setName] = createSignal(was.name)
  const [members, setMembers] = createSignal<string[]>([...was.memberIds])
  const [leadId, setLeadId] = createSignal<string | null>(was.leadId)
  const [parentId, setParentId] = createSignal<string | null>(was.parentId)
  const [query, setQuery] = createSignal("")
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)

  const readOnly = () => !ui.canChange()

  // An archived agent stays a member (spec 030). The form lists it, marked, so the user can remove
  // it. Only the archived agents that are members are offered.
  const [archived] = createResource(
    () => (was.memberIds.length > 0 ? ui.server()?.id : undefined),
    (serverId) =>
      call("agents.list", { serverId, archived: true })
        .then((list) => list.filter((a) => was.memberIds.includes(a.id)))
        .catch((): Agent[] => []),
  )
  const choices = createMemo<MemberChoice[]>(() => [
    ...agents.agents().map((agent) => ({ agent, archived: false })),
    ...(archived() ?? [])
      .filter((a) => !agents.agents().some((x) => x.id === a.id))
      .map((agent) => ({ agent, archived: true })),
  ])
  // Members that the search hides stay chosen: the choice lives in `members`, not in the list.
  const shown = createMemo(() => {
    const matches = new Set(
      filterAgents(
        choices().map((c) => c.agent),
        query(),
      ).map((a) => a.id),
    )
    return choices().filter((c) => matches.has(c.agent.id))
  })
  const toggle = (agentId: string) => {
    const on = members().includes(agentId)
    setMembers(on ? members().filter((m) => m !== agentId) : [...members(), agentId])
    // A member that is removed is no longer the lead (spec 030).
    if (on && leadId() === agentId) setLeadId(null)
  }
  const memberName = (c: MemberChoice) =>
    c.archived ? t("orgs.members.archived", { name: c.agent.name }) : c.agent.name

  // The parent choices: the other organizations, muted with the reason when the tree refuses them.
  const parents = createMemo(() => orgParentOptions(orgs.orgs(), org?.id ?? NEW_ORG))
  const reasonKey = (refusal: "loop" | "levels") =>
    refusal === "loop" ? "orgs.parent.loop" : "orgs.parent.levels"

  const valid = () => {
    const length = charLength(name().trim())
    return length >= 1 && length <= ORG_NAME_MAX
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (readOnly() || !valid() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      if (org) {
        const patch = orgPatchOf(was, {
          name: name(),
          memberIds: members(),
          leadId: leadId(),
          parentId: parentId(),
        })
        // Nothing changed: nothing to send.
        if (Object.keys(patch).length > 0) await call("organizations.update", { id: org.id, patch })
      } else {
        const serverId = ui.server()?.id
        if (!serverId) return
        const input: OrgCreate = {
          serverId,
          name: name().trim(),
          memberIds: members(),
          leadId: leadId() !== null && members().includes(leadId() as string) ? leadId() : null,
          ...(parentId() ? { parentId: parentId() } : {}),
        }
        await call("organizations.create", input)
      }
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!org || readOnly()) return
    try {
      await call("organizations.delete", { id: org.id })
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    }
  }

  const lower = () => (org ? orgDeleteLowerCount(orgs.orgs(), org.id) : 0)
  let backButton: HTMLButtonElement | undefined
  const title = () => (isNew ? t("orgs.create.title") : t("orgs.edit.title"))

  // The organization was deleted (here, by sync, or on the server) while the form was closed or
  // before it opened.
  if (!isNew && !org)
    return (
      <Dialog label={t("orgs.edit.title")} onClose={props.onClose} testId="org-dialog">
        <div class={styles.form}>
          <h2 class={styles.title}>{t("orgs.edit.title")}</h2>
          <div class={styles.error} role="alert" data-testid="org-gone">
            {t("error.org_not_found")}
          </div>
          <div class={styles.actions}>
            <span class={styles.spacer} />
            <Button onClick={props.onClose} data-testid="org-close">
              {t("agents.close")}
            </Button>
          </div>
        </div>
      </Dialog>
    )

  return (
    <Dialog label={title()} onClose={props.onClose} testId="org-dialog">
      <form class={styles.form} onSubmit={submit} data-testid="org-form">
        <h2 class={styles.title}>{title()}</h2>
        <Show when={ui.linked() && readOnly()}>
          <p class={styles.hint} data-testid="org-readonly">
            {ui.serverOffline()
              ? t("orgs.offline", { name: ui.server()?.name ?? "" })
              : t("orgs.readonly", { name: ui.server()?.name ?? "" })}
          </p>
        </Show>
        <label class={styles.field}>
          <span class={styles.label}>{t("orgs.name")}</span>
          <input
            class={styles.input}
            value={name()}
            maxLength={ORG_NAME_MAX}
            readOnly={readOnly()}
            aria-invalid={!valid()}
            onInput={(e) => setName(e.currentTarget.value)}
            data-testid="org-name"
          />
        </label>
        <fieldset class={styles.field}>
          <legend class={styles.label}>{t("orgs.members")}</legend>
          <Show
            when={choices().length > 0}
            fallback={<p class={styles.hint}>{t("orgs.members.none")}</p>}
          >
            <Show when={!readOnly()}>
              <input
                class={`${styles.input} ${styles.memberSearch}`}
                type="search"
                value={query()}
                placeholder={t("orgs.members.search")}
                aria-label={t("orgs.members.search")}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  // Enter in the field must not send the form.
                  if (e.key === "Enter") e.preventDefault()
                }}
                data-testid="org-member-search"
              />
            </Show>
            <div class={styles.memberBox} data-testid="org-member-box">
              {/* Rows of the same shape as the real ones, so the box is as high as the whole list. */}
              <div class={styles.memberSizer} aria-hidden="true">
                <For each={choices()}>
                  {() => (
                    <div class={styles.member}>
                      <input type="checkbox" tabindex={-1} disabled />
                      <span class={styles.memberName}>&nbsp;</span>
                    </div>
                  )}
                </For>
              </div>
              <div class={styles.memberList}>
                <Show
                  when={shown().length > 0}
                  fallback={
                    <p class={styles.hint} data-testid="org-member-nomatch">
                      {t("orgs.members.noMatch")}
                    </p>
                  }
                >
                  <For each={shown()}>
                    {(choice) => (
                      <label class={styles.member}>
                        <input
                          type="checkbox"
                          checked={members().includes(choice.agent.id)}
                          disabled={readOnly()}
                          onChange={() => toggle(choice.agent.id)}
                          data-testid={`org-member-${choice.agent.name}`}
                        />
                        <Face face={choice.agent.face} image={choice.agent.faceImage} size={20} />
                        <span class={styles.memberName}>{memberName(choice)}</span>
                        <Show when={choice.agent.role}>
                          <span class={styles.memberRole}>{choice.agent.role}</span>
                        </Show>
                      </label>
                    )}
                  </For>
                </Show>
              </div>
            </div>
            <span
              class={`${styles.hint} ${styles.memberCount}`}
              aria-live="polite"
              data-testid="org-member-count"
            >
              <Show when={members().length > 0}>
                {t("orgs.members.selected", { count: members().length })}
              </Show>
            </span>
          </Show>
        </fieldset>
        <label class={styles.field}>
          <span class={styles.label}>{t("orgs.lead")}</span>
          <select
            class={styles.input}
            disabled={readOnly()}
            onChange={(e) => setLeadId(e.currentTarget.value || null)}
            data-testid="org-lead"
          >
            <option value="" selected={leadId() === null}>
              {t("orgs.lead.none")}
            </option>
            <For each={choices().filter((c) => members().includes(c.agent.id))}>
              {(c) => (
                <option value={c.agent.id} selected={leadId() === c.agent.id}>
                  {memberName(c)}
                </option>
              )}
            </For>
          </select>
          <span class={styles.hint}>{t("orgs.lead.hint")}</span>
        </label>
        <label class={styles.field}>
          <span class={styles.label}>{t("orgs.parent")}</span>
          <select
            class={styles.input}
            disabled={readOnly()}
            onChange={(e) => setParentId(e.currentTarget.value || null)}
            data-testid="org-parent"
          >
            <option value="" selected={parentId() === null}>
              {t("orgs.parent.none")}
            </option>
            <For each={parents()}>
              {(choice) => (
                <option
                  value={choice.id}
                  selected={parentId() === choice.id}
                  disabled={choice.refusal !== undefined && parentId() !== choice.id}
                  data-refusal={choice.refusal ?? ""}
                >
                  {choice.refusal
                    ? t("orgs.parent.option", {
                        name: choice.name,
                        reason: t(reasonKey(choice.refusal)),
                      })
                    : choice.name}
                </option>
              )}
            </For>
          </select>
          <span class={styles.hint}>{t("orgs.parent.hint")}</span>
        </label>
        <fieldset class={styles.field} data-testid="org-access">
          <legend class={styles.label}>{t("orgs.access")}</legend>
          <Show
            when={org}
            fallback={
              <span class={styles.hint} data-testid="org-access-new">
                {t("orgs.access.new")}
              </span>
            }
          >
            {(o) => <OrgToolsPart orgId={o().id} />}
          </Show>
        </fieldset>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="org-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <div class={styles.actions}>
          <Show when={org && !readOnly()}>
            <Show
              when={confirmDelete()}
              fallback={
                <Button
                  onClick={() => {
                    setConfirmDelete(true)
                    // The confirm opens with the focus on "Back", the safe choice.
                    queueMicrotask(() => backButton?.focus())
                  }}
                  data-testid="org-delete"
                >
                  {t("orgs.delete")}
                </Button>
              }
            >
              <fieldset
                class={styles.confirm}
                data-owns-escape
                data-testid="org-delete-confirm"
                onKeyDown={(e) => {
                  // Escape goes back from the confirm, and does not close the form.
                  if (e.key === "Escape") {
                    e.stopPropagation()
                    setConfirmDelete(false)
                  }
                }}
              >
                <legend class={styles.confirmTitle}>
                  {t("orgs.delete.title", { name: org?.name ?? "" })}
                </legend>
                <Show when={lower() > 0}>
                  <p data-testid="org-delete-lower">
                    {t(lower() === 1 ? "orgs.delete.lower.one" : "orgs.delete.lower.other", {
                      count: lower(),
                    })}
                  </p>
                </Show>
                <p class={styles.hint}>{t("orgs.delete.confirm")}</p>
                <div class={styles.actions}>
                  <Button
                    ref={backButton}
                    onClick={() => setConfirmDelete(false)}
                    data-testid="org-delete-back"
                  >
                    {t("orgs.delete.back")}
                  </Button>
                  <Button onClick={remove} data-testid="org-delete-go">
                    {t("orgs.delete.go")}
                  </Button>
                </div>
              </fieldset>
            </Show>
          </Show>
          <Show when={!confirmDelete()}>
            <span class={styles.spacer} />
            <Button onClick={props.onClose} data-testid="org-cancel">
              {readOnly() ? t("agents.close") : t("orgs.cancel")}
            </Button>
            <Show when={!readOnly()}>
              <Button
                variant="primary"
                type="submit"
                disabled={!valid() || busy()}
                data-testid="org-submit"
              >
                {isNew ? t("orgs.create") : t("orgs.save")}
              </Button>
            </Show>
          </Show>
        </div>
      </form>
    </Dialog>
  )
}
