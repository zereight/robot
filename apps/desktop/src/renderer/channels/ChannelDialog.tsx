import {
  type Agent,
  CHANNEL_INSTRUCTIONS_MAX,
  CHANNEL_NAME_MAX,
  CHANNEL_PICTURE_EDGE,
  CHANNEL_TOPIC_MAX,
  type Channel,
  channelParent,
  charLength,
  filterAgents,
  type ParentRefusal,
  parentChoices,
} from "@robot/shared"
import { createMemo, createSignal, For, Show } from "solid-js"
import { Face } from "../agents/Face.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { squarePicture } from "../lib/image.ts"
import { call } from "../lib/rpc.ts"
import { AgentName, useShownText } from "../orgs/AgentName.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useChannels } from "../state/channels.tsx"
import { useDevices } from "../state/devices.tsx"
import { useUi } from "../state/ui.tsx"
import { ChannelMark } from "../ui/ChannelMark.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { SectionSelect } from "../ui/SectionSelect.tsx"
import styles from "./channels.module.css"
import { limitFieldValid, limitPatch, limitText as textOfLimit } from "./limit.ts"

/** Makes a channel, or changes the name, topic, members and lead of one. */
export const ChannelDialog = (props: { channel?: Channel; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const devices = useDevices()
  const agents = useAgents()
  const shownText = useShownText()
  const channels = useChannels()
  const [name, setName] = createSignal(props.channel?.name ?? "")
  const [topic, setTopic] = createSignal(props.channel?.topic ?? "")
  const [instructions, setInstructions] = createSignal(props.channel?.instructions ?? "")
  const [members, setMembers] = createSignal<string[]>([...(props.channel?.memberIds ?? [])])
  const [query, setQuery] = createSignal("")
  const [leadId, setLeadId] = createSignal<string | null>(props.channel?.leadId ?? null)
  const [sectionId, setSectionId] = createSignal<string | null>(props.channel?.sectionId ?? null)
  const [reviewParts, setReviewParts] = createSignal(props.channel?.reviewParts ?? false)
  // The parent of the tree as it is now: a stored parent that is gone shows as "None" (spec 030).
  const [parentId, setParentId] = createSignal<string | null>(
    props.channel ? channelParent(channels.channels(), props.channel.id) : null,
  )
  /**
   * The choices of "Parent channel": the other channels by name, each with the reason when the
   * rules of the tree do not allow it. A channel that is not made yet has no lower channel.
   */
  const parents = createMemo(() => {
    const all = channels.channels()
    const reasons = new Map(
      parentChoices(all, props.channel?.id ?? "").map((c) => [c.id, c.refusal]),
    )
    return all
      .filter((c) => reasons.has(c.id))
      .map((c) => ({ channel: c, refusal: reasons.get(c.id) }))
      .sort((a, b) =>
        a.channel.name.localeCompare(b.channel.name, undefined, { sensitivity: "base" }),
      )
  })
  const reasonKey = (refusal: ParentRefusal) =>
    refusal === "loop" ? "channels.parent.loop" : "channels.parent.levels"
  /** The parent to send: unchanged when the user did not touch the field. */
  const parentField = () =>
    props.channel && parentId() === channelParent(channels.channels(), props.channel.id)
      ? {}
      : { parentId: parentId() }
  // The daily token limit (spec 030): off by default. On, it takes a whole number in a range.
  const was = props.channel?.dailyTokenLimit ?? null
  const [limitOn, setLimitOn] = createSignal(was !== null)
  const [limitText, setLimitText] = createSignal(textOfLimit(was))
  const limitValid = () => limitFieldValid(limitOn(), limitText())
  /** The limit to send: only when the user changed it. */
  const limitField = () => limitPatch(was, limitOn(), limitText())
  const [leadAnswers, setLeadAnswers] = createSignal(props.channel?.leadAnswers ?? true)
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)
  // The picture applies at once, as the picture of an agent does (spec 004, 002). The channel
  // that the dialog got is a snapshot, so the answer of the server is kept here.
  const [picture, setPicture] = createSignal<string | null>(props.channel?.picture ?? null)
  let fileInput: HTMLInputElement | undefined

  /** The window cuts the image to a square of 256 px; the service checks it again. */
  const upload = async (file: File | undefined) => {
    if (!file || !props.channel) return
    setError(undefined)
    try {
      const dataUrl = await squarePicture(file, CHANNEL_PICTURE_EDGE)
      setPicture((await call("channels.setPicture", { id: props.channel.id, dataUrl })).picture)
    } catch (e) {
      setError(describeError(e))
    } finally {
      // The same file can be picked again.
      if (fileInput) fileInput.value = ""
    }
  }
  const removePicture = async () => {
    if (!props.channel) return
    setError(undefined)
    try {
      setPicture(
        (await call("channels.setPicture", { id: props.channel.id, dataUrl: null })).picture,
      )
    } catch (e) {
      setError(describeError(e))
    }
  }

  const valid = () =>
    charLength(name().trim()) >= 1 &&
    charLength(name().trim()) <= CHANNEL_NAME_MAX &&
    charLength(topic().trim()) <= CHANNEL_TOPIC_MAX &&
    charLength(instructions()) <= CHANNEL_INSTRUCTIONS_MAX &&
    limitValid()
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
            instructions: instructions(),
            memberIds: members(),
            leadId: leadId(),
            // A client cannot set it (spec 012). Turning it off changes no part in review.
            ...(ui.linked() ? {} : { reviewParts: reviewParts() }),
            // A client sets it only with the switch "Can create and change agents" (spec 012).
            leadAnswers: leadAnswers(),
            ...sectionField(),
            ...parentField(),
            ...limitField(),
          },
        })
      } else {
        const serverId = ui.server()?.id
        if (!serverId) return
        const channel = await call("channels.create", {
          serverId,
          name: name().trim(),
          topic: topic().trim(),
          instructions: instructions(),
          memberIds: members(),
          leadId: leadId(),
          ...sectionField(),
          ...(parentId() ? { parentId: parentId() } : {}),
          ...limitField(),
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
                        <span class={styles.memberName}>
                          <AgentName id={agent.id} name={agent.name} />
                        </span>
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
                  {shownText(a.id, a.name)}
                </option>
              )}
            </For>
          </select>
          <span class={styles.hint}>{t("channels.lead.hint")}</span>
        </label>
        <label class={styles.field}>
          <span class={styles.label}>{t("channels.parent")}</span>
          <select
            class={styles.input}
            onChange={(e) => setParentId(e.currentTarget.value || null)}
            data-testid="channel-parent"
          >
            <option value="" selected={parentId() === null}>
              {t("channels.parent.none")}
            </option>
            <For each={parents()}>
              {(choice) => (
                <option
                  value={choice.channel.id}
                  selected={parentId() === choice.channel.id}
                  disabled={choice.refusal !== undefined && parentId() !== choice.channel.id}
                  data-refusal={choice.refusal ?? ""}
                >
                  {choice.refusal
                    ? t("channels.parent.option", {
                        name: choice.channel.name,
                        reason: t(reasonKey(choice.refusal)),
                      })
                    : choice.channel.name}
                </option>
              )}
            </For>
          </select>
          <span class={styles.hint}>{t("channels.parent.hint")}</span>
        </label>
        <label class={styles.field}>
          <span class={styles.label}>{t("channels.instructions")}</span>
          <textarea
            class={`${styles.input} ${styles.textarea}`}
            value={instructions()}
            onInput={(e) => setInstructions(e.currentTarget.value)}
            aria-invalid={charLength(instructions()) > CHANNEL_INSTRUCTIONS_MAX}
            data-testid="channel-instructions"
          />
          <span class={styles.hint}>
            {t("channels.instructions.hint")}{" "}
            <span
              data-over={charLength(instructions()) > CHANNEL_INSTRUCTIONS_MAX}
              data-testid="channel-instructions-count"
            >
              {t("agents.counter", {
                used: charLength(instructions()),
                max: CHANNEL_INSTRUCTIONS_MAX,
              })}
            </span>
          </span>
        </label>
        <div class={styles.field} data-testid="channel-daily-limit">
          <span class={styles.label}>{t("channels.dailyLimit")}</span>
          <div class={styles.limitRow}>
            <Switch
              label={t("channels.dailyLimit")}
              checked={limitOn()}
              onChange={setLimitOn}
              testId="channel-limit-switch"
            />
            <Show when={limitOn()}>
              <input
                class={`${styles.input} ${styles.limitInput}`}
                inputmode="numeric"
                value={limitText()}
                placeholder={t("channels.dailyLimit.placeholder")}
                aria-label={t("channels.dailyLimit")}
                aria-invalid={!limitValid()}
                onInput={(e) => setLimitText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  // Enter in the field sends the form, as in any other field.
                  if (e.key === "Escape") e.stopPropagation()
                }}
                data-testid="channel-limit"
              />
            </Show>
          </div>
          <span class={styles.hint}>{t("channels.dailyLimit.hint")}</span>
          <Show when={limitOn() && !limitValid()}>
            <span class={styles.hint} role="alert" data-testid="channel-limit-error">
              {t("error.invalid_daily_limit")}
            </span>
          </Show>
        </div>
        {/* The picture of a channel that exists. A client sets it with the switch (spec 012). */}
        <Show when={props.channel}>
          <div class={styles.field}>
            <span class={styles.label}>{t("channels.picture")}</span>
            <div class={styles.pictureRow}>
              <ChannelMark picture={picture()} size={40} testId="channel-picture-preview" />
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                hidden
                data-testid="channel-picture-file"
                onChange={(e) => upload(e.currentTarget.files?.[0])}
              />
              <Button onClick={() => fileInput?.click()} data-testid="channel-picture-upload">
                {t("channels.picture.upload")}
              </Button>
              <Show when={picture()}>
                <Button onClick={removePicture} data-testid="channel-picture-remove">
                  {t("channels.picture.remove")}
                </Button>
              </Show>
            </div>
            <span class={styles.hint}>{t("channels.picture.hint")}</span>
          </div>
        </Show>
        {/* The lead reads a question of a member first (spec 004, "Questions of members"). */}
        <Show when={props.channel}>
          <div class={styles.field}>
            <span class={styles.label}>{t("channels.leadAnswers")}</span>
            <Switch
              label={t("channels.leadAnswers")}
              checked={leadId() !== null && leadAnswers()}
              disabled={leadId() === null}
              onChange={setLeadAnswers}
              testId="channel-lead-answers"
            />
            <span class={styles.hint}>{t("channels.leadAnswers.hint")}</span>
            <Show when={leadId() === null}>
              <span class={styles.hint} data-testid="channel-lead-answers-no-lead">
                {t("channels.leadAnswers.noLead")}
              </span>
            </Show>
          </div>
        </Show>
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
