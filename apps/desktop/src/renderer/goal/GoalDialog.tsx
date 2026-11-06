import {
  AGENT_NAME_MAX,
  AGENT_ROLE_MAX,
  agentStarterOf,
  CHANNEL_NAME_MAX,
  CHANNEL_TOPIC_MAX,
  type ChannelPlan,
  channelPlan,
  clipGoal,
  GOAL_STARTERS,
  GOAL_TEXT_MAX,
  type GoalStarterId,
  goalRow,
  isChannelStarter,
  planNames,
  recommend,
  SAVED_AGENTS_MAX,
  SAVED_AGENTS_MIN,
  SAVED_STARTER_MAX,
  type SavedStarter,
  type SavedStarterDraft,
  type StarterId,
  savedPlan,
  savedStarterProblems,
} from "@robot/shared"
import { createSignal, For, Show } from "solid-js"
import styles from "../agents/agents.module.css"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import goal from "./goal.module.css"

const blankAgent = () => ({ name: "", role: "", instructions: "" })

/**
 * The goal dialog (spec 031): a few words, the starters that fit, a preview of a channel, and the
 * starters that the user saved. The app compares the words with a fixed list on this computer. It
 * sends them nowhere and keeps them nowhere.
 */
export const GoalDialog = (props: {
  onClose: () => void
  /** An agent starter was picked: the new agent form takes it. */
  onAgentStarter: (id: StarterId) => void
  /** A channel was made. */
  onCreated: () => void
}) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const [text, setText] = createSignal("")
  const [plan, setPlan] = createSignal<ChannelPlan>()
  const [channelName, setChannelName] = createSignal("")
  const [topic, setTopic] = createSignal("")
  const [names, setNames] = createSignal<string[]>([])
  const [draft, setDraft] = createSignal<{ id: string | null; value: SavedStarterDraft }>()
  const [confirming, setConfirming] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()

  const saved = () => ui.ui.savedStarters
  const recommended = () => recommend(text())

  const openPreview = (next: ChannelPlan) => {
    setPlan(next)
    setChannelName(next.name)
    setTopic(next.topic)
    setNames(next.agents.map((a) => a.name))
    setError(undefined)
  }

  const pick = (id: GoalStarterId) => {
    const agentStarter = agentStarterOf(id)
    if (agentStarter) {
      props.onAgentStarter(agentStarter)
      props.onClose()
    } else if (isChannelStarter(id)) {
      openPreview(channelPlan(app.locale(), id))
    }
  }

  const previewValid = () => channelName().trim() !== "" && names().every((n) => n.trim() !== "")

  /** Makes every agent and then the channel. If a part fails, the agents made so far go away. */
  const create = async (event: SubmitEvent) => {
    event.preventDefault()
    const current = plan()
    const serverId = ui.server()?.id
    if (!current || !serverId || !previewValid() || busy()) return
    setBusy(true)
    setError(undefined)
    const made: string[] = []
    try {
      // The names are read again now, so an agent made a moment ago counts.
      const [active, archived, channels] = await Promise.all([
        call("agents.list", { serverId, archived: false }),
        call("agents.list", { serverId, archived: true }),
        call("channels.list", { serverId }),
      ])
      const agentNames = planNames(
        names().map((n) => n.trim()),
        [...active, ...archived].map((a) => a.name),
      )
      const [channel] = planNames(
        [channelName().trim()],
        channels.map((c) => c.name),
        CHANNEL_NAME_MAX,
      )
      for (const [i, agent] of current.agents.entries()) {
        const row = await call("agents.create", {
          serverId,
          name: agentNames[i] ?? agent.name,
          role: agent.role,
          instructions: agent.instructions,
        })
        made.push(row.id)
      }
      const created = await call("channels.create", {
        serverId,
        name: channel ?? channelName().trim(),
        topic: topic().trim(),
        memberIds: made,
        leadId: made[current.lead] ?? null,
      })
      ui.selectPlace({ kind: "channel", id: created.id })
      props.onCreated()
      props.onClose()
    } catch (e) {
      for (const id of made) await call("agents.delete", { id }).catch(() => undefined)
      setError(describeError(e))
      setBusy(false)
    }
  }

  const row = (id: GoalStarterId) => {
    const r = () => goalRow(app.locale(), id)
    return (
      <button
        type="button"
        class={styles.starter}
        data-testid={`goal-${id}`}
        onClick={() => pick(id)}
      >
        <span class={styles.starterName}>{r().name}</span>
        <span class={styles.starterJob}>{r().line}</span>
        <span class={styles.starterExtras}>{r().muted}</span>
      </button>
    )
  }

  // --- Saved starters ---------------------------------------------------------------------

  const openDraft = (from?: SavedStarter) =>
    setDraft({
      id: from?.id ?? null,
      value: from
        ? { name: from.name, topic: from.topic, lead: from.lead, agents: from.agents }
        : { name: "", topic: "", lead: 0, agents: [blankAgent(), blankAgent()] },
    })
  const change = (patch: Partial<SavedStarterDraft>) => {
    const d = draft()
    if (d) setDraft({ id: d.id, value: { ...d.value, ...patch } })
  }
  const changeAgent = (i: number, patch: Partial<ReturnType<typeof blankAgent>>) =>
    change({
      agents: (draft()?.value.agents ?? []).map((a, at) => (at === i ? { ...a, ...patch } : a)),
    })
  const removeAgent = (i: number) => {
    const d = draft()?.value
    if (!d) return
    const lead = d.lead === i ? 0 : d.lead > i ? d.lead - 1 : d.lead
    change({ agents: d.agents.filter((_, at) => at !== i), lead })
  }
  const saveDraft = async (event: SubmitEvent) => {
    event.preventDefault()
    const d = draft()
    if (!d || savedStarterProblems(d.value).length > 0) return
    const clean: SavedStarterDraft = {
      ...d.value,
      name: d.value.name.trim(),
      topic: d.value.topic.trim(),
      agents: d.value.agents.map((a) => ({ ...a, name: a.name.trim(), role: a.role.trim() })),
    }
    const next =
      d.id === null
        ? [...saved(), { id: crypto.randomUUID(), ...clean }]
        : saved().map((s) => (s.id === d.id ? { id: s.id, ...clean } : s))
    await ui.saveStarters(next)
    setDraft(undefined)
  }
  const remove = async (id: string) => {
    await ui.saveStarters(saved().filter((s) => s.id !== id))
    setConfirming(undefined)
  }

  return (
    <Dialog label={t("goal.title")} onClose={props.onClose} testId="goal-dialog">
      <Show
        when={!draft()}
        fallback={
          <form class={styles.form} onSubmit={saveDraft} data-testid="goal-editor">
            <h2 class={styles.title}>{t("goal.new")}</h2>
            <div class={styles.field}>
              <label class={styles.label} for="goal-edit-name">
                {t("goal.channelName")}
              </label>
              <input
                id="goal-edit-name"
                class={styles.input}
                type="text"
                maxLength={CHANNEL_NAME_MAX}
                value={draft()?.value.name ?? ""}
                onInput={(e) => change({ name: e.currentTarget.value })}
                data-testid="goal-edit-name"
              />
            </div>
            <div class={styles.field}>
              <label class={styles.label} for="goal-edit-topic">
                {t("goal.topic")}
              </label>
              <input
                id="goal-edit-topic"
                class={styles.input}
                type="text"
                maxLength={CHANNEL_TOPIC_MAX}
                value={draft()?.value.topic ?? ""}
                onInput={(e) => change({ topic: e.currentTarget.value })}
                data-testid="goal-edit-topic"
              />
            </div>
            <For each={draft()?.value.agents ?? []}>
              {(agent, i) => (
                <div class={goal.agent} data-testid={`goal-edit-agent-${i()}`}>
                  <div class={goal.agentHead}>
                    <input
                      class={styles.input}
                      type="text"
                      aria-label={t("goal.agent.name")}
                      placeholder={t("goal.agent.name")}
                      maxLength={AGENT_NAME_MAX}
                      value={agent.name}
                      onInput={(e) => changeAgent(i(), { name: e.currentTarget.value })}
                      data-testid={`goal-edit-agent-name-${i()}`}
                    />
                    <label>
                      <input
                        type="radio"
                        name="goal-lead"
                        checked={draft()?.value.lead === i()}
                        onChange={() => change({ lead: i() })}
                        data-testid={`goal-edit-lead-${i()}`}
                      />{" "}
                      {t("goal.agent.lead")}
                    </label>
                    <Button
                      onClick={() => removeAgent(i())}
                      disabled={(draft()?.value.agents.length ?? 0) <= SAVED_AGENTS_MIN}
                      data-testid={`goal-edit-remove-${i()}`}
                    >
                      {t("goal.agent.remove")}
                    </Button>
                  </div>
                  <input
                    class={styles.input}
                    type="text"
                    aria-label={t("goal.agent.role")}
                    placeholder={t("goal.agent.role")}
                    maxLength={AGENT_ROLE_MAX}
                    value={agent.role}
                    onInput={(e) => changeAgent(i(), { role: e.currentTarget.value })}
                    data-testid={`goal-edit-agent-role-${i()}`}
                  />
                  <textarea
                    class={styles.input}
                    aria-label={t("goal.agent.instructions")}
                    placeholder={t("goal.agent.instructions")}
                    rows={2}
                    value={agent.instructions}
                    onInput={(e) => changeAgent(i(), { instructions: e.currentTarget.value })}
                    data-testid={`goal-edit-agent-instructions-${i()}`}
                  />
                </div>
              )}
            </For>
            <Show when={(draft()?.value.agents.length ?? 0) < SAVED_AGENTS_MAX}>
              <div>
                <Button
                  onClick={() =>
                    change({ agents: [...(draft()?.value.agents ?? []), blankAgent()] })
                  }
                  data-testid="goal-edit-add"
                >
                  {t("goal.agent.add")}
                </Button>
              </div>
            </Show>
            <span class={styles.hint}>{t("goal.agents.few")}</span>
            <div class={styles.actions}>
              <Button onClick={() => setDraft(undefined)} data-testid="goal-edit-cancel">
                {t("agents.cancel")}
              </Button>
              <Button
                variant="primary"
                type="submit"
                disabled={
                  !draft() || savedStarterProblems(draft()?.value as SavedStarterDraft).length > 0
                }
                data-testid="goal-edit-save"
              >
                {t("goal.save")}
              </Button>
            </div>
          </form>
        }
      >
        <Show
          when={plan()}
          fallback={
            <div class={styles.form}>
              <h2 class={styles.title}>{t("goal.title")}</h2>
              <div class={styles.field}>
                <label class={styles.label} for="goal-text">
                  {t("goal.prompt")}
                </label>
                <input
                  id="goal-text"
                  class={styles.input}
                  type="text"
                  autofocus
                  maxLength={GOAL_TEXT_MAX}
                  value={text()}
                  onInput={(e) => {
                    const clipped = clipGoal(e.currentTarget.value)
                    if (clipped !== e.currentTarget.value) e.currentTarget.value = clipped
                    setText(clipped)
                  }}
                  data-testid="goal-text"
                />
              </div>
              <Show when={text().trim() !== ""}>
                <fieldset class={`${styles.field} ${styles.group}`} data-testid="goal-recommended">
                  <legend class={styles.label}>{t("goal.recommended")}</legend>
                  <div class={goal.rows}>
                    <Show
                      when={recommended().length > 0}
                      fallback={<span class={styles.hint}>{t("goal.none")}</span>}
                    >
                      <For each={recommended()}>{(m) => row(m.id)}</For>
                    </Show>
                  </div>
                </fieldset>
              </Show>
              <fieldset class={`${styles.field} ${styles.group}`} data-testid="goal-all">
                <legend class={styles.label}>{t("goal.all")}</legend>
                <div class={goal.rows}>
                  <For each={GOAL_STARTERS}>{(id) => row(id)}</For>
                </div>
              </fieldset>
              <fieldset class={`${styles.field} ${styles.group}`} data-testid="goal-mine">
                <legend class={styles.label}>{t("goal.mine")}</legend>
                <div class={goal.rows}>
                  <For each={saved()}>
                    {(s) => (
                      <div class={goal.saved}>
                        <button
                          type="button"
                          class={styles.starter}
                          data-testid={`goal-saved-${s.id}`}
                          onClick={() => openPreview(savedPlan(s))}
                        >
                          <span class={styles.starterName}>{s.name}</span>
                          <span class={styles.starterJob}>{s.topic}</span>
                          <span class={styles.starterExtras}>
                            {t("goal.agents", { count: s.agents.length })}
                          </span>
                        </button>
                        <Show
                          when={confirming() === s.id}
                          fallback={
                            <>
                              <Button
                                onClick={() => openDraft(s)}
                                data-testid={`goal-edit-${s.id}`}
                              >
                                {t("goal.edit")}
                              </Button>
                              <Button
                                onClick={() => setConfirming(s.id)}
                                data-testid={`goal-delete-${s.id}`}
                              >
                                {t("goal.delete")}
                              </Button>
                            </>
                          }
                        >
                          <span class={styles.hint}>
                            {t("goal.delete.confirm", { name: s.name })}
                          </span>
                          <Button
                            onClick={() => remove(s.id)}
                            data-testid={`goal-delete-yes-${s.id}`}
                          >
                            {t("goal.delete")}
                          </Button>
                          <Button onClick={() => setConfirming(undefined)}>
                            {t("agents.cancel")}
                          </Button>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
                <div>
                  <Button
                    onClick={() => openDraft()}
                    disabled={saved().length >= SAVED_STARTER_MAX}
                    data-testid="goal-new"
                  >
                    {t("goal.new")}
                  </Button>
                  <Show when={saved().length >= SAVED_STARTER_MAX}>
                    <span class={styles.hint}>{t("goal.limit")}</span>
                  </Show>
                </div>
              </fieldset>
              <div class={styles.actions}>
                <Button onClick={props.onClose} data-testid="goal-cancel">
                  {t("agents.cancel")}
                </Button>
              </div>
            </div>
          }
        >
          {(current) => (
            <form class={styles.form} onSubmit={create} data-testid="goal-preview">
              <h2 class={styles.title}>{current().name}</h2>
              <div class={styles.field}>
                <label class={styles.label} for="goal-channel-name">
                  {t("goal.channelName")}
                </label>
                <input
                  id="goal-channel-name"
                  class={styles.input}
                  type="text"
                  maxLength={CHANNEL_NAME_MAX}
                  value={channelName()}
                  onInput={(e) => setChannelName(e.currentTarget.value)}
                  data-testid="goal-channel-name"
                />
                <Show when={channelName().trim() === ""}>
                  <span class={styles.error}>{t("goal.nameEmpty")}</span>
                </Show>
              </div>
              <div class={styles.field}>
                <label class={styles.label} for="goal-channel-topic">
                  {t("goal.topic")}
                </label>
                <input
                  id="goal-channel-topic"
                  class={styles.input}
                  type="text"
                  maxLength={CHANNEL_TOPIC_MAX}
                  value={topic()}
                  onInput={(e) => setTopic(e.currentTarget.value)}
                  data-testid="goal-channel-topic"
                />
              </div>
              <For each={current().agents}>
                {(agent, i) => (
                  <div class={goal.agent} data-testid={`goal-agent-${i()}`}>
                    <div class={goal.agentHead}>
                      <input
                        class={styles.input}
                        type="text"
                        aria-label={t("goal.agent.name")}
                        maxLength={AGENT_NAME_MAX}
                        value={names()[i()] ?? ""}
                        onInput={(e) =>
                          setNames(names().map((n, at) => (at === i() ? e.currentTarget.value : n)))
                        }
                        data-testid={`goal-agent-name-${i()}`}
                      />
                      <Show when={i() === current().lead}>
                        <span class={goal.mark} data-testid="goal-lead-mark">
                          {t("goal.lead")}
                        </span>
                      </Show>
                    </div>
                    <span class={styles.hint}>{agent.role}</span>
                  </div>
                )}
              </For>
              <Show when={error()}>
                {(problem) => (
                  <div class={styles.error} role="alert" data-testid="goal-error">
                    {t(problem().key, problem().params)} {t("goal.failed")}
                  </div>
                )}
              </Show>
              <div class={styles.actions}>
                <Button onClick={() => setPlan(undefined)} data-testid="goal-back">
                  {t("goal.back")}
                </Button>
                <Button onClick={props.onClose} data-testid="goal-preview-cancel">
                  {t("agents.cancel")}
                </Button>
                <Button
                  variant="primary"
                  type="submit"
                  disabled={busy() || !previewValid()}
                  data-testid="goal-create"
                >
                  {t("goal.create")}
                </Button>
              </div>
            </form>
          )}
        </Show>
      </Show>
    </Dialog>
  )
}
