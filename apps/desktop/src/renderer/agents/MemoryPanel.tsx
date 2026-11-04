import {
  checkNowState,
  type MemoryHistoryRow,
  type MemoryMode,
  type MemoryProposal,
  type MessageKey,
} from "@robot/shared"
import { Ellipsis } from "lucide-solid"
import {
  createEffect,
  createResource,
  createSignal,
  For,
  type JSX,
  onCleanup,
  Show,
} from "solid-js"
import { formatDateTime } from "../chat/format.ts"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { makeSkillFromWork } from "../skills/SkillForm.tsx"
import { useApp } from "../state/app.tsx"
import { clearMemoryTarget, type MemoryTab, memoryTarget } from "../state/memoryLink.ts"
import { useUi } from "../state/ui.tsx"
import { Button, Segmented, Switch } from "../ui/controls.tsx"
import { Menu } from "../ui/Menu.tsx"
import styles from "./agents.module.css"

/** A line that shows why a call failed. */
const Failure = (props: { error: ErrorText | undefined }) => {
  const { t } = useApp()
  return (
    <Show when={props.error}>
      {(err) => (
        <span class={styles.error} role="alert" data-testid="memory-error">
          {t(err().key, err().params)}
        </span>
      )}
    </Show>
  )
}

/** Runs a call and keeps its failure for the line above. */
const guarded =
  (setError: (error: ErrorText | undefined) => void) => async (run: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await run()
    } catch (e) {
      setError(describeError(e))
    }
  }

/** The memory items of one agent: search, add, edit and delete. */
const Items = (props: { agentId: string; own: boolean }) => {
  const { t } = useApp()
  const [query, setQuery] = createSignal("")
  const [draft, setDraft] = createSignal("")
  const [editing, setEditing] = createSignal<{ id: string; text: string }>()
  const [error, setError] = createSignal<ErrorText>()
  const run = guarded(setError)
  const [items, { refetch }] = createResource(
    () => ({ agentId: props.agentId, query: query() }),
    (input) => call("memory.list", input),
  )
  onCleanup(window.robot.on("memory.changed", () => void refetch()))

  const add = () =>
    run(async () => {
      const text = draft().trim()
      if (!text) return
      await call("memory.add", { agentId: props.agentId, text })
      setDraft("")
    })

  return (
    <>
      <input
        class={styles.input}
        value={query()}
        placeholder={t("agents.memory.search")}
        aria-label={t("agents.memory.search")}
        onInput={(e) => setQuery(e.currentTarget.value)}
        data-testid="memory-search"
      />
      <div class={styles.memoryRow}>
        <input
          class={styles.input}
          value={draft()}
          placeholder={t("agents.memory.placeholder")}
          aria-label={t("agents.memory.placeholder")}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault()
              void add()
            }
          }}
          data-testid="memory-input"
        />
        <Button onClick={add} data-testid="memory-add">
          {t("agents.memory.add")}
        </Button>
      </div>
      <Failure error={error()} />
      <Show when={(items() ?? []).length === 0}>
        <span class={styles.hint}>{t("agents.memory.empty")}</span>
      </Show>
      <For each={items() ?? []}>
        {(item) => (
          <div class={styles.memoryRow} data-testid="memory-item">
            <Show
              when={editing()?.id === item.id ? editing() : undefined}
              fallback={
                <>
                  <span class={styles.memoryText}>{item.text}</span>
                  <span class={styles.hint}>{t(`agents.memory.source.${item.source}`)}</span>
                  <Button
                    onClick={() => setEditing({ id: item.id, text: item.text })}
                    data-testid="memory-edit"
                  >
                    {t("agents.memory.edit")}
                  </Button>
                  <Button
                    onClick={() => run(() => call("memory.delete", { id: item.id }))}
                    data-testid="memory-delete"
                  >
                    {t("agents.memory.delete")}
                  </Button>
                  {/* "Make a skill" is on the computer only (spec 008, 017). */}
                  <Show when={props.own}>
                    <Menu
                      label={t("memory.item.menu")}
                      icon={<Ellipsis size={16} />}
                      testId="memory-item-menu"
                      items={[
                        {
                          label: t("skills.make"),
                          onSelect: () => makeSkillFromWork({ kind: "memory", id: item.id }),
                          testId: "memory-make-skill",
                        },
                      ]}
                    />
                  </Show>
                </>
              }
            >
              {(edit) => (
                <>
                  <input
                    class={styles.input}
                    value={edit().text}
                    aria-label={t("agents.memory.placeholder")}
                    onInput={(e) => setEditing({ id: item.id, text: e.currentTarget.value })}
                    data-testid="memory-edit-input"
                  />
                  <Button
                    variant="primary"
                    onClick={() =>
                      run(async () => {
                        await call("memory.update", { id: item.id, text: edit().text })
                        setEditing(undefined)
                      })
                    }
                    data-testid="memory-save"
                  >
                    {t("agents.memory.save")}
                  </Button>
                </>
              )}
            </Show>
          </div>
        )}
      </For>
    </>
  )
}

/** The facts that the agent suggests: Save, Edit and save, or Dismiss. Oldest first. */
const Proposals = (props: { proposals: readonly MemoryProposal[] }) => {
  const app = useApp()
  const { t } = app
  const [editing, setEditing] = createSignal<{ id: string; text: string }>()
  const [error, setError] = createSignal<ErrorText>()
  const run = guarded(setError)
  const saveEdited = (id: string) =>
    run(async () => {
      const edit = editing()
      if (edit?.id !== id) return
      await call("memory.proposal.accept", { id, text: edit.text })
      setEditing(undefined)
    })
  const origin = (p: MemoryProposal) => {
    // A proposal of a memory check has no chat: the source is the check (spec 008).
    if (p.fromCheck) return t("memory.proposals.fromCheck")
    if (!p.place) return undefined
    return p.place.name === null
      ? t("memory.proposals.placeGone")
      : t("memory.proposals.place", { name: p.place.name })
  }
  return (
    <>
      <Failure error={error()} />
      <Show when={props.proposals.length === 0}>
        <span class={styles.hint} data-testid="memory-proposals-empty">
          {t("memory.proposals.empty")}
        </span>
      </Show>
      <For each={props.proposals}>
        {(proposal) => (
          <div class={styles.proposal} data-testid="memory-proposal">
            <Show
              when={editing()?.id === proposal.id ? editing() : undefined}
              fallback={<span class={styles.memoryText}>{proposal.text}</span>}
            >
              {(edit) => (
                <input
                  class={styles.input}
                  value={edit().text}
                  aria-label={t("memory.proposals.edit")}
                  onInput={(e) => setEditing({ id: proposal.id, text: e.currentTarget.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void saveEdited(proposal.id)
                    }
                  }}
                  data-testid="proposal-edit-input"
                />
              )}
            </Show>
            <span class={styles.hint} data-testid="memory-proposal-meta">
              {formatDateTime(app.locale(), proposal.createdAt)}
              <Show when={origin(proposal)}>{(from) => <> · {from()}</>}</Show>
            </span>
            <div class={styles.memoryActions}>
              <Show
                when={editing()?.id === proposal.id}
                fallback={
                  <>
                    <Button
                      variant="primary"
                      onClick={() => run(() => call("memory.proposal.accept", { id: proposal.id }))}
                      data-testid="proposal-save"
                    >
                      {t("memory.proposals.save")}
                    </Button>
                    <Button
                      onClick={() => setEditing({ id: proposal.id, text: proposal.text })}
                      data-testid="proposal-edit"
                    >
                      {t("memory.proposals.editSave")}
                    </Button>
                    <Button
                      onClick={() =>
                        run(() => call("memory.proposal.dismiss", { id: proposal.id }))
                      }
                      data-testid="proposal-dismiss"
                    >
                      {t("memory.proposals.dismiss")}
                    </Button>
                  </>
                }
              >
                <Button
                  variant="primary"
                  onClick={() => saveEdited(proposal.id)}
                  data-testid="proposal-save-edited"
                >
                  {t("memory.proposals.save")}
                </Button>
                <Button onClick={() => setEditing(undefined)} data-testid="proposal-cancel">
                  {t("memory.proposals.cancel")}
                </Button>
              </Show>
            </div>
          </div>
        )}
      </For>
    </>
  )
}

/** The changes to the memory of the agent, newest first, each with its Undo. */
const History = (props: { rows: readonly MemoryHistoryRow[] }) => {
  const app = useApp()
  const { t } = app
  const [error, setError] = createSignal<ErrorText>()
  const run = guarded(setError)
  const text = (value: string | null): JSX.Element => (
    <span class={styles.historyText}>{value}</span>
  )
  return (
    <>
      <Failure error={error()} />
      <Show when={props.rows.length === 0}>
        <span class={styles.hint} data-testid="memory-history-empty">
          {t("memory.history.empty")}
        </span>
      </Show>
      <For each={props.rows}>
        {(row) => (
          <div
            class={styles.historyRow}
            data-testid="memory-history-row"
            data-kind={row.kind}
            data-actor={row.actor}
          >
            <span class={styles.hint}>
              {formatDateTime(app.locale(), row.at)} ·{" "}
              {t(`memory.history.actor.${row.actor}` as MessageKey)} ·{" "}
              {t(`memory.history.kind.${row.kind}` as MessageKey)}
            </span>
            <div class={styles.historyBody} data-testid="memory-history-text">
              <Show
                when={row.kind === "edited"}
                fallback={text(row.kind === "deleted" ? row.before : row.after)}
              >
                <span class={styles.hint}>{t("memory.history.before")}</span>
                {text(row.before)}
                <span class={styles.hint}>{t("memory.history.after")}</span>
                {text(row.after)}
              </Show>
            </div>
            {/* A row whose text looks like a secret has no Undo. */}
            <Show when={row.undo.on || row.undo.why !== "secret"}>
              <div class={styles.memoryActions}>
                <Button
                  disabled={!row.undo.on}
                  onClick={() => run(() => call("memory.undo", { id: row.id }))}
                  data-testid="memory-history-undo"
                >
                  {t("memory.history.undo")}
                </Button>
                <Show when={!row.undo.on}>
                  <span class={styles.hint} data-testid="memory-history-reason">
                    {t("memory.history.newer")}
                  </span>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </For>
    </>
  )
}

/**
 * The memory check of one agent (spec 008): the choice, how many turns it has counted, and "Check
 * now". A linked device sees the choice and changes it only with the switch "Can create and change
 * agents" (spec 012). "Check now" runs the model of this computer, so it is not offered there.
 */
const Check = (props: { agentId: string; own: boolean }) => {
  const { t } = useApp()
  const ui = useUi()
  const [error, setError] = createSignal<ErrorText>()
  const run = guarded(setError)
  const [info, { refetch }] = createResource(
    () => props.agentId,
    (agentId) => call("memory.check", { agentId }),
  )
  // A turn that ends, a check that starts, and a change of the agent all move the count.
  const again = () => void refetch()
  onCleanup(window.robot.on("memory.changed", again))
  onCleanup(window.robot.on("tasks.changed", again))
  onCleanup(window.robot.on("agents.changed", again))

  const toggle = (on: boolean) =>
    run(async () => {
      await call("memory.check.set", { agentId: props.agentId, on })
      await refetch()
    })
  const now = () =>
    run(async () => {
      await call("memory.check.now", { agentId: props.agentId })
      await refetch()
    })

  return (
    <Show when={info()}>
      {(current) => {
        const usable = () => current().program === null
        const state = () => checkNowState(current())
        return (
          <div class={styles.field} data-testid="memory-check">
            <div class={styles.switchRow}>
              <span class={styles.label}>{t("memory.check.label")}</span>
              <Switch
                label={t("memory.check.label")}
                checked={current().on && usable()}
                disabled={!usable() || !ui.canChange()}
                onChange={toggle}
                testId="memory-check-switch"
              />
            </div>
            <span class={styles.hint} data-testid="memory-check-hint">
              {t("memory.check.hint")}
            </span>
            <Show when={current().program}>
              {(program) => (
                <span class={styles.hint} data-testid="memory-check-runtime">
                  {t("memory.check.runtime", { program: program() })}
                </span>
              )}
            </Show>
            <Show when={usable() && !current().memory}>
              <span class={styles.hint} data-testid="memory-check-memory-off">
                {t("memory.check.memoryOff")}
              </span>
            </Show>
            <Show when={current().on && usable()}>
              <div class={styles.memoryRow}>
                <span class={styles.memoryText} data-testid="memory-check-count">
                  {t("memory.check.count", { count: current().count, every: current().every })}
                </span>
                <Show when={props.own}>
                  <Button disabled={state() !== "on"} onClick={now} data-testid="memory-check-now">
                    {t("memory.check.now")}
                  </Button>
                </Show>
              </div>
              <Show when={props.own && (state() === "off_none" || state() === "off_busy")}>
                <span class={styles.hint} data-testid="memory-check-now-reason">
                  {t(state() === "off_none" ? "memory.check.now.none" : "memory.check.now.busy")}
                </span>
              </Show>
            </Show>
            <Failure error={error()} />
          </div>
        )
      }}
    </Show>
  )
}

/**
 * The memory page of one agent (spec 008): the choice of how the agent saves, and three tabs.
 * A linked device (012) sees the items only, and a line that tells where to open the rest.
 */
export const MemoryPanel = (props: { agentId: string }) => {
  const { t } = useApp()
  const ui = useUi()
  const own = () => !ui.linked()
  const [tab, setTab] = createSignal<MemoryTab>("items")
  const [error, setError] = createSignal<ErrorText>()
  let root: HTMLDivElement | undefined

  const [mode, { refetch: refetchMode, mutate: setModeLocal }] = createResource(
    () => (own() ? props.agentId : undefined),
    (agentId) => call("memory.mode", { agentId }),
  )
  const [proposals, { refetch: refetchProposals }] = createResource(
    () => (own() ? props.agentId : undefined),
    (agentId) => call("memory.proposals", { agentId }),
  )
  const [history, { refetch: refetchHistory }] = createResource(
    () => (own() ? props.agentId : undefined),
    (agentId) => call("memory.history", { agentId }),
  )
  onCleanup(
    window.robot.on("memory.changed", () => {
      void refetchMode()
      void refetchProposals()
      void refetchHistory()
    }),
  )

  // The tab Proposals shows when the choice is "Ask me first" or when a proposal waits.
  const showProposals = () => mode() === "ask" || (proposals() ?? []).length > 0
  const tabs = (): MemoryTab[] =>
    !own() ? ["items"] : showProposals() ? ["items", "proposals", "history"] : ["items", "history"]
  const active = (): MemoryTab => (tabs().includes(tab()) ? tab() : "items")

  // The link in the chat opens this panel on the tab that it names, once.
  createEffect(() => {
    const target = memoryTarget()
    if (!target || target.agentId !== props.agentId) return
    setTab(target.tab)
    clearMemoryTarget()
    queueMicrotask(() => root?.scrollIntoView({ block: "nearest" }))
  })

  const choose = async (next: MemoryMode) => {
    setError(undefined)
    const before = mode()
    setModeLocal(next)
    try {
      await call("memory.setMode", { agentId: props.agentId, mode: next })
    } catch (e) {
      setModeLocal(before)
      setError(describeError(e))
    }
  }

  return (
    <div class={styles.field} data-testid="memory-panel" ref={root}>
      <span class={styles.label}>{t("agents.memory.title")}</span>
      <span class={styles.hint} data-testid="memory-honest">
        {t("honest.line")}
      </span>
      <span class={styles.hint}>{t("agents.memory.hint")}</span>
      <Show when={own() && mode()}>
        {(current) => (
          <div class={styles.field}>
            <Segmented
              label={t("memory.mode.label")}
              value={current()}
              options={[
                { value: "now", label: t("memory.mode.now") },
                { value: "ask", label: t("memory.mode.ask") },
              ]}
              onChange={choose}
              testId="memory-mode"
            />
            <span class={styles.hint} data-testid="memory-mode-hint">
              {t(current() === "ask" ? "memory.mode.hint.ask" : "memory.mode.hint.now")}
            </span>
            <Failure error={error()} />
          </div>
        )}
      </Show>
      <Check agentId={props.agentId} own={own()} />
      <Show when={tabs().length > 1}>
        <Segmented
          label={t("memory.tabs")}
          value={active()}
          options={tabs().map((value) => ({
            value,
            label:
              value === "proposals" && (proposals() ?? []).length > 0
                ? `${t("memory.tab.proposals")} (${(proposals() ?? []).length})`
                : t(`memory.tab.${value}` as MessageKey),
          }))}
          onChange={setTab}
          testId="memory-tabs"
        />
      </Show>
      <Show when={active() === "items"}>
        <Items agentId={props.agentId} own={own()} />
      </Show>
      <Show when={active() === "proposals"}>
        <Proposals proposals={proposals() ?? []} />
      </Show>
      <Show when={active() === "history"}>
        <History rows={history() ?? []} />
      </Show>
      <Show when={!own()}>
        <span class={styles.hint} data-testid="memory-client-more">
          {t("memory.client.more", { name: ui.server()?.name ?? "" })}
        </span>
      </Show>
    </div>
  )
}
