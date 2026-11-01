import { type MessageKey, runTimes, type Schedule, validSchedule } from "@robot/shared"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
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

/** The fields of a schedule, with the next three run times. Reports each change. */
export const ScheduleFields = (props: {
  initial?: Schedule
  onChange: (schedule: Schedule, valid: boolean) => void
}) => {
  const { t } = useApp()
  const format = useFormat()
  const initial = props.initial
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

  const schedule = createMemo((): Schedule => {
    switch (kind()) {
      case "once":
        return { kind: "once", at: new Date(at()).getTime() }
      case "every":
        return {
          kind: "every",
          minutes: minutes(),
          from: initial?.kind === "every" ? initial.from : Date.now(),
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
  createEffect(() => props.onChange(schedule(), valid()))

  return (
    <>
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
    </>
  )
}
