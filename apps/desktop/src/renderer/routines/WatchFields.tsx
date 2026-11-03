import {
  checksPerDay,
  type MessageKey,
  validWatch,
  WATCH_INTERVALS,
  type Watch,
  type WatchTarget,
  watchArgs,
} from "@robot/shared"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useApp } from "../state/app.tsx"
import { Switch } from "../ui/controls.tsx"
import styles from "./routines.module.css"

type Kind = WatchTarget["kind"]
const KINDS: readonly Kind[] = ["path", "command", "tool"]

/** The words of an interval: "5 minutes", "1 hour", "6 hours", "1 day". */
export const useIntervalWords = () => {
  const { t } = useApp()
  return (minutes: number) =>
    minutes === 1440
      ? t("routines.interval.day")
      : minutes === 60
        ? t("routines.interval.hour")
        : minutes % 60 === 0
          ? t("routines.interval.hours", { n: minutes / 60 })
          : t("routines.interval.minutes", { n: minutes })
}

/** The fields of a watch (spec 009, "Watch"). Reports each change. */
export const WatchFields = (props: {
  initial?: Watch
  onChange: (watch: Watch, valid: boolean) => void
}) => {
  const { t } = useApp()
  const words = useIntervalWords()
  const initial = props.initial
  const target = initial?.target
  const [minutes, setMinutes] = createSignal<number>(initial?.minutes ?? 60)
  const [kind, setKind] = createSignal<Kind>(target?.kind ?? "path")
  const [path, setPath] = createSignal(target?.kind === "path" ? target.path : "")
  const [command, setCommand] = createSignal(target?.kind === "command" ? target.command : "")
  const [connection, setConnection] = createSignal(target?.kind === "tool" ? target.connection : "")
  const [tool, setTool] = createSignal(target?.kind === "tool" ? target.tool : "")
  const [args, setArgs] = createSignal(target?.kind === "tool" ? target.args : "{}")
  const [postUnchanged, setPostUnchanged] = createSignal(initial?.postUnchanged ?? false)
  const [recordOnly, setRecordOnly] = createSignal(initial?.recordOnly ?? false)

  const watch = createMemo((): Watch => {
    const k = kind()
    const what: WatchTarget =
      k === "path"
        ? { kind: "path", path: path().trim() }
        : k === "command"
          ? { kind: "command", command: command() }
          : { kind: "tool", connection: connection().trim(), tool: tool().trim(), args: args() }
    return {
      minutes: minutes(),
      target: what,
      postUnchanged: postUnchanged(),
      ...(recordOnly() ? { recordOnly: true } : {}),
    }
  })
  createEffect(() => props.onChange(watch(), validWatch(watch())))

  return (
    <>
      <label class={styles.field}>
        <span>{t("routines.watch.interval")}</span>
        <select
          class={styles.input}
          value={String(minutes())}
          onChange={(e) => setMinutes(Number(e.currentTarget.value))}
          data-testid="routine-watch-interval"
        >
          <For each={WATCH_INTERVALS}>
            {(m) => (
              <option value={String(m)} selected={m === minutes()}>
                {words(m)}
              </option>
            )}
          </For>
        </select>
        <Show when={checksPerDay(minutes()) > 96}>
          <span class={styles.hint} data-testid="routine-watch-often">
            {t("routines.watch.often", { n: checksPerDay(minutes()) })}
          </span>
        </Show>
      </label>
      <div class={styles.field}>
        <span>{t("routines.watch.kind")}</span>
        <select
          class={styles.input}
          value={kind()}
          onChange={(e) => setKind(e.currentTarget.value as Kind)}
          aria-label={t("routines.watch.kind")}
          data-testid="routine-watch-kind"
        >
          <For each={KINDS}>
            {(k) => (
              <option value={k} selected={k === kind()}>
                {t(`routines.watch.kind.${k}` as MessageKey)}
              </option>
            )}
          </For>
        </select>
        <Show when={kind() === "path"}>
          <input
            class={styles.input}
            value={path()}
            onInput={(e) => setPath(e.currentTarget.value)}
            aria-label={t("routines.watch.path")}
            data-testid="routine-watch-path"
          />
          <span class={styles.hint}>{t("routines.watch.path.hint")}</span>
        </Show>
        <Show when={kind() === "command"}>
          <input
            class={styles.input}
            value={command()}
            onInput={(e) => setCommand(e.currentTarget.value)}
            aria-label={t("routines.watch.command")}
            data-testid="routine-watch-command"
          />
          <span class={styles.hint}>{t("routines.watch.command.hint")}</span>
        </Show>
        <Show when={kind() === "tool"}>
          <input
            class={styles.input}
            value={connection()}
            onInput={(e) => setConnection(e.currentTarget.value)}
            aria-label={t("routines.watch.connection")}
            placeholder={t("routines.watch.connection")}
            data-testid="routine-watch-connection"
          />
          <input
            class={styles.input}
            value={tool()}
            onInput={(e) => setTool(e.currentTarget.value)}
            aria-label={t("routines.watch.tool")}
            placeholder={t("routines.watch.tool")}
            data-testid="routine-watch-tool"
          />
          <textarea
            class={styles.input}
            rows={3}
            value={args()}
            onInput={(e) => setArgs(e.currentTarget.value)}
            aria-label={t("routines.watch.args")}
            data-testid="routine-watch-args"
          />
          <Show when={watchArgs(args()) === null}>
            <span class={styles.hint} role="alert">
              {t("routines.watch.args.invalid")}
            </span>
          </Show>
        </Show>
      </div>
      <div class={styles.inline}>
        <Switch
          label={t("routines.watch.postUnchanged")}
          checked={postUnchanged()}
          onChange={setPostUnchanged}
          testId="routine-watch-unchanged"
        />
        <span>{t("routines.watch.postUnchanged")}</span>
      </div>
      <div class={styles.inline}>
        <Switch
          label={t("routines.watch.recordOnly")}
          checked={recordOnly()}
          onChange={setRecordOnly}
          testId="routine-watch-record-only"
        />
        <span>{t("routines.watch.recordOnly")}</span>
      </div>
      <span class={styles.hint}>{t("routines.watch.recordOnlyHint")}</span>
      <span class={styles.hint}>{t("routines.watch.first")}</span>
    </>
  )
}
