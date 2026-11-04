import {
  type ConnectionFailure,
  type ConnectionTestResult,
  commandLine,
  type MessageKey,
  type ToolConnection,
} from "@robot/shared"
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Presence } from "../ui/Presence.tsx"
import { ConnectionFormDialog } from "./ConnectionForm.tsx"
import { ConnectionReviewDialog } from "./ConnectionReview.tsx"
import styles from "./connections.module.css"
import settings from "./settings.module.css"

/**
 * Settings, Connections (spec 018): the outside tool providers of this computer. The user adds
 * one, tests it, turns it and single tools on or off, edits it and removes it after a confirm.
 * The page never shows a saved secret. This computer only: a linked computer shows one line.
 */
export const ConnectionsSection = () => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const [fetched, { refetch }] = createResource(
    () => (ui.linked() ? undefined : true),
    () => call("connections.list"),
  )
  // A store keeps each row as it is when the list is read again: an open list of tools, and the
  // question "Remove?" stay open, and only the text that changed is drawn again.
  const [store, setStore] = createStore<{ list: ToolConnection[] }>({ list: [] })
  createEffect(() => {
    const next = fetched()
    if (next) setStore("list", reconcile([...next], { key: "id" }))
  })
  const list = () => store.list
  onCleanup(window.robot.on("connections.changed", () => void refetch()))

  const [editing, setEditing] = createSignal<{ connection?: ToolConnection }>()
  const [removing, setRemoving] = createSignal<string>()
  const [reviewing, setReviewing] = createSignal<{ id: string; name: string }>()
  const [testing, setTesting] = createSignal<ReadonlySet<string>>(new Set())
  const [results, setResults] = createSignal<Readonly<Record<string, ConnectionTestResult>>>({})
  const [error, setError] = createSignal<ErrorText>()

  const run = async (action: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await action()
    } catch (e) {
      setError(describeError(e))
    }
  }

  const reason = (failure: ConnectionFailure) => t(`connections.failure.${failure}` as MessageKey)

  const test = (connection: ToolConnection) =>
    run(async () => {
      setTesting(new Set([...testing(), connection.id]))
      try {
        const answer = await call("connections.test", { id: connection.id })
        setResults({ ...results(), [connection.id]: answer })
      } finally {
        const next = new Set(testing())
        next.delete(connection.id)
        setTesting(next)
      }
    })

  const stateText = (c: ToolConnection) =>
    c.state === "connected"
      ? t("connections.state.connected", { n: c.tools.length })
      : c.state === "error"
        ? t("connections.state.error", { reason: reason(c.failure ?? "ended") })
        : t(`connections.state.${c.state}` as MessageKey)

  /** Who may use the connection: "All agents", or the names of the agents that are still there. */
  const forWhom = (c: ToolConnection) =>
    c.agents === "all"
      ? t("connections.agents.all")
      : c.agents
          .map((id) => agents.byId(id)?.name)
          .filter((name): name is string => name !== undefined)
          .join(", ")

  const row = (c: ToolConnection) => (
    <li
      class={styles.item}
      data-testid="connection-row"
      data-connection={c.name}
      data-state={c.state}
    >
      <div class={styles.head}>
        <div class={styles.title}>
          <span class={styles.name} data-testid="connection-row-name">
            {c.name}
          </span>
          <span class={styles.meta}>{t(`connections.kind.${c.kind}` as MessageKey)}</span>
          <span class={styles.meta} data-testid="connection-row-agents">
            {forWhom(c)}
          </span>
          <span class={styles.state} data-state={c.state} data-testid="connection-row-state">
            {stateText(c)}
          </span>
        </div>
        <div class={styles.controls}>
          <Switch
            label={t("connections.switch", { name: c.name })}
            checked={c.enabled}
            onChange={(enabled) => run(() => call("connections.setEnabled", { id: c.id, enabled }))}
            testId="connection-switch"
          />
          <Button
            onClick={() => void test(c)}
            disabled={testing().has(c.id)}
            data-testid="connection-row-test"
          >
            {testing().has(c.id) ? t("connections.testing") : t("connections.test")}
          </Button>
          <Button onClick={() => setEditing({ connection: c })} data-testid="connection-edit">
            {t("connections.edit")}
          </Button>
          <Button onClick={() => setRemoving(c.id)} data-testid="connection-remove">
            {t("connections.remove")}
          </Button>
        </div>
      </div>
      <p class={styles.code} data-testid="connection-row-target">
        {c.kind === "program" ? commandLine(c.command, c.args) : c.address}
      </p>
      {/* The switch "Trust read-only marks" (spec 018, "Rules"). Off by default. */}
      <div class={styles.trust} data-testid="connection-trust">
        <Switch
          label={t("connections.trust.switch", { name: c.name })}
          checked={c.trustReadOnly}
          onChange={(trust) => run(() => call("connections.setTrust", { id: c.id, trust }))}
          testId="connection-trust-switch"
        />
        <span class={styles.trustText}>
          <span class={styles.trustLabel}>{t("connections.trust.label")}</span>
          <span class={styles.meta} data-testid="connection-trust-hint">
            {t("connections.trust.hint")}
          </span>
        </span>
      </div>
      <Show when={c.needReview > 0}>
        <div class={styles.review} data-testid="connection-review-row">
          <span class={styles.reviewText} data-testid="connection-review-text">
            {c.needReview === 1
              ? t("connections.review.one")
              : t("connections.review.other", { n: c.needReview })}
          </span>
          <Button
            onClick={() => setReviewing({ id: c.id, name: c.name })}
            data-testid="connection-review-open"
          >
            {t("connections.review.open")}
          </Button>
        </div>
      </Show>
      <Show when={c.valueMissing}>
        <span class={styles.warn} data-testid="connection-value-missing">
          {t("connections.valueMissing")}
        </span>
      </Show>
      <Show when={c.tooMany}>
        <span class={styles.meta} data-testid="connection-too-many">
          {t("connections.tooMany")}
        </span>
      </Show>
      <Show when={results()[c.id]}>
        {(answer) => (
          <Show
            when={answer().ok ? answer() : undefined}
            fallback={
              <p
                class={styles.result}
                data-ok="false"
                role="alert"
                data-testid="connection-row-test-failed"
              >
                {t("connections.form.testFailed", {
                  reason: reason((answer() as { failure: ConnectionFailure }).failure),
                })}
              </p>
            }
          >
            <p
              class={styles.result}
              data-ok="true"
              role="status"
              data-testid="connection-row-test-ok"
            >
              {t("connections.form.tested", {
                n: (answer() as { tools: readonly unknown[] }).tools.length,
              })}
            </p>
          </Show>
        )}
      </Show>
      <details class={styles.tools} data-testid="connection-tools">
        <summary data-testid="connection-tools-summary">
          {t("connections.tools")} ({c.tools.length})
        </summary>
        <Show
          when={c.tools.length > 0}
          fallback={
            <p class={styles.meta} data-testid="connection-tools-none">
              {t("connections.tools.none")}
            </p>
          }
        >
          <ul class={styles.toolList} data-testid="connection-tool-list">
            <For each={c.tools}>
              {(tool) => (
                <li class={styles.tool} data-testid="connection-tool" data-tool={tool.name}>
                  <span class={styles.toolText}>
                    <span class={styles.toolNameLine}>
                      <span class={styles.toolName}>{tool.name}</span>
                      {/* The mark that the connection gives to a tool that only reads (spec 018). */}
                      <Show when={tool.readOnly}>
                        <span
                          class={styles.markTag}
                          title={t("connections.tool.readOnly.title")}
                          data-testid="connection-tool-read-only"
                        >
                          {t("connections.tool.readOnly")}
                        </span>
                      </Show>
                      <Show when={tool.held}>
                        {(tag) => (
                          <span
                            class={styles.tag}
                            data-tag={tag()}
                            data-testid="connection-tool-held"
                          >
                            {t(`connections.review.tag.${tag()}` as MessageKey)}
                          </span>
                        )}
                      </Show>
                    </span>
                    <Show when={tool.description}>
                      <span class={styles.meta}>{tool.description}</span>
                    </Show>
                  </span>
                  <Switch
                    label={t("connections.tool.switch", { tool: tool.name })}
                    checked={tool.enabled}
                    onChange={(enabled) =>
                      run(() => call("connections.setTool", { id: c.id, tool: tool.name, enabled }))
                    }
                    testId="connection-tool-switch"
                  />
                </li>
              )}
            </For>
          </ul>
        </Show>
      </details>
      <Show when={removing() === c.id}>
        <div class={styles.confirm} role="alert" data-testid="connection-remove-ask">
          <span>{t("connections.remove.ask", { name: c.name })}</span>
          <Button onClick={() => setRemoving(undefined)} data-testid="connection-remove-cancel">
            {t("connections.remove.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={() =>
              run(async () => {
                await call("connections.delete", { id: c.id })
                setRemoving(undefined)
              })
            }
            data-testid="connection-remove-confirm"
          >
            {t("connections.remove.confirm")}
          </Button>
        </div>
      </Show>
    </li>
  )

  return (
    <div data-testid="connections-section">
      <Show
        when={!ui.linked()}
        fallback={
          // A linked computer keeps its own connections. This window has no control for them.
          <p class={settings.note} data-testid="connections-linked">
            {t("connections.linked", { name: ui.server()?.name ?? "" })}
          </p>
        }
      >
        <div class={styles.top}>
          <p class={settings.note}>{t("connections.hint")}</p>
          <Button variant="primary" onClick={() => setEditing({})} data-testid="connection-add">
            {t("connections.add")}
          </Button>
        </div>
        <Show when={error()}>
          {(err) => (
            <p class={settings.note} role="alert" data-testid="connections-error">
              {t(err().key, err().params)}
            </p>
          )}
        </Show>
        <Show
          when={list().length > 0}
          fallback={
            <p class={settings.note} data-testid="connections-empty">
              {t("connections.empty")}
            </p>
          }
        >
          <ul class={styles.list} data-testid="connections-list">
            <For each={list()}>{row}</For>
          </ul>
        </Show>
        <Presence when={reviewing()}>
          {(open) => (
            <ConnectionReviewDialog connection={open} onClose={() => setReviewing(undefined)} />
          )}
        </Presence>
        <Presence when={editing()}>
          {(open) => (
            <ConnectionFormDialog
              connection={open.connection}
              others={list()
                .filter((c) => c.id !== open.connection?.id)
                .map((c) => c.name)}
              count={list().length}
              onClose={() => setEditing(undefined)}
            />
          )}
        </Presence>
      </Show>
    </div>
  )
}
