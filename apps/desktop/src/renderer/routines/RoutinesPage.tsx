import {
  type Agent,
  type MessageKey,
  type Routine,
  type RoutineEntry,
  type RoutineInput,
  runTimes,
  type Schedule,
  validSchedule,
} from "@robot/shared"
import { createMemo, createResource, createSignal, For, Index, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useChannels } from "../state/channels.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Segmented, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import styles from "./routines.module.css"

const DAYS = [0, 1, 2, 3, 4, 5, 6] as const
type Kind = Schedule["kind"]
const KINDS: readonly Kind[] = ["once", "every", "daily", "weekly", "cron"]

const pad = (n: number) => String(n).padStart(2, "0")
const toLocalInput = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The next run times in words: "Mon, Mar 2, 9:00 AM". */
const useFormat = () => {
  const app = useApp()
  return (at: number) =>
    new Intl.DateTimeFormat(app.locale(), { dateStyle: "medium", timeStyle: "short" }).format(at)
}

const useScheduleWords = () => {
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

const RoutineDialog = (props: { routine?: Routine; onClose: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const channels = useChannels()
  const format = useFormat()
  const initial = props.routine?.schedule
  const [name, setName] = createSignal(props.routine?.name ?? "")
  const [prompt, setPrompt] = createSignal(props.routine?.prompt ?? "")
  const [agentId, setAgentId] = createSignal(props.routine?.agentId ?? agents.agents()[0]?.id ?? "")
  const [place, setPlace] = createSignal(
    props.routine?.place.kind === "channel" ? props.routine.place.channelId : "agent",
  )
  const [kind, setKind] = createSignal<Kind>(initial?.kind ?? "daily")
  const [at, setAt] = createSignal(
    toLocalInput(initial?.kind === "once" ? initial.at : Date.now() + 3_600_000),
  )
  const [minutes, setMinutes] = createSignal(initial?.kind === "every" ? initial.minutes : 30)
  const [times, setTimes] = createSignal(
    initial?.kind === "daily" ? initial.times.join(", ") : "09:00",
  )
  const [days, setDays] = createSignal<number[]>(
    initial?.kind === "weekly" ? [...initial.days] : [1],
  )
  const [time, setTime] = createSignal(initial?.kind === "weekly" ? initial.time : "09:00")
  const [expr, setExpr] = createSignal(initial?.kind === "cron" ? initial.expr : "0 9 * * 1-5")
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)

  const schedule = createMemo((): Schedule => {
    switch (kind()) {
      case "once":
        return { kind: "once", at: new Date(at()).getTime() }
      case "every":
        return {
          kind: "every",
          minutes: minutes(),
          from: props.routine?.schedule.kind === "every" ? props.routine.schedule.from : Date.now(),
        }
      case "daily":
        return {
          kind: "daily",
          times: times()
            .split(/[,\s]+/)
            .filter(Boolean),
        }
      case "weekly":
        return { kind: "weekly", days: days(), time: time() }
      case "cron":
        return { kind: "cron", expr: expr() }
    }
  })
  const valid = () => validSchedule(schedule())
  const preview = () => (valid() ? runTimes(schedule(), Date.now(), 3) : [])
  const memberChannels = () => channels.channels().filter((c) => c.memberIds.includes(agentId()))
  const canSave = () => name().trim() && prompt().trim() && agentId() && valid() && !busy()

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    const serverId = ui.server()?.id
    if (!serverId || !canSave()) return
    setBusy(true)
    setError(undefined)
    const input: RoutineInput = {
      serverId,
      agentId: agentId(),
      name: name().trim(),
      prompt: prompt(),
      schedule: schedule(),
      place: place() === "agent" ? { kind: "agent" } : { kind: "channel", channelId: place() },
    }
    try {
      if (props.routine) {
        const { serverId: _s, ...patch } = input
        await call("routines.update", { id: props.routine.id, patch })
      } else await call("routines.create", input)
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog label={t("routines.dialog.title")} onClose={props.onClose} testId="routine-dialog">
      <form class={styles.form} onSubmit={submit}>
        <h2 class={styles.title}>{props.routine ? t("routines.edit") : t("routines.new")}</h2>
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

        <div class={styles.field}>
          <span>{t("routines.field.schedule")}</span>
          <select
            class={styles.input}
            value={kind()}
            onChange={(e) => setKind(e.currentTarget.value as Kind)}
            aria-label={t("routines.field.schedule")}
            data-testid="routine-kind"
          >
            <For each={KINDS}>
              {(k) => <option value={k}>{t(`routines.kind.${k}` as MessageKey)}</option>}
            </For>
          </select>
          <Show when={kind() === "once"}>
            <input
              class={styles.input}
              type="datetime-local"
              value={at()}
              onInput={(e) => setAt(e.currentTarget.value)}
              data-testid="routine-at"
            />
          </Show>
          <Show when={kind() === "every"}>
            <label class={styles.inline}>
              {t("routines.every")}
              <input
                class={styles.input}
                type="number"
                min="1"
                value={minutes()}
                onInput={(e) => setMinutes(Number(e.currentTarget.value))}
                data-testid="routine-minutes"
              />
              {t("routines.minutes")}
            </label>
          </Show>
          <Show when={kind() === "daily"}>
            <input
              class={styles.input}
              value={times()}
              onInput={(e) => setTimes(e.currentTarget.value)}
              aria-label={t("routines.times")}
              placeholder="09:00, 18:30"
              data-testid="routine-times"
            />
            <span class={styles.hint}>{t("routines.times.hint")}</span>
          </Show>
          <Show when={kind() === "weekly"}>
            <div class={styles.days}>
              <For each={DAYS}>
                {(d) => (
                  <button
                    type="button"
                    class={styles.day}
                    aria-pressed={days().includes(d)}
                    onClick={() =>
                      setDays(days().includes(d) ? days().filter((x) => x !== d) : [...days(), d])
                    }
                    data-testid={`routine-day-${d}`}
                  >
                    {new Intl.DateTimeFormat(useApp().locale(), { weekday: "short" }).format(
                      new Date(2026, 2, 1 + d),
                    )}
                  </button>
                )}
              </For>
            </div>
            <input
              class={styles.input}
              value={time()}
              onInput={(e) => setTime(e.currentTarget.value)}
              aria-label={t("routines.time")}
              data-testid="routine-time"
            />
          </Show>
          <Show when={kind() === "cron"}>
            <input
              class={styles.input}
              value={expr()}
              onInput={(e) => setExpr(e.currentTarget.value)}
              aria-label={t("routines.kind.cron")}
              data-testid="routine-cron"
            />
            <span class={styles.hint}>{t("routines.cron.hint")}</span>
          </Show>
        </div>

        <div class={styles.field} data-testid="routine-preview">
          <span>{t("routines.next")}</span>
          <Show
            when={preview().length > 0}
            fallback={
              <span class={styles.hint}>
                {valid() ? t("routines.next.none") : t("routines.next.invalid")}
              </span>
            }
          >
            <ul class={styles.list}>
              <For each={preview()}>{(at) => <li>{format(at)}</li>}</For>
            </ul>
          </Show>
        </div>

        <Show when={error()}>
          {(err) => (
            <div class={styles.error} role="alert" data-testid="routine-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose}>{t("agents.cancel")}</Button>
          <Button variant="primary" type="submit" disabled={!canSave()} data-testid="routine-save">
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
  const ui = useUi()
  const format = useFormat()
  const words = useScheduleWords()
  const [editing, setEditing] = createSignal<Routine | "new">()
  const [mode, setMode] = createSignal<"list" | "week" | "month">("list")
  const [anchor, setAnchor] = createSignal(new Date())
  const [routines, { refetch }] = createResource(
    () => ui.server()?.id,
    (serverId) => call("routines.list", { serverId }),
    { initialValue: [] },
  )
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
              <div class={styles.card} data-testid="routine-card" data-enabled={r.enabled}>
                <div class={styles.cardMain}>
                  <strong>{r.name}</strong>
                  <span class={styles.hint}>
                    {r.agentName} · {words(r.schedule)}
                  </span>
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
                <Button
                  onClick={() => call("routines.runNow", { id: r.id })}
                  data-testid="routine-run"
                >
                  {t("routines.runNow")}
                </Button>
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
          return (
            <RoutineDialog
              {...(current && current !== "new" ? { routine: current } : {})}
              onClose={() => setEditing(undefined)}
            />
          )
        }}
      </Presence>
    </div>
  )
}
