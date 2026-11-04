import {
  type Agent,
  CHANNEL_NAME_MAX,
  CHANNEL_TOPIC_MAX,
  type Channel,
  charLength,
  filterAgents,
} from "@robot/shared"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Face } from "../agents/Face.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useDevices } from "../state/devices.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { SectionSelect } from "../ui/SectionSelect.tsx"
import styles from "./channels.module.css"

/** Makes a channel, or changes the name, topic, members and lead of one. */
export const ChannelDialog = (props: { channel?: Channel; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const devices = useDevices()
  const agents = useAgents()
  const [name, setName] = createSignal(props.channel?.name ?? "")
  const [topic, setTopic] = createSignal(props.channel?.topic ?? "")
  const [members, setMembers] = createSignal<string[]>([...(props.channel?.memberIds ?? [])])
  const [query, setQuery] = createSignal("")
  const [leadId, setLeadId] = createSignal<string | null>(props.channel?.leadId ?? null)
  const [sectionId, setSectionId] = createSignal<string | null>(props.channel?.sectionId ?? null)
  const [reviewParts, setReviewParts] = createSignal(props.channel?.reviewParts ?? false)
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)

  const valid = () =>
    charLength(name().trim()) >= 1 &&
    charLength(name().trim()) <= CHANNEL_NAME_MAX &&
    charLength(topic().trim()) <= CHANNEL_TOPIC_MAX
  // Members that the search hides stay chosen: the choice lives in `members`, not in the list.
  const shown = createMemo(() => filterAgents(agents.agents(), query()))
  const toggle = (agent: Agent) => {
    const on = members().includes(agent.id)
    setMembers(on ? members().filter((m) => m !== agent.id) : [...members(), agent.id])
    if (on && leadId() === agent.id) setLeadId(null)
  }

  /**
   * The section is a layout of this computer. A client has no sections to set (spec 012), and a
   * section that was deleted while the form was open shows as "No section".
   */
  const sectionField = () =>
    ui.linked() ? {} : { sectionId: ui.hasSection("channel", sectionId()) ? sectionId() : null }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!valid() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      if (props.channel) {
        await call("channels.update", {
          id: props.channel.id,
          patch: {
            name: name().trim(),
            topic: topic().trim(),
            memberIds: members(),
            leadId: leadId(),
            // A client cannot set it (spec 012). Turning it off changes no part in review.
            ...(ui.linked() ? {} : { reviewParts: reviewParts() }),
            ...sectionField(),
          },
        })
      } else {
        const serverId = ui.server()?.id
        if (!serverId) return
        const channel = await call("channels.create", {
          serverId,
          name: name().trim(),
          topic: topic().trim(),
          memberIds: members(),
          leadId: leadId(),
          ...sectionField(),
        })
        ui.selectPlace({ kind: "channel", id: channel.id })
      }
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!props.channel) return
    try {
      await call("channels.delete", { id: props.channel.id })
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    }
  }

  return (
    <Dialog
      label={props.channel ? t("channels.edit.title") : t("channels.create.title")}
      onClose={props.onClose}
      testId="channel-dialog"
    >
      <form class={styles.form} onSubmit={submit} data-testid="channel-form">
        <h2 class={styles.title}>
          {props.channel ? t("channels.edit.title") : t("channels.create.title")}
        </h2>
        <label class={styles.field}>
          <span class={styles.label}>{t("channels.name")}</span>
          <input
            class={styles.input}
            value={name()}
            maxLength={CHANNEL_NAME_MAX}
            onInput={(e) => setName(e.currentTarget.value)}
            data-testid="channel-name"
          />
        </label>
        <label class={styles.field}>
          <span class={styles.label}>{t("channels.topic")}</span>
          <input
            class={styles.input}
            value={topic()}
            maxLength={CHANNEL_TOPIC_MAX}
            onInput={(e) => setTopic(e.currentTarget.value)}
            data-testid="channel-topic"
          />
          <span class={styles.hint}>{t("channels.topic.hint")}</span>
        </label>
        <fieldset class={styles.field}>
          <legend class={styles.label}>{t("channels.members")}</legend>
          <Show
            when={agents.agents().length > 0}
            fallback={<p class={styles.hint}>{t("channels.members.none")}</p>}
          >
            <input
              class={`${styles.input} ${styles.memberSearch}`}
              type="search"
              value={query()}
              placeholder={t("channels.members.search")}
              aria-label={t("channels.members.search")}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                // Enter in the field must not send the form.
                if (e.key === "Enter") e.preventDefault()
              }}
              data-testid="channel-member-search"
            />
            <div class={styles.memberBox} data-testid="channel-member-box">
              {/* Rows of the same shape as the real ones, so the box is as high as the whole list. */}
              <div class={styles.memberSizer} aria-hidden="true">
                <For each={agents.agents()}>
                  {() => (
                    <div class={styles.member}>
                      <input type="checkbox" tabindex={-1} disabled />
                      <span class={styles.memberFace} />
                      <span class={styles.memberName}>&nbsp;</span>
                    </div>
                  )}
                </For>
              </div>
              <div class={styles.memberList}>
                <Show
                  when={shown().length > 0}
                  fallback={
                    <p class={styles.hint} data-testid="channel-member-nomatch">
                      {t("channels.members.noMatch")}
                    </p>
                  }
                >
                  <For each={shown()}>
                    {(agent) => (
                      <label class={styles.member}>
                        <input
                          type="checkbox"
                          checked={members().includes(agent.id)}
                          onChange={() => toggle(agent)}
                          data-testid={`channel-member-${agent.name}`}
                        />
                        <Face face={agent.face} image={agent.faceImage} size={20} />
                        <span class={styles.memberName}>{agent.name}</span>
                        <Show when={agent.role}>
                          <span class={styles.memberRole}>{agent.role}</span>
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
              data-testid="channel-member-count"
            >
              <Show when={members().length > 0}>
                {t("channels.members.selected", { count: members().length })}
              </Show>
            </span>
          </Show>
        </fieldset>
        <label class={styles.field}>
          <span class={styles.label}>{t("channels.lead")}</span>
          <select
            class={styles.input}
            onChange={(e) => setLeadId(e.currentTarget.value || null)}
            data-testid="channel-lead"
          >
            <option value="" selected={leadId() === null}>
              {t("channels.lead.none")}
            </option>
            <For each={agents.agents().filter((a) => members().includes(a.id))}>
              {(a) => (
                <option value={a.id} selected={leadId() === a.id}>
                  {a.name}
                </option>
              )}
            </For>
          </select>
          <span class={styles.hint}>{t("channels.lead.hint")}</span>
        </label>
        <Show when={props.channel && !ui.linked()}>
          <div class={styles.field}>
            <span class={styles.label}>{t("channels.reviewParts")}</span>
            <Switch
              label={t("channels.reviewParts")}
              checked={reviewParts()}
              onChange={setReviewParts}
              testId="channel-review-parts"
            />
            <span class={styles.hint}>{t("channels.reviewParts.hint")}</span>
          </div>
        </Show>
        <Show when={!ui.linked()}>
          <div class={styles.field}>
            <span class={styles.label}>{t("sections.field")}</span>
            <SectionSelect
              kind="channel"
              value={sectionId()}
              onChange={setSectionId}
              class={styles.input}
              testId="channel-section"
            />
          </div>
        </Show>
        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="channel-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <div class={styles.actions}>
          {/* A client cannot delete a channel of a server (spec 012). */}
          <Show when={props.channel && !ui.linked()}>
            <Show
              when={confirmDelete()}
              fallback={
                <Button onClick={() => setConfirmDelete(true)} data-testid="channel-delete">
                  {t("channels.delete")}
                </Button>
              }
            >
              <span class={styles.hint}>{t("channels.delete.confirm")}</span>
              <Show when={devices.sync.pairName()}>
                {(name) => (
                  <span class={styles.hint} data-testid="delete-sync-line">
                    {t("channels.delete.sync", { name: name() })}
                  </span>
                )}
              </Show>
              <Button onClick={remove} data-testid="channel-delete-confirm">
                {t("channels.delete")}
              </Button>
            </Show>
          </Show>
          <span class={styles.spacer} />
          <Button onClick={props.onClose}>{t("channels.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!valid() || busy()}
            data-testid="channel-submit"
          >
            {props.channel ? t("channels.save") : t("channels.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
