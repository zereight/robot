import {
  addableAgents,
  type Channel,
  type ChannelActivity,
  idsAfterAdd,
  idsAfterRemove,
  type TaskState,
} from "@robot/shared"
import { Check, Circle, Eye, Loader, OctagonX, Plus, X } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
} from "solid-js"
import { Face } from "../agents/Face.tsx"
import { ProfileButton } from "../agents/ProfileButton.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { AgentName } from "../orgs/AgentName.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { quietOfTaskLine } from "../state/quiet.ts"
import { useUi } from "../state/ui.tsx"
import { usageLine } from "../tasks/usageText.ts"
import { IconButton } from "../ui/controls.tsx"
import { stateLabel } from "./ChannelView.tsx"
import styles from "./channels.module.css"

const stepIcon = (state: TaskState): { icon: JSX.Element; key: string } => {
  if (state === "running")
    return {
      icon: (
        <span class={styles.spin}>
          <Loader size={14} />
        </span>
      ),
      key: "channels.step.running",
    }
  if (state === "done") return { icon: <Check size={14} />, key: "channels.step.done" }
  if (state === "failed") return { icon: <X size={14} />, key: "channels.step.failed" }
  // A part in review has an eye, and a blocked part has a stop sign (spec 004).
  if (state === "review") return { icon: <Eye size={14} />, key: "channels.step.review" }
  if (state === "blocked") return { icon: <OctagonX size={14} />, key: "channels.step.blocked" }
  return { icon: <Circle size={14} />, key: "channels.step.todo" }
}

/** Steps after the sixth enter together with it, so a long plan does not take long to show. */
const MAX_STAGGER = 5

/** The "Now" panel: one card per member, and the plan steps under the lead. */
export const ChannelPanel = (props: { channel: Channel }) => {
  const { t, locale } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const server = () => (ui.linked() ? ui.server()?.id : undefined)
  const [activity, { refetch }] = createResource(
    () => props.channel.id,
    (channelId) => call("channels.activity", { channelId }),
  )
  const refresh = () => void refetch()
  onCleanup(
    window.robot.on("channels.changed", (e) => e.channelId === props.channel.id && refresh()),
  )
  onCleanup(window.robot.on("agents.changed", refresh))
  const data = (): ChannelActivity => activity() ?? { members: [] }
  const [pickerOpen, setPickerOpen] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  // The member list of the last edit, until the channel tells the new one. A second quick edit
  // builds on it, so it cannot bring back what the first one took out.
  const [pending, setPending] = createSignal<readonly string[] | null>(null)
  createEffect(
    on(
      () => props.channel.memberIds,
      () => setPending(null),
      { defer: true },
    ),
  )
  const ids = () => pending() ?? props.channel.memberIds
  const addable = createMemo(() => addableAgents(agents.agents(), ids()))
  // One edit at a time, with the same rules as channel settings: a member that works in this
  // channel stays, and removing the lead clears it (the server does both).
  const edit = async (next: readonly string[]) => {
    if (busy()) return
    setBusy(true)
    setError(undefined)
    setPending(next)
    try {
      await call("channels.update", { id: props.channel.id, patch: { memberIds: [...next] } })
    } catch (e) {
      setError(describeError(e))
      setPending(null)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class={styles.panel} data-testid="channel-panel">
      <div class={styles.panelHead}>
        <div class={styles.panelTitle}>{t("channels.now")}</div>
        <Show when={ui.canChange()}>
          <button
            type="button"
            class={styles.panelAdd}
            aria-expanded={pickerOpen()}
            disabled={busy()}
            onClick={() => setPickerOpen((open) => !open)}
            data-testid="panel-add"
          >
            <Plus size={14} aria-hidden="true" />
            <span>{t("channels.panel.add")}</span>
          </button>
        </Show>
      </div>
      <Show when={error()}>
        {(err) => (
          <div class={styles.error} role="alert" data-testid="panel-error">
            {t(err().key, err().params)}
          </div>
        )}
      </Show>
      <Show when={ui.canChange() && pickerOpen()}>
        <Show
          when={addable().length > 0}
          fallback={
            <p class={styles.hint} data-testid="panel-add-empty">
              {t("channels.panel.allIn")}
            </p>
          }
        >
          <div class={styles.addList} data-testid="panel-add-list">
            <For each={addable()}>
              {(agent) => (
                <button
                  type="button"
                  class={styles.addPick}
                  disabled={busy()}
                  onClick={() => edit(idsAfterAdd(ids(), agent.id))}
                  data-testid={`panel-add-pick-${agent.name}`}
                >
                  <Face face={agent.face} image={agent.faceImage} size={20} />
                  <span class={styles.addPickName}>
                    <AgentName id={agent.id} name={agent.name} />
                  </span>
                  <Show when={agent.role}>
                    <span class={styles.memberRole}>{agent.role}</span>
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      </Show>
      <Show
        when={data().members.length > 0}
        fallback={<p class={styles.hint}>{t("channels.noWork")}</p>}
      >
        <For each={data().members}>
          {(member) => {
            const agent = () => agents.byId(member.agentId)
            return (
              <Show when={agent()}>
                {(a) => (
                  <div class={styles.card} data-testid="member-card" data-state={member.state}>
                    <div class={styles.cardHead}>
                      {/* The face and the name open the profile of the member (spec 004). */}
                      <ProfileButton agent={a()} class={styles.cardProfile} testId="member-profile">
                        <Face face={a().face} image={a().faceImage} size={24} agentId={a().id} />
                        <span class={styles.cardName}>
                          <AgentName id={a().id} name={a().name} />
                        </span>
                      </ProfileButton>
                      <span class={styles.cardState} data-testid="member-state">
                        {t(stateLabel(member.state))}
                      </span>
                      <Show when={ui.canChange()}>
                        <IconButton
                          label={t("channels.panel.remove", { name: a().name })}
                          disabled={busy()}
                          onClick={() => edit(idsAfterRemove(ids(), a().id))}
                          data-testid={`panel-remove-${a().name}`}
                        >
                          <X size={12} />
                        </IconButton>
                      </Show>
                    </div>
                    {/* The tokens of the whole job, for the lead (spec 005, "Usage of a task"). */}
                    <Show when={member.usage}>
                      {(usage) => (
                        <div
                          class={styles.cardUsage}
                          data-testid="lead-usage"
                          data-input={usage().input ?? ""}
                          data-output={usage().output ?? ""}
                        >
                          {t("taskUsage.lead", { line: usageLine(t, locale(), usage()) })}
                        </div>
                      )}
                    </Show>
                    <Show when={member.steps.length > 0}>
                      <ol class={styles.steps} data-testid="plan-steps">
                        <For each={member.steps}>
                          {(step, index) => {
                            // A running step whose turn is quiet keeps its spinner. Its text label
                            // and its tooltip read the quiet line (spec 004, 005).
                            const quietText = () => {
                              if (step.state !== "running") return undefined
                              const q = quietOfTaskLine(server(), step.taskId)
                              return q ? t("quiet.line", { name: q.name, time: q.time }) : undefined
                            }
                            return (
                              <li
                                class={styles.step}
                                data-state={step.state}
                                data-quiet={quietText() ? "true" : undefined}
                                data-testid="plan-step"
                                style={{ "--i": Math.min(index(), MAX_STAGGER) }}
                              >
                                {/* Keyed, so each new state puts a new icon in and the motion plays. */}
                                <Show when={step.state} keyed>
                                  {(state) => {
                                    const view = stepIcon(state)
                                    return (
                                      <span
                                        class={styles.stepIcon}
                                        role="img"
                                        aria-label={quietText() ?? t(view.key as never)}
                                        title={quietText()}
                                        data-testid="plan-step-icon"
                                      >
                                        {view.icon}
                                      </span>
                                    )
                                  }}
                                </Show>
                                <span class={styles.stepLabel}>{step.label}</span>
                                <Show when={step.state === "running" || step.state === "queued"}>
                                  <IconButton
                                    label={t("channels.step.stop")}
                                    onClick={() => call("tasks.stop", { id: step.taskId })}
                                    data-testid="step-stop"
                                  >
                                    <X size={12} />
                                  </IconButton>
                                </Show>
                              </li>
                            )
                          }}
                        </For>
                      </ol>
                    </Show>
                  </div>
                )}
              </Show>
            )
          }}
        </For>
      </Show>
    </div>
  )
}
