import {
  type Agent,
  charLength,
  filterAgents,
  type HandOffRange,
  memberLineConflict,
  ORG_GOAL_MAX,
  ORG_NAME_MAX,
  type Org,
  type OrgCreate,
  orgDeleteSubCount,
  orgParentOptions,
  orgPatchOf,
  parentLineReasons,
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
import { limitFieldValid, limitPatch, limitText as textOfLimit } from "./limit.ts"
import { OrgLimitField } from "./OrgLimit.tsx"
import { OrgRange } from "./OrgRange.tsx"
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
export const OrgDialog = (props: {
  id: string
  onClose: () => void
  /** The organization that a save made: the org chart puts the focus on its node (spec 029). */
  onSaved?: (org: Org) => void
}) => {
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
    goal: org?.goal ?? "",
    memberIds: org?.memberIds ?? [],
    leadId: storedLead,
    parentId: org ? untrack(() => orgs.parentOf(org.id)) : null,
    handOffRange: org?.handOffRange ?? ("inherit" as HandOffRange),
  }
  // The daily token limit (spec 030): off by default. On, it takes a whole number in a range.
  const wasLimit = org?.dailyTokenLimit ?? null

  const [name, setName] = createSignal(was.name)
  const [goal, setGoal] = createSignal(was.goal)
  const [members, setMembers] = createSignal<string[]>([...was.memberIds])
  const [leadId, setLeadId] = createSignal<string | null>(was.leadId)
  const [parentId, setParentId] = createSignal<string | null>(was.parentId)
  const [range, setRange] = createSignal<HandOffRange>(was.handOffRange)
  const [limitOn, setLimitOn] = createSignal(wasLimit !== null)
  const [limitText, setLimitText] = createSignal(textOfLimit(wasLimit))
  const [query, setQuery] = createSignal("")
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)

  const readOnly = () => !ui.canChange()

  // An archived agent stays a member (spec 030). The form lists it, marked, so the user can remove
  // it. Only the archived agents that are members are offered.
  // The rule "One line" counts the archived agents too, so the form reads all of them.
  const [archivedAll] = createResource(
    () => ui.server()?.id,
    (serverId) => call("agents.list", { serverId, archived: true }).catch((): Agent[] => []),
  )
  const archived = () => (archivedAll() ?? []).filter((a) => was.memberIds.includes(a.id))
  const choices = createMemo<MemberChoice[]>(() => [
    ...agents.agents().map((agent) => ({ agent, archived: false })),
    ...archived()
      .filter((a) => !agents.agents().some((x) => x.id === a.id))
      .map((agent) => ({ agent, archived: true })),
  ])
  // Every agent that the rule "One line" reads: the ones in the list and the archived ones.
  const lineAgents = createMemo(() => [
    ...agents.agents(),
    ...(archivedAll() ?? []).filter((a) => !agents.agents().some((x) => x.id === a.id)),
  ])
  // The organization that keeps an agent out of this one, or undefined (spec 030, "One line"): the
  // field "Members" shows it as "In <other>." The parent that the form holds now counts.
  const memberConflict = (agentId: string) =>
    memberLineConflict(orgs.orgs(), lineAgents(), agentId, org?.id ?? NEW_ORG, {
      parentId: parentId(),
    })
  const otherName = (id: string | undefined) =>
    id === undefined ? "" : (orgs.byId(id)?.name ?? "")
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
    if (!on && memberConflict(agentId) !== undefined) return
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
  // The organizations that would split the line of an agent as the parent (spec 030, "One line"):
  // the members that the form holds now count. The reasons of the tree come first.
  const splits = createMemo(() =>
    parentLineReasons(orgs.orgs(), lineAgents(), org?.id ?? NEW_ORG, members()),
  )
  const refused = (choice: { id: string; refusal: unknown }) =>
    choice.refusal !== undefined || splits().has(choice.id)
  const agentName = (id: string | undefined) => lineAgents().find((a) => a.id === id)?.name ?? ""

  const limitValid = () => limitFieldValid(limitOn(), limitText())
  // The goal holds 0 to 400 characters (spec 030, "Goal"). The field counts what is left.
  const goalLeft = () => ORG_GOAL_MAX - charLength(goal())
  const valid = () => {
    const length = charLength(name().trim())
    return length >= 1 && length <= ORG_NAME_MAX && goalLeft() >= 0 && limitValid()
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
          goal: goal(),
          memberIds: members(),
          leadId: leadId(),
          parentId: parentId(),
          handOffRange: range(),
        })
        // The limit is sent only when the user changed it.
        const changes = { ...patch, ...limitPatch(wasLimit, limitOn(), limitText()) }
        // Nothing changed: nothing to send.
        if (Object.keys(changes).length > 0)
          await call("organizations.update", { id: org.id, patch: changes })
      } else {
        const serverId = ui.server()?.id
        if (!serverId) return
        const input: OrgCreate = {
          serverId,
          name: name().trim(),
          ...(goal().trim() !== "" ? { goal: goal().trim() } : {}),
          memberIds: members(),
          leadId: leadId() !== null && members().includes(leadId() as string) ? leadId() : null,
          ...(parentId() ? { parentId: parentId() } : {}),
          ...(range() !== "inherit" ? { handOffRange: range() } : {}),
          ...limitPatch(null, limitOn(), limitText()),
        }
        const made = await call("organizations.create", input)
        props.onSaved?.(made)
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

  // <n> and <parent> of the confirm: the direct sub-organizations move up (spec 030, flow 4).
  const subCount = () => (org ? orgDeleteSubCount(orgs.orgs(), org.id) : 0)
  const upTo = () => (org ? orgs.byId(orgs.parentOf(org.id) ?? "") : undefined)
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
        {/* Why the organization exists (spec 030, "Goal"). Its members read it before their own
            instructions. */}
        <label class={styles.field}>
          <span class={styles.label}>{t("orgs.goal")}</span>
          <textarea
            class={`${styles.input} ${styles.goal}`}
            value={goal()}
            rows={3}
            readOnly={readOnly()}
            aria-invalid={goalLeft() < 0}
            aria-describedby="org-goal-hint"
            onInput={(e) => setGoal(e.currentTarget.value)}
            data-testid="org-goal"
          />
          <span class={styles.hint} id="org-goal-hint" data-testid="org-goal-hint">
            {t("orgs.goal.hint", { left: goalLeft() })}
          </span>
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
                    {(choice) => {
                      // An agent that "One line" keeps out shows muted with "In <other>." and cannot
                      // be ticked. A member that is in already is never muted: a removal is allowed.
                      const conflict = () =>
                        members().includes(choice.agent.id)
                          ? undefined
                          : memberConflict(choice.agent.id)
                      return (
                        <label
                          class={`${styles.member} ${conflict() ? styles.memberMuted : ""}`}
                          data-line={conflict() ?? ""}
                        >
                          <input
                            type="checkbox"
                            checked={members().includes(choice.agent.id)}
                            disabled={readOnly() || conflict() !== undefined}
                            onChange={() => toggle(choice.agent.id)}
                            data-testid={`org-member-${choice.agent.name}`}
                          />
                          <Face face={choice.agent.face} image={choice.agent.faceImage} size={20} />
                          <span class={styles.memberName}>{memberName(choice)}</span>
                          <Show
                            when={conflict()}
                            fallback={
                              <Show when={choice.agent.role}>
                                <span class={styles.memberRole}>{choice.agent.role}</span>
                              </Show>
                            }
                          >
                            {(other) => (
                              <span
                                class={styles.memberRole}
                                data-testid={`org-member-line-${choice.agent.name}`}
                              >
                                {t("orgs.line.in", { other: otherName(other()) })}
                              </span>
                            )}
                          </Show>
                        </label>
                      )
                    }}
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
                  disabled={refused(choice) && parentId() !== choice.id}
                  data-refusal={choice.refusal ?? (splits().has(choice.id) ? "line" : "")}
                >
                  {choice.refusal
                    ? t("orgs.parent.option", {
                        name: choice.name,
                        reason: t(reasonKey(choice.refusal)),
                      })
                    : splits().has(choice.id)
                      ? t("orgs.parent.option", {
                          name: choice.name,
                          reason: t("orgs.line.split", {
                            agent: agentName(splits().get(choice.id)),
                          }),
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
          <OrgRange
            value={range()}
            parentId={parentId()}
            orgs={orgs.orgs()}
            readOnly={readOnly()}
            onChange={setRange}
          />
          <OrgLimitField
            orgId={org?.id}
            orgName={org?.name ?? name()}
            on={limitOn()}
            text={limitText()}
            valid={limitValid()}
            readOnly={readOnly()}
            onSwitch={setLimitOn}
            onText={setLimitText}
          />
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
                <Show when={subCount() > 0}>
                  <p data-testid="org-delete-lower">
                    {t(
                      `orgs.delete.${upTo() ? "up" : "top"}.${subCount() === 1 ? "one" : "other"}`,
                      { count: subCount(), parent: upTo()?.name ?? "" },
                    )}
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
