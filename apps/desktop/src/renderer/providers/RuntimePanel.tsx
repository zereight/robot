import {
  catalogues,
  type Locale,
  type MessageKey,
  type RuntimeKind,
  type RuntimeLimit,
  type RuntimeStatus,
  runtimeSupport,
} from "@robot/shared"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { isCalendarTime } from "../lib/format.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./providers.module.css"

export const isReady = (status: RuntimeStatus | undefined) => status?.state === "ready"

/** A reset time: the clock time when it is near, the weekday with it when it is not. */
const formatReset = (locale: Locale, at: number, now = Date.now()) =>
  new Intl.DateTimeFormat(
    locale,
    at - now < 20 * 3_600_000
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", hour: "numeric", minute: "2-digit" },
  ).format(at)

/** How often the panel looks again while it is open. */
const REFRESH_MS = 2 * 60_000

const formatClock = (locale: Locale, at: number) =>
  new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" }).format(at)

/** A window that has reset since it was read says nothing true: it is left out. */
export const openLimits = (limits: readonly RuntimeLimit[], now = Date.now()) =>
  limits.filter((limit) => limit.resetsAt === null || limit.resetsAt > now)

/** The state of the program as a tag with text (spec 006). Colour alone is not enough. */
export const RuntimeTag = (props: { status: RuntimeStatus; testId: string }) => {
  const { t } = useApp()
  return (
    <span class={styles.stateTag} data-state={props.status.state} data-testid={props.testId}>
      {t(`runtime.state.${props.status.state}` as MessageKey)}
    </span>
  )
}

/** The tag, the reason when the program needs repair, and the time of the last check. */
export const RuntimeReadiness = (props: { status: RuntimeStatus; prefix: string }) => {
  const { t, locale } = useApp()
  return (
    <div class={styles.stateLine}>
      <RuntimeTag status={props.status} testId={`${props.prefix}-state`} />
      <Show when={props.status.state === "needs_repair" && props.status.reason}>
        {(reason) => (
          <span
            class={`${styles.itemMeta} ${styles.stateText}`}
            data-testid={`${props.prefix}-reason`}
          >
            {t(`runtime.reason.${reason()}` as MessageKey)}
          </span>
        )}
      </Show>
      <Show when={props.status.checkedAt}>
        {(at) => (
          <span
            class={`${styles.itemMeta} ${styles.stateText}`}
            data-testid={`${props.prefix}-checked`}
          >
            {t("runtime.checkedAt", { time: formatClock(locale(), at()) })}
          </span>
        )}
      </Show>
    </div>
  )
}

/** The lines about the plan: its name, how much of each window is used, and when it was read. */
export const RuntimeSummary = (props: { status: RuntimeStatus }) => {
  const { t, locale } = useApp()
  const limits = () => openLimits(props.status.limits)
  const line = (limit: RuntimeLimit) => {
    const percent = Math.round(limit.used * 100)
    if (limit.resetsAt === null || !isCalendarTime(limit.resetsAt))
      return t("runtime.limit.noReset", { window: limit.window, percent })
    const named = `runtime.limit.${limit.window}`
    const key: MessageKey = named in catalogues.en ? (named as MessageKey) : "runtime.limit.other"
    return t(key, {
      window: limit.window,
      percent,
      time: formatReset(locale(), limit.resetsAt),
    })
  }
  return (
    <>
      <Show when={props.status.plan}>
        {(plan) => (
          <div class={styles.itemMeta} data-testid="runtime-plan">
            {t("runtime.plan", { plan: plan() })}
          </div>
        )}
      </Show>
      <For each={limits()}>
        {(limit) => (
          <div class={styles.itemMeta} data-testid="runtime-limit">
            {line(limit)}
          </div>
        )}
      </For>
      <Show when={limits().length > 0 && props.status.limitsAt}>
        {(at) => (
          <div class={styles.itemMeta} data-testid="runtime-limits-at">
            {t("runtime.limits.readAt", { time: formatClock(locale(), at()) })}
          </div>
        )}
      </Show>
    </>
  )
}

/**
 * Shows the vendor program: whether it is here, whether the user is signed in with a
 * subscription, and the buttons to download it and to sign in. `signIn` names a separate sign-in
 * of an account; without it the panel is about the sign-in of the program on this computer.
 */
export const RuntimePanel = (props: {
  kind: RuntimeKind
  signIn?: string | null
  onReady: (ready: boolean) => void
}) => {
  const { t } = useApp()
  const [status, setStatus] = createSignal<RuntimeStatus>()
  const [error, setError] = createSignal<ErrorText>()
  const target = () => ({ kind: props.kind, signIn: props.signIn ?? null })

  const look = async () => {
    setError(undefined)
    try {
      setStatus(await call("runtimes.status", target()))
    } catch (e) {
      setError(describeError(e))
    }
  }
  void look()
  // The usage of the plan changes while the user works elsewhere, so the open panel looks again.
  const timer = setInterval(() => {
    if (status()?.busy === null && !document.hidden) void look()
  }, REFRESH_MS)
  onCleanup(() => clearInterval(timer))
  onCleanup(
    window.robot.on("runtimes.changed", (next) => {
      if (next.kind === props.kind && next.signIn === (props.signIn ?? null)) setStatus(next)
    }),
  )
  createEffect(() => props.onReady(isReady(status())))

  const act = async (method: "runtimes.install" | "runtimes.signIn" | "runtimes.repair") => {
    setError(undefined)
    try {
      setStatus(await call(method, target()))
    } catch (e) {
      setError(describeError(e))
    }
  }
  const cancel = () => void call("runtimes.cancel", target())

  return (
    <div class={styles.runtime} data-testid="runtime-panel">
      <Show
        when={status()}
        fallback={
          <div class={styles.muted} data-testid="runtime-status">
            {t("runtime.checking")}
          </div>
        }
      >
        {(s) => (
          <>
            <RuntimeReadiness status={s()} prefix="runtime" />
            <Show when={s().busy === "repairing"}>
              <div class={styles.muted} data-testid="runtime-status">
                {t("runtime.repairing")}
              </div>
              <Show
                when={s().progress}
                fallback={
                  <progress class={styles.progress} max="1" data-testid="runtime-progress" />
                }
              >
                {(progress) => (
                  <progress
                    class={styles.progress}
                    value={progress()}
                    max="1"
                    data-testid="runtime-progress"
                  />
                )}
              </Show>
              <div class={styles.runtimeActions}>
                <Button onClick={cancel} data-testid="runtime-cancel">
                  {t("runtime.cancel")}
                </Button>
              </div>
            </Show>
            <Show when={s().busy === "installing"}>
              <div class={styles.muted} data-testid="runtime-status">
                {s().progress === null
                  ? t("runtime.installingUnknown")
                  : t("runtime.installing", { percent: Math.round((s().progress ?? 0) * 100) })}
              </div>
              {/* Without a size the bar has no value: it shows that work goes on. */}
              <Show
                when={s().progress}
                fallback={
                  <progress class={styles.progress} max="1" data-testid="runtime-progress" />
                }
              >
                {(progress) => (
                  <progress
                    class={styles.progress}
                    value={progress()}
                    max="1"
                    data-testid="runtime-progress"
                  />
                )}
              </Show>
              <div class={styles.runtimeActions}>
                <Button onClick={cancel} data-testid="runtime-cancel">
                  {t("runtime.cancel")}
                </Button>
              </div>
            </Show>
            <Show when={s().busy === "signing_in"}>
              <div class={styles.muted} data-testid="runtime-status">
                {t("runtime.signingIn")}
              </div>
              <Show when={s().signInCode}>
                {(code) => (
                  <div class={styles.itemMeta} data-testid="runtime-code">
                    {t("runtime.signInCode")} <strong>{code()}</strong>
                  </div>
                )}
              </Show>
              <Show when={s().signInUrl}>
                {(url) => (
                  <div class={styles.itemMeta} data-testid="runtime-url">
                    {url()}
                  </div>
                )}
              </Show>
              <div class={styles.runtimeActions}>
                <Button onClick={cancel} data-testid="runtime-cancel">
                  {t("runtime.cancel")}
                </Button>
              </div>
            </Show>
            <Show when={s().busy === null && s().state === "needs_repair"}>
              <div class={styles.itemMeta} data-testid="runtime-repair-help">
                {t("runtime.repair.help.system")}
              </div>
              <Show when={s().problem && runtimeSupport(props.kind).install === "download"}>
                <div class={styles.itemMeta} data-testid="runtime-repair-help-download">
                  {t("runtime.repair.help.download")}
                </div>
              </Show>
              <div class={styles.itemMeta}>{t("runtime.repair.note")}</div>
              <div class={styles.runtimeActions}>
                <Button
                  variant="primary"
                  onClick={() => void act("runtimes.repair")}
                  data-testid="runtime-repair"
                >
                  {t("runtime.repair")}
                </Button>
              </div>
            </Show>
            <Show when={s().busy === null && s().state !== "needs_repair"}>
              <Show
                when={s().source !== null}
                fallback={
                  <>
                    <div class={styles.muted} data-testid="runtime-status">
                      {s().state === "checking" ? t("runtime.checking") : t("runtime.missing")}
                    </div>
                    <Show
                      when={runtimeSupport(props.kind).install === "download"}
                      fallback={
                        <div class={styles.itemMeta} data-testid="runtime-install-hint">
                          {t(`runtime.install.${props.kind}` as MessageKey)}
                        </div>
                      }
                    >
                      <div class={styles.runtimeActions}>
                        <Button
                          variant="primary"
                          onClick={() => void act("runtimes.install")}
                          data-testid="runtime-install"
                        >
                          {t("runtime.install")}
                        </Button>
                      </div>
                    </Show>
                  </>
                }
              >
                <div class={styles.muted} data-testid="runtime-found">
                  {t("runtime.found", {
                    version: s().version ?? "",
                    source: t(`runtime.source.${s().source ?? "system"}` as MessageKey),
                  })}
                </div>
                <Show
                  when={s().signedIn && s().method === "subscription"}
                  fallback={
                    <>
                      <div class={styles.muted} data-testid="runtime-status">
                        {s().signedIn ? t("runtime.apiKeyLogin") : t("runtime.notSignedIn")}
                      </div>
                      <Show
                        when={runtimeSupport(props.kind).signIn === "app"}
                        fallback={
                          <div class={styles.itemMeta} data-testid="runtime-sign-in-hint">
                            {t(`runtime.signIn.${props.kind}` as MessageKey)}
                          </div>
                        }
                      >
                        <div class={styles.runtimeActions}>
                          <Button
                            variant="primary"
                            onClick={() => void act("runtimes.signIn")}
                            data-testid="runtime-sign-in"
                          >
                            {t("runtime.signIn")}
                          </Button>
                        </div>
                      </Show>
                    </>
                  }
                >
                  <div class={styles.ok} data-testid="runtime-status">
                    {s().user
                      ? t("runtime.signedInAs", { user: s().user ?? "" })
                      : t("runtime.signedIn")}
                  </div>
                  <RuntimeSummary status={s()} />
                </Show>
              </Show>
            </Show>
            <Show when={s().problem}>
              {(problem) => (
                <div class={styles.error} role="alert" data-testid="runtime-problem">
                  {t(
                    s().state === "needs_repair"
                      ? "runtime.problem.repair"
                      : s().source === null
                        ? "runtime.problem.install"
                        : "runtime.problem.signIn",
                    { detail: problem() },
                  )}
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
      <Show when={error()}>
        {(err) => (
          <div class={styles.error} role="alert" data-testid="runtime-error">
            {t(err().key, err().params)}
          </div>
        )}
      </Show>
      <Show when={status()?.busy === null}>
        <div class={styles.runtimeActions}>
          <Button onClick={() => void look()} data-testid="runtime-recheck">
            {t("runtime.recheck")}
          </Button>
        </div>
      </Show>
    </div>
  )
}
