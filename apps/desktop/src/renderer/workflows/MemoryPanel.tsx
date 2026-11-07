import {
  charLength,
  MEMORY_USER_MAX,
  type MemoryHistoryRow,
  type MemoryItem,
  type MemoryMode,
  type MemoryState,
  type WorkflowDetail,
} from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { formatDateTime } from "../lib/format.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Segmented, Switch } from "../ui/controls.tsx"
import { Keyed } from "../ui/Keyed.tsx"
import { tabKeyDown } from "../ui/tabKeys.ts"
import styles from "./improve.module.css"
import { memoryTabs, showsProposals } from "./improveView.ts"

const TABS = ["items", "history"] as const
type Tab = (typeof TABS)[number]

/** One item of the memory: its text, where it came from, and Edit and Delete (spec 008). */
const Item = (props: { item: MemoryItem; onError: (e: unknown) => void }) => {
  const { t, locale } = useApp()
  const [editing, setEditing] = createSignal(false)
  const [text, setText] = createSignal("")
  const over = () => charLength(text()) > MEMORY_USER_MAX
  const begin = () => {
    setText(props.item.text)
    setEditing(true)
  }
  const save = () =>
    call("memory.update", { id: props.item.id, text: text() })
      .then(() => setEditing(false))
      .catch(props.onError)
  const remove = () => call("memory.delete", { id: props.item.id }).catch(props.onError)
  return (
    <li class={styles.item} data-testid="memory-item">
      <Show
        when={editing()}
        fallback={
          <>
            <p class={styles.itemText} data-testid="memory-item-text">
              {props.item.text}
            </p>
            <span class={styles.meta}>
              {t(`memory.source.${props.item.source}`)} ·{" "}
              {formatDateTime(locale(), props.item.createdAt)}
            </span>
            <div class={styles.actions}>
              <Button onClick={begin} data-testid="memory-item-edit">
                {t("memory.edit")}
              </Button>
              <Button
                variant="danger"
                onClick={() => void remove()}
                data-testid="memory-item-delete"
              >
                {t("memory.delete")}
              </Button>
            </div>
          </>
        }
      >
        <textarea
          class={styles.input}
          aria-label={t("memory.edit")}
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          data-testid="memory-item-input"
        />
        <span class={styles.count} data-over={over()}>
          {t("memory.count", { n: charLength(text()), max: MEMORY_USER_MAX })}
        </span>
        <div class={styles.actions}>
          <Button onClick={() => setEditing(false)}>{t("memory.cancel")}</Button>
          <Button
            variant="primary"
            disabled={over() || text().trim() === ""}
            onClick={() => void save()}
            data-testid="memory-item-save"
          >
            {t("memory.save")}
          </Button>
        </div>
      </Show>
    </li>
  )
}

/** One row of the history: the time, who, what kind, the text, and Undo (spec 008, "Flows" 4). */
const HistoryRowView = (props: { row: MemoryHistoryRow; onError: (e: unknown) => void }) => {
  const { t, locale } = useApp()
  const r = () => props.row
  const undo = () => call("memory.undo", { historyId: r().id }).catch(props.onError)
  const shown = (text: string | null) =>
    r().redacted ? t("memory.history.redacted") : (text ?? "")
  return (
    <li
      class={styles.item}
      data-testid="memory-history-row"
      data-kind={r().kind}
      data-actor={r().actor}
    >
      <span class={styles.meta}>
        {formatDateTime(locale(), r().at)} · {t(`memory.history.actor.${r().actor}`)} ·{" "}
        {t(`memory.history.kind.${r().kind}`)}
      </span>
      <Show
        when={r().kind === "edited"}
        fallback={
          <p class={styles.itemText}>{shown(r().kind === "deleted" ? r().oldText : r().newText)}</p>
        }
      >
        <p class={styles.itemText}>
          <span class={styles.meta}>{t("memory.history.before")}: </span>
          {shown(r().oldText)}
        </p>
        <p class={styles.itemText}>
          <span class={styles.meta}>{t("memory.history.after")}: </span>
          {shown(r().newText)}
        </p>
      </Show>
      <Show
        when={r().canUndo}
        fallback={
          <Show when={r().undoBlocked}>
            {(why) => (
              <span class={styles.meta} data-testid="memory-history-blocked">
                {t(`memory.history.undoBlocked.${why()}`)}
              </span>
            )}
          </Show>
        }
      >
        <div class={styles.actions}>
          <Button onClick={() => void undo()} data-testid="memory-history-undo">
            {t("memory.history.undo")}
          </Button>
        </div>
      </Show>
    </li>
  )
}

/**
 * The memory page of a workflow (spec 008): one muted line about how a workflow gets better, the
 * choices above the tabs, and the tabs Items and History. Memory off keeps the items, and the tabs
 * stay open.
 */
export const MemoryPanel = (props: { workflow: WorkflowDetail; onOpenProposals: () => void }) => {
  const { t } = useApp()
  const ui = useUi()
  // The history, the undo and the proposals stay on the computer that holds the memory: the link
  // does not route them (spec 008, 012), so a linked device shows the items only.
  const local = () => showsProposals(ui.server()?.kind)
  const tabs = (): readonly Tab[] => memoryTabs(local())
  const [tab, setTab] = createSignal<Tab>("items")
  const [search, setSearch] = createSignal("")
  const [draft, setDraft] = createSignal("")
  const [problem, setProblem] = createSignal<ErrorText>()
  const fail = (e: unknown) => setProblem(describeError(e))
  const [state, { refetch }] = createResource(
    () => ({ id: props.workflow.id, search: search().trim() }),
    (k): Promise<MemoryState | undefined> =>
      call("memory.state", { workflowId: k.id, ...(k.search ? { search: k.search } : {}) }).catch(
        () => undefined,
      ),
  )
  const [history, { refetch: refetchHistory }] = createResource(
    () => (local() ? props.workflow.id : undefined),
    (id): Promise<readonly MemoryHistoryRow[]> =>
      call("memory.history", { workflowId: id }).catch(() => []),
  )
  const reread = () => {
    void refetch()
    if (local()) void refetchHistory()
  }
  onCleanup(window.robot.on("memory.changed", reread))
  onCleanup(window.robot.on("proposals.changed", reread))
  const choose = (work: Promise<unknown>) => {
    setProblem(undefined)
    work.then(reread).catch(fail)
  }
  const add = () => {
    setProblem(undefined)
    call("memory.add", { workflowId: props.workflow.id, text: draft() })
      .then(() => {
        setDraft("")
        reread()
      })
      .catch(fail)
  }
  const over = () => charLength(draft()) > MEMORY_USER_MAX
  const s = () => state.latest
  return (
    <div class={styles.page} data-testid="memory-panel">
      <p class={styles.muted} data-testid="memory-hint">
        {t("memory.hint")}
      </p>
      <Show when={s()}>
        {(m) => (
          <>
            <div class={styles.row}>
              <span class={styles.title}>{t("memory.enabled")}</span>
              <Switch
                label={t("memory.enabled")}
                checked={m().enabled}
                testId="memory-enabled"
                onChange={(enabled) =>
                  choose(call("memory.setEnabled", { workflowId: props.workflow.id, enabled }))
                }
              />
            </div>
            <Show when={!m().enabled}>
              <p class={styles.warn} role="status" data-testid="memory-off">
                {t("memory.enabled.off")}
              </p>
            </Show>
            <div class={styles.row}>
              <span class={styles.title}>{t("memory.mode")}</span>
              <Segmented<MemoryMode>
                label={t("memory.mode")}
                testId="memory-mode"
                value={m().mode}
                options={[
                  { value: "ask", label: t("memory.mode.ask") },
                  { value: "now", label: t("memory.mode.now") },
                ]}
                onChange={(mode) =>
                  choose(call("memory.setMode", { workflowId: props.workflow.id, mode }))
                }
              />
            </div>
            <p class={styles.muted}>{t("memory.mode.hint")}</p>
            <Show when={m().mode === "now" && !m().selfImprovement}>
              <p class={styles.muted} data-testid="memory-now-off">
                {t("memory.mode.needsImprovement")}
              </p>
            </Show>
            <Show when={local() && m().proposals > 0}>
              <div>
                <button
                  type="button"
                  class={styles.link}
                  onClick={props.onOpenProposals}
                  data-testid="memory-proposals-link"
                >
                  {t("memory.proposals", { n: m().proposals })}
                </button>
              </div>
            </Show>
          </>
        )}
      </Show>
      <Show when={problem()}>
        {(p) => (
          <p class={styles.error} role="alert" data-testid="memory-error">
            {t(p().key, p().params)}
          </p>
        )}
      </Show>
      <Show when={tabs().length > 1}>
        <div class={styles.row} role="tablist" aria-label={t("memory.tabs")}>
          <For each={tabs()}>
            {(name) => (
              <Button
                role="tab"
                id={`memory-tab-${name}`}
                aria-selected={tab() === name}
                aria-controls={`memory-panel-${name}`}
                tabIndex={tab() === name ? 0 : -1}
                data-testid={`memory-tab-${name}`}
                variant={tab() === name ? "primary" : "default"}
                onClick={() => setTab(name)}
                onKeyDown={(e) => tabKeyDown(e, tabs(), tab(), setTab)}
              >
                {t(`memory.tab.${name}`)}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <Show when={tab() === "items"}>
        <div
          class={styles.page}
          role="tabpanel"
          id="memory-panel-items"
          aria-labelledby={tabs().length > 1 ? "memory-tab-items" : undefined}
        >
          <input
            type="search"
            class={styles.input}
            aria-label={t("memory.search")}
            placeholder={t("memory.search")}
            value={search()}
            onInput={(e) => setSearch(e.currentTarget.value)}
            data-testid="memory-search"
          />
          <label class={styles.row}>
            <span class={styles.hidden}>{t("memory.add.label")}</span>
            <textarea
              class={`${styles.input} ${styles.grow}`}
              placeholder={t("memory.add.label")}
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              data-testid="memory-draft"
            />
          </label>
          <div class={styles.row}>
            <span class={styles.count} data-over={over()}>
              {t("memory.count", { n: charLength(draft()), max: MEMORY_USER_MAX })}
            </span>
            <span class={styles.grow} />
            <Button
              variant="primary"
              disabled={over() || draft().trim() === ""}
              onClick={add}
              data-testid="memory-add"
            >
              {t("memory.add")}
            </Button>
          </div>
          <Show
            when={(s()?.items.length ?? 0) > 0}
            fallback={
              <p class={styles.muted} data-testid="memory-empty">
                {search().trim() === "" ? t("memory.empty") : t("memory.empty.search")}
              </p>
            }
          >
            <ul class={styles.list}>
              <Keyed each={s()?.items} by={(i) => i.id}>
                {(item) => <Item item={item()} onError={fail} />}
              </Keyed>
            </ul>
          </Show>
        </div>
      </Show>
      <Show when={tab() === "history" && local()}>
        <div
          class={styles.page}
          role="tabpanel"
          id="memory-panel-history"
          aria-labelledby="memory-tab-history"
        >
          <Show
            when={(history.latest?.length ?? 0) > 0}
            fallback={
              <p class={styles.muted} data-testid="memory-history-empty">
                {t("memory.history.empty")}
              </p>
            }
          >
            <ul class={styles.list}>
              <Keyed each={history.latest} by={(r) => r.id}>
                {(row) => <HistoryRowView row={row()} onError={fail} />}
              </Keyed>
            </ul>
          </Show>
        </div>
      </Show>
    </div>
  )
}
