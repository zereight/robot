import {
  type Agent,
  type AgentModel,
  catalogues,
  isRuntimeKind,
  type MessageKey,
  programName,
  programReportsTokens,
  ROUTINES_MAX,
  type Routine,
  type RoutineEntry,
  type RoutineInput,
  type Schedule,
  validSchedule,
  validTokenLimit,
  validWatch,
  type Watch,
  watchNeedsConfirm,
} from "@robot/shared"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Index,
  onCleanup,
  Show,
} from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { showRevealed } from "../lib/reveal.ts"
import { call } from "../lib/rpc.ts"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useChannels } from "../state/channels.tsx"
import { useProviders } from "../state/providers.tsx"
import { flashRow, openTarget, takeTarget } from "../state/target.ts"
import { useUi } from "../state/ui.tsx"
import { usageLine } from "../tasks/usageText.ts"
import { Button, Segmented, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./routines.module.css"
import { ScheduleFields } from "./ScheduleFields.tsx"
import { useIntervalWords, WatchFields } from "./WatchFields.tsx"

/** The next run times in words: "Mon, Mar 2, 9:00 AM". */
const useFormat = () => {
  const app = useApp()
  return (at: number) =>
    new Intl.DateTimeFormat(app.locale(), { dateStyle: "medium", timeStyle: "short" }).format(at)
}

/** The text key of the reason of a failure. An unknown code reads as an unknown failure. */
const reasonKey = (code: string): MessageKey => {
  const key = `error.${code}`
  return (key in catalogues.en ? key : "error.unknown") as MessageKey
}

export const useScheduleWords = () => {
  const { t } = useApp()
  const app = useApp()
  const dayName = (d: number) =>
    new Intl.DateTimeFormat(app.locale(), { weekday: "short" }).format(new Date(2026, 2, 1 + d))
  return (s: Schedule) => {
    switch (s.kind) {
      case "once":
        return t("routines.words.once", {
          time: new Intl.DateTimeFormat(app.locale(), {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(s.at),
        })
      case "every":
        return s.minutes % 60 === 0
          ? t("routines.words.everyHours", { n: s.minutes / 60 })
          : t("routines.words.everyMinutes", { n: s.minutes })
      case "daily":
        return t("routines.words.daily", { times: s.times.join(", ") })
      case "weekly":
        return t("routines.words.weekly", {
          days: [...s.days].sort().map(dayName).join(", "),
          time: s.time,
        })
      case "cron":
        return t("routines.words.cron", { expr: s.expr })
    }
  }
}

const RoutineDialog = (props: { routine?: Routine; full?: boolean; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const channels = useChannels()
  const providers = useProviders()
  const _format = useFormat()
  const initial = props.routine?.schedule
  const [name, setName] = createSignal(props.routine?.name ?? "")
  const [prompt, setPrompt] = createSignal(props.routine?.prompt ?? "")
  const [agentId, setAgentId] = createSignal(props.routine?.agentId ?? agents.agents()[0]?.id ?? "")
  const [place, setPlace] = createSignal(
    props.routine?.place.kind === "channel" ? props.routine.place.channelId : "agent",
  )
  const initialWatch = props.routine?.watch ?? undefined
  const [trigger, setTrigger] = createSignal<"schedule" | "watch">(
    initialWatch ? "watch" : "schedule",
  )
  const [schedule, setSchedule] = createSignal<Schedule>(
    initial ?? { kind: "daily", times: ["09:00"] },
  )
  const [valid, setValid] = createSignal(initial ? validSchedule(initial) : true)
  const [watch, setWatch] = createSignal<Watch | undefined>(initialWatch)
  const [watchValid, setWatchValid] = createSignal(initialWatch ? validWatch(initialWatch) : false)
  const [ownModel, setOwnModel] = createSignal(props.routine?.model != null)
  const [model, setModel] = createSignal<AgentModel | null>(props.routine?.model ?? null)
  // The token limit of one run (spec 009). The box holds the text; empty means no limit.
  const [limitText, setLimitText] = createSignal(
    props.routine?.tokenLimit == null ? "" : String(props.routine.tokenLimit),
  )
  // A watch on a command or a tool runs at each check with no question: the user confirms.
  const [confirming, setConfirming] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)

  const memberChannels = () => channels.channels().filter((c) => c.memberIds.includes(agentId()))
  const triggerValid = () => (trigger() === "watch" ? watchValid() : valid())
  // A server holds at most 50 routines, a paused one too. The form for a new routine says so and
  // does not save (spec 009). The main process refuses it as well, in case the list is old.
  const atLimit = () => props.routine === undefined && props.full === true
  // The limit is a whole number from 1,000 to 10,000,000, or nothing (spec 009).
  const limitValue = (): number | null | "invalid" => {
    const text = limitText().trim().replaceAll(",", "")
    if (text === "") return null
    const n = Number(text)
    return validTokenLimit(n) ? n : "invalid"
  }
  // The program that answers the run: the model of the routine, or the model of the agent. An API
  // model reports tokens as the reply streams. A program reports them at the end of a turn, and one
  // that reports none cannot use the limit (spec 009).
  const program = () => {
    const accountId = ownModel()
      ? model()?.accountId
      : agents.agents().find((a) => a.id === agentId())?.model?.accountId
    const kind = accountId ? providers.byId(accountId)?.kind : undefined
    return kind && isRuntimeKind(kind) ? kind : null
  }
  const limitOff = () => {
    const kind = program()
    return kind !== null && !programReportsTokens(kind)
  }
  const canSave = () =>
    !atLimit() &&
    (limitOff() || limitValue() !== "invalid") &&
    name().trim() &&
    prompt().trim() &&
    agentId() &&
    triggerValid() &&
    (!ownModel() || model() !== null) &&
    !busy()

  const save = async () => {
    const serverId = ui.server()?.id
    if (!serverId || !canSave()) return
    setBusy(true)
    setError(undefined)
    const w = watch()
    const input: RoutineInput = {
      serverId,
      agentId: agentId(),
      name: name().trim(),
      prompt: prompt(),
      ...(trigger() === "watch" && w ? { watch: w } : { schedule: schedule() }),
      place: place() === "agent" ? { kind: "agent" } : { kind: "channel", channelId: place() },
      model: ownModel() ? model() : null,
      // A program that reports no tokens cannot use the limit: the field is off and sends none.
      tokenLimit: limitOff()
        ? null
        : limitValue() === "invalid"
          ? null
          : (limitValue() as number | null),
    }
    try {
      if (props.routine) {
        const { serverId: _s, ...patch } = input
        await call("routines.update", { id: props.routine.id, patch })
      } else await call("routines.create", input)
      props.onClose()
    } catch (e) {
      setError(describeError(e))
      setConfirming(false)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!canSave()) return
    const w = watch()
    if (trigger() === "watch" && w && watchNeedsConfirm(w) && !confirming()) {
      setConfirming(true)
      return
    }
    await save()
  }

  const agentName = () => agents.agents().find((a) => a.id === agentId())?.name ?? ""

  return (
    <Dialog label={t("routines.dialog.title")} onClose={props.onClose} testId="routine-dialog">
      <form class={styles.form} onSubmit={submit}>
        <h2 class={styles.title}>{props.routine ? t("routines.edit") : t("routines.new")}</h2>
        {/* At the top, where the eye is: the form is long and scrolls. */}
        <Show when={atLimit()}>
          <div class={styles.error} role="alert" data-testid="routine-full">
            {t("error.routines_full", { detail: String(ROUTINES_MAX) })}
          </div>
        </Show>
        <label class={styles.field}>
          <span>{t("routines.field.name")}</span>
          <input
            class={styles.input}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            data-testid="routine-name"
          />
        </label>
        <label class={styles.field}>
          <span>{t("routines.field.agent")}</span>
          <select
            class={styles.input}
            value={agentId()}
            onChange={(e) => {
              setAgentId(e.currentTarget.value)
              setPlace("agent")
            }}
            data-testid="routine-agent"
          >
            <For each={agents.agents()}>{(a: Agent) => <option value={a.id}>{a.name}</option>}</For>
          </select>
        </label>
        <label class={styles.field}>
          <span>{t("routines.field.prompt")}</span>
          <textarea
            class={styles.input}
            rows={3}
            value={prompt()}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            data-testid="routine-prompt"
          />
        </label>
        <label class={styles.field}>
          <span>{t("routines.field.place")}</span>
          <select
            class={styles.input}
            value={place()}
            onChange={(e) => setPlace(e.currentTarget.value)}
            data-testid="routine-place"
          >
            <option value="agent">{t("routines.place.agent")}</option>
            <For each={memberChannels()}>{(c) => <option value={c.id}>{c.name}</option>}</For>
          </select>
        </label>

        <label class={styles.field}>
          <span>{t("routines.field.trigger")}</span>
          <select
            class={styles.input}
            value={trigger()}
            onChange={(e) => setTrigger(e.currentTarget.value as "schedule" | "watch")}
            data-testid="routine-trigger"
          >
            <option value="schedule">{t("routines.trigger.schedule")}</option>
            <option value="watch">{t("routines.trigger.watch")}</option>
          </select>
        </label>
        <Show
          when={trigger() === "watch"}
          fallback={
            <ScheduleFields
              {...(initial ? { initial } : {})}
              onChange={(next, ok) => {
                setSchedule(next)
                setValid(ok)
              }}
            />
          }
        >
          <WatchFields
            {...(initialWatch ? { initial: initialWatch } : {})}
            onChange={(next, ok) => {
              setWatch(next)
              setWatchValid(ok)
              setConfirming(false)
            }}
          />
        </Show>

        <div class={styles.field}>
          <span>{t("routines.model")}</span>
          <select
            class={styles.input}
            value={ownModel() ? "own" : "same"}
            onChange={(e) => setOwnModel(e.currentTarget.value === "own")}
            data-testid="routine-model-mode"
          >
            <option value="same">{t("routines.model.same")}</option>
            <option value="own">{t("routines.model.own")}</option>
          </select>
          <Show when={ownModel()}>
            <ModelPicker value={model()} onChange={setModel} />
          </Show>
        </div>

        {/* The most tokens one run may use. Off by default (spec 009, "Limits and safeguards"). */}
        <label class={styles.field}>
          <span>{t("routines.tokenLimit")}</span>
          <input
            class={styles.input}
            type="text"
            inputmode="numeric"
            value={limitOff() ? "" : limitText()}
            disabled={limitOff()}
            aria-invalid={!limitOff() && limitValue() === "invalid"}
            onInput={(e) => setLimitText(e.currentTarget.value)}
            data-testid="routine-token-limit"
          />
          <Show
            when={limitOff() && program()}
            fallback={
              <>
                <span class={styles.hint} data-testid="routine-token-limit-hint">
                  {t("routines.tokenLimit.hint")}
                </span>
                <Show when={program()}>
                  {(kind) => (
                    <span class={styles.hint} data-testid="routine-token-limit-late">
                      {t("routines.tokenLimit.late", { program: programName(kind()) })}
                    </span>
                  )}
                </Show>
              </>
            }
          >
            {(kind) => (
              <span class={styles.hint} data-testid="routine-token-limit-silent">
                {t("routines.tokenLimit.silent", { program: programName(kind()) })}
              </span>
            )}
          </Show>
          <Show when={!limitOff() && limitValue() === "invalid"}>
            <span class={styles.error} role="alert" data-testid="routine-token-limit-error">
              {t("error.invalid_token_limit")}
            </span>
          </Show>
        </label>

        <Show when={confirming() ? watch() : undefined}>
          {(w) => (
            <div class={styles.confirm} role="alert" data-testid="routine-confirm">
              <strong>{t("routines.confirm.title")}</strong>
              <Show
                when={w().target.kind === "command" ? w().target : undefined}
                fallback={
                  <>
                    <span>{t("routines.confirm.tool")}</span>
                    <Show when={w().target.kind === "tool" ? w().target : undefined}>
                      {(target) => {
                        const tool = target() as Extract<Watch["target"], { kind: "tool" }>
                        return (
                          <pre class={styles.code} data-testid="routine-confirm-target">
                            {[
                              t("routines.confirm.connection", { name: tool.connection }),
                              t("routines.confirm.toolName", { name: tool.tool }),
                              t("routines.confirm.args", { args: tool.args }),
                            ].join("\n")}
                          </pre>
                        )
                      }}
                    </Show>
                  </>
                }
              >
                {(target) => (
                  <>
                    <span>{t("routines.confirm.command", { agent: agentName() })}</span>
                    <pre class={styles.code} data-testid="routine-confirm-target">
                      {(target() as Extract<Watch["target"], { kind: "command" }>).command}
                    </pre>
                  </>
                )}
              </Show>
              <div class={styles.actions}>
                <Button onClick={() => setConfirming(false)} data-testid="routine-confirm-back">
                  {t("routines.confirm.back")}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void save()}
                  disabled={!canSave()}
                  data-testid="routine-confirm-ok"
                >
                  {t("routines.confirm.ok")}
                </Button>
              </div>
            </div>
          )}
        </Show>

        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="routine-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose}>{t("agents.cancel")}</Button>
          <Button
            variant="primary"
            type="submit"
            disabled={!canSave() || confirming()}
            data-testid="routine-save"
          >
            {t("agents.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

const startOfWeek = (ms: number) => {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - d.getDay())
  return d
}

const Calendar = (props: {
  entries: readonly RoutineEntry[]
  mode: "week" | "month"
  anchor: Date
}) => {
  const { t } = useApp()
  const app = useApp()
  const days = createMemo(() => {
    const first =
      props.mode === "week"
        ? startOfWeek(props.anchor.getTime())
        : startOfWeek(new Date(props.anchor.getFullYear(), props.anchor.getMonth(), 1).getTime())
    const count =
      props.mode === "week"
        ? 7
        : Math.ceil(
            (new Date(props.anchor.getFullYear(), props.anchor.getMonth() + 1, 0).getDate() +
              new Date(props.anchor.getFullYear(), props.anchor.getMonth(), 1).getDay()) /
              7,
          ) * 7
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(first)
      d.setDate(first.getDate() + i)
      return d
    })
  })
  const entriesOf = (day: Date) =>
    props.entries.filter((e) => {
      const d = new Date(e.at)
      return (
        d.getFullYear() === day.getFullYear() &&
        d.getMonth() === day.getMonth() &&
        d.getDate() === day.getDate()
      )
    })
  const time = (at: number) =>
    new Intl.DateTimeFormat(app.locale(), { hour: "numeric", minute: "2-digit" }).format(at)
  return (
    <div class={styles.calendar} data-mode={props.mode} data-testid="routine-calendar">
      <Index each={days()}>
        {(day) => (
          <div
            class={styles.dayCell}
            data-today={day().toDateString() === new Date().toDateString()}
          >
            <div class={styles.dayHead}>
              {new Intl.DateTimeFormat(app.locale(), {
                weekday: props.mode === "week" ? "short" : undefined,
                day: "numeric",
                month: props.mode === "week" ? undefined : undefined,
              }).format(day())}
            </div>
            <For each={entriesOf(day())}>
              {(e) => (
                <div class={styles.entry} data-state={e.state} data-testid="calendar-entry">
                  <span>{time(e.at)}</span> <span>{e.routineName}</span>{" "}
                  <span class={styles.entryState}>
                    {t(`routines.state.${e.state}` as MessageKey)}
                  </span>
                  <Show when={e.reason}>
                    {(reason) => (
                      <span class={styles.entryReason} data-testid="calendar-reason">
                        {" "}
                        {t(reasonKey(reason().code), { detail: reason().detail })}
                      </span>
                    )}
                  </Show>
                  {/* The run details (spec 005, 009): the tokens of all tasks of the run, and the line at
                      80 percent of its token limit. */}
                  <Show when={e.usage || e.limit?.near}>
                    <div class={styles.entryDetails} data-testid="calendar-run-details">
                      <Show when={e.usage}>
                        {(usage) => (
                          <div
                            data-testid="calendar-run-tokens"
                            data-input={usage().input ?? ""}
                            data-output={usage().output ?? ""}
                          >
                            {t("routines.runTokens", {
                              line: usageLine(t, app.locale(), usage()),
                            })}
                          </div>
                        )}
                      </Show>
                      <Show when={e.limit?.near}>
                        <div data-testid="calendar-limit-near">{t("routines.limitNear")}</div>
                      </Show>
                    </div>
                  </Show>
                  <Show when={e.change}>
                    {(change) => (
                      <details class={styles.entryChange} data-testid="calendar-change">
                        <summary>{t("routines.recorded.change")}</summary>
                        <pre>{change()}</pre>
                      </details>
                    )}
                  </Show>
                </div>
              )}
            </For>
          </div>
        )}
      </Index>
    </div>
  )
}

export const RoutinesView = () => {
  const { t } = useApp()
  const app = useApp()
  const ui = useUi()
  const format = useFormat()
  const words = useScheduleWords()
  const intervalWords = useIntervalWords()
  const [editing, setEditing] = createSignal<Routine | "new">()
  const [mode, setMode] = createSignal<"list" | "week" | "month">("list")
  const [anchor, setAnchor] = createSignal(new Date())
  const [routines, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId) => call("routines.list", { serverId }),
    { initialValue: [] },
  )
  // The Today page asks for a routine: its card lights up. A routine that is gone is dropped.
  createEffect(() => {
    const target = openTarget()
    const list = routines()
    if (target?.kind !== "routine" || routines.loading) return
    if (list.some((r) => r.id === target.id)) {
      queueMicrotask(() => {
        if (flashRow(`[data-routine-id="${target.id}"]`)) takeTarget("routine")
      })
    } else takeTarget("routine")
  })
  const range = () => {
    const a = anchor()
    return mode() === "week"
      ? {
          from: startOfWeek(a.getTime()).getTime(),
          to: startOfWeek(a.getTime()).getTime() + 7 * 86_400_000 - 1,
        }
      : {
          from: new Date(a.getFullYear(), a.getMonth() - 0, 1).getTime() - 7 * 86_400_000,
          to: new Date(a.getFullYear(), a.getMonth() + 1, 1).getTime() + 7 * 86_400_000,
        }
  }
  const [entries, { refetch: refetchEntries }] = createResource(
    () => (mode() === "list" ? undefined : { serverId: ui.server()?.id, ...range() }),
    (input) =>
      input.serverId
        ? call("routines.calendar", { serverId: input.serverId, from: input.from, to: input.to })
        : [],
    { initialValue: [] },
  )
  onCleanup(
    window.robot.on("routines.changed", () => {
      void refetch()
      void refetchEntries()
    }),
  )
  onCleanup(window.robot.on("tasks.changed", () => void refetchEntries()))
  // A checklist item asked for one routine: show its card in the list and focus its switch.
  createEffect(() => {
    const target = ui.revealTarget()
    if (target?.kind !== "routine") return
    setMode("list")
    if (!routines().some((r) => r.id === target.id)) return
    queueMicrotask(() => {
      const card = document.querySelector<HTMLElement>(`[data-routine-id="${target.id}"]`)
      if (card) showRevealed(card, "routine-enabled")
      ui.clearReveal()
    })
  })
  const shift = (dir: number) => {
    const a = new Date(anchor())
    if (mode() === "week") a.setDate(a.getDate() + 7 * dir)
    else a.setMonth(a.getMonth() + dir)
    setAnchor(a)
  }

  return (
    <div class={styles.page} data-testid="routines-view">
      <div class={styles.bar}>
        <Segmented
          label={t("routines.view")}
          value={mode()}
          options={[
            { value: "list", label: t("routines.view.list") },
            { value: "week", label: t("routines.view.week") },
            { value: "month", label: t("routines.view.month") },
          ]}
          onChange={setMode}
          testId="routine-view"
        />
        <Show when={mode() !== "list"}>
          <Button onClick={() => shift(-1)} data-testid="calendar-prev">
            {t("routines.prev")}
          </Button>
          <Button onClick={() => shift(1)} data-testid="calendar-next">
            {t("routines.nextPeriod")}
          </Button>
        </Show>
        <Button variant="primary" onClick={() => setEditing("new")} data-testid="routine-new">
          {t("routines.new")}
        </Button>
      </div>

      <Show
        when={mode() === "list"}
        fallback={
          <Calendar entries={entries()} mode={mode() as "week" | "month"} anchor={anchor()} />
        }
      >
        <Show
          when={routines().length > 0}
          fallback={
            <p class={styles.hint} data-testid="routines-empty">
              {t("routines.empty")}
            </p>
          }
        >
          <For each={routines()}>
            {(r) => (
              <div
                class={styles.card}
                data-testid="routine-card"
                data-routine-id={r.id}
                data-enabled={r.enabled}
              >
                <div class={styles.cardMain}>
                  <strong>{r.name}</strong>
                  <span class={styles.hint}>
                    {r.agentName} ·{" "}
                    {r.watch
                      ? t("routines.words.watch", { interval: intervalWords(r.watch.minutes) })
                      : r.schedule
                        ? words(r.schedule)
                        : ""}
                  </span>
                  <Show when={r.tokenLimit}>
                    {(limit) => (
                      <span class={styles.hint} data-testid="routine-limit-line">
                        {t("routines.tokenLimit.card", {
                          count: new Intl.NumberFormat(app.locale()).format(limit()),
                        })}
                      </span>
                    )}
                  </Show>
                  <Show when={r.pausedAfterFailures}>
                    {(reason) => (
                      <span class={styles.paused} data-testid="routine-paused">
                        {t("routines.paused")} ·{" "}
                        {t(reasonKey(reason().code), { detail: reason().detail })}
                      </span>
                    )}
                  </Show>
                  <Show when={r.nextCheck}>
                    {(at) => (
                      <span class={styles.hint} data-testid="routine-next-check">
                        {t("routines.nextCheck")}: {format(at())}
                      </span>
                    )}
                  </Show>
                  <Show when={r.runsOn !== null}>
                    <span class={styles.hint} data-testid="routine-runs-on">
                      {t("sync.runsOn", { name: r.runsOn || t("sync.anotherComputer") })}
                    </span>
                  </Show>
                  <Show when={r.nextRuns.length > 0}>
                    <span class={styles.hint} data-testid="routine-next">
                      {t("routines.next")}: {r.nextRuns.map(format).join(" / ")}
                    </span>
                  </Show>
                </div>
                <Switch
                  label={t("routines.enabled")}
                  checked={r.enabled}
                  onChange={(enabled) => call("routines.update", { id: r.id, patch: { enabled } })}
                  testId="routine-enabled"
                />
                <Show
                  when={r.runsOn === null}
                  fallback={
                    <Button
                      onClick={() => call("routines.runHere", { id: r.id })}
                      data-testid="routine-run-here"
                    >
                      {t("sync.runHere")}
                    </Button>
                  }
                >
                  <Button
                    onClick={() => call("routines.runNow", { id: r.id })}
                    data-testid="routine-run"
                  >
                    {t("routines.runNow")}
                  </Button>
                </Show>
                <Button onClick={() => setEditing(r)} data-testid="routine-edit">
                  {t("agents.memory.edit")}
                </Button>
                <Button
                  onClick={() => call("routines.delete", { id: r.id })}
                  data-testid="routine-delete"
                >
                  {t("agents.memory.delete")}
                </Button>
              </div>
            )}
          </For>
        </Show>
      </Show>

      <Presence when={editing() !== undefined}>
        {() => {
          const current = editing()
          // Read once, when the form opens: saving the last free place must not make the form
          // say "full" while it closes.
          const full = routines().length >= ROUTINES_MAX
          return (
            <RoutineDialog
              {...(current && current !== "new" ? { routine: current } : {})}
              full={full}
              onClose={() => setEditing(undefined)}
            />
          )
        }}
      </Presence>
    </div>
  )
}
