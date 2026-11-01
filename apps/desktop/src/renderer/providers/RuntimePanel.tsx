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
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./providers.module.css"

export const isReady = (status: RuntimeStatus | undefined) =>
  !!status && status.source !== null && status.signedIn && status.method === "subscription"

/** A reset time: the clock time when it is near, the weekday with it when it is not. */
const formatReset = (locale: Locale, at: number, now = Date.now()) =>
  new Intl.DateTimeFormat(
    locale,
    at - now < 20 * 3_600_000
      ? { hour: "numeric", minute: "2-digit" }
      : { weekday: "short", hour: "numeric", minute: "2-digit" },
  ).format(at)

/** The lines about the plan: its name and how much of each window is used. */
export const RuntimeSummary = (props: { status: RuntimeStatus }) => {
  const { t, locale } = useApp()
  const line = (limit: RuntimeLimit) => {
    const percent = Math.round(limit.used * 100)
    if (limit.resetsAt === null)
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
      <For each={props.status.limits}>
        {(limit) => (
          <div class={styles.itemMeta} data-testid="runtime-limit">
            {line(limit)}
          </div>
        )}
      </For>
    </>
  )
}

/**
 * Shows the vendor program: whether it is here, whether the user is signed in with a
 * subscription, and the buttons to download it and to sign in.
 */
export const RuntimePanel = (props: { kind: RuntimeKind; onReady: (ready: boolean) => void }) => {
  const { t } = useApp()
  const [status, setStatus] = createSignal<RuntimeStatus>()
  const [error, setError] = createSignal<ErrorText>()

  const look = async () => {
    setError(undefined)
    try {
      setStatus(await call("runtimes.status", { kind: props.kind }))
    } catch (e) {
      setError(describeError(e))
    }
  }
  void look()
  onCleanup(
    window.robot.on("runtimes.changed", (next) => {
      if (next.kind === props.kind) setStatus(next)
    }),
  )
  createEffect(() => props.onReady(isReady(status())))

  const act = async (method: "runtimes.install" | "runtimes.signIn") => {
    setError(undefined)
    try {
      setStatus(await call(method, { kind: props.kind }))
    } catch (e) {
      setError(describeError(e))
    }
  }
  const cancel = () => void call("runtimes.cancel", { kind: props.kind })

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
            <Show when={s().busy === null}>
              <Show
                when={s().source !== null}
                fallback={
                  <>
                    <div class={styles.muted} data-testid="runtime-status">
                      {t("runtime.missing")}
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
                  {t(s().source === null ? "runtime.problem.install" : "runtime.problem.signIn", {
                    detail: problem(),
                  })}
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
