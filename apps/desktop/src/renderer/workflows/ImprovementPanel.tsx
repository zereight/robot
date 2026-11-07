import {
  charLength,
  type DiffSegment,
  DOCUMENT_MAX,
  type GraphChange,
  type GraphConnectionChange,
  type GraphNodeChange,
  MEMORY_USER_MAX,
  type MessageKey,
  type Proposal,
  type ProposalsView,
  type WorkflowDetail,
} from "@robot/shared"
import { createEffect, createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { formatDateTime } from "../lib/format.ts"
import { outsideSourceText } from "../lib/outside.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { improveRequest } from "../state/improve.ts"
import { Button, Switch } from "../ui/controls.tsx"
import { Keyed } from "../ui/Keyed.tsx"
import styles from "./improve.module.css"
import { GRAPH_FIELD_KEYS, problemLine } from "./improveView.ts"

const TABS = ["waiting", "log"] as const
type Tab = (typeof TABS)[number]

/** The old text and the new text with the removed and the added parts marked (spec 002, "Card"). */
const Diff = (props: { segments: readonly DiffSegment[] }) => {
  const { t } = useApp()
  return (
    <pre class={styles.text} data-testid="proposal-diff" title={t("improve.diff")}>
      <For each={props.segments}>
        {(s) => (
          <>
            <Show when={s.kind === "removed"}>
              <del data-testid="proposal-removed">
                <span class={styles.hidden}>{t("improve.diff.removed")} </span>
                {s.text}
              </del>
            </Show>
            <Show when={s.kind === "added"}>
              <ins data-testid="proposal-added">
                <span class={styles.hidden}>{t("improve.diff.added")} </span>
                {s.text}
              </ins>
            </Show>
            <Show when={s.kind === "same"}>{s.text}</Show>
          </>
        )}
      </For>
    </pre>
  )
}

const nodeLine = (t: ReturnType<typeof useApp>["t"], n: GraphNodeChange) =>
  n.fields.length > 0
    ? t("improve.graph.node.fields", {
        number: n.number,
        name: n.name,
        fields: n.fields
          .map((f) => t(GRAPH_FIELD_KEYS[f as keyof typeof GRAPH_FIELD_KEYS] as MessageKey))
          .join(", "),
      })
    : t("improve.graph.node", { number: n.number, name: n.name })

const connectionLine = (t: ReturnType<typeof useApp>["t"], c: GraphConnectionChange) => {
  const from = t("improve.graph.node", { number: c.from.number, name: c.from.name })
  const to = t("improve.graph.node", { number: c.to.number, name: c.to.name })
  return c.option === null
    ? t("improve.graph.connection", { from, to })
    : t("improve.graph.connection.option", { from, to, option: c.option })
}

/** The nodes and the connections that a graph change adds, changes and removes. */
const GraphDiff = (props: { change: GraphChange }) => {
  const { t } = useApp()
  const groups = () =>
    [
      ["improve.graph.added", props.change.addedNodes.map((n) => nodeLine(t, n)), "added"],
      ["improve.graph.changed", props.change.changedNodes.map((n) => nodeLine(t, n)), "changed"],
      ["improve.graph.removed", props.change.removedNodes.map((n) => nodeLine(t, n)), "removed"],
      [
        "improve.graph.connectionsAdded",
        props.change.addedConnections.map((c) => connectionLine(t, c)),
        "connections-added",
      ],
      [
        "improve.graph.connectionsRemoved",
        props.change.removedConnections.map((c) => connectionLine(t, c)),
        "connections-removed",
      ],
    ] as const
  return (
    <div data-testid="proposal-graph">
      <For each={groups()}>
        {([key, lines, name]) => (
          <Show when={lines.length > 0}>
            <h4 class={styles.subTitle}>{t(key)}</h4>
            <ul class={styles.group} data-testid={`proposal-graph-${name}`}>
              <For each={lines}>{(line) => <li>{line}</li>}</For>
            </ul>
          </Show>
        )}
      </For>
    </div>
  )
}

/** The state of the check for the new graph of a graph change (spec 010). */
const CheckLines = (props: { proposal: Proposal }) => {
  const { t } = useApp()
  const c = () => props.proposal.check
  return (
    <div data-testid="proposal-check" data-state={c()?.state ?? "none"}>
      <Show when={c()?.state === "passed"}>
        <p class={styles.muted}>{t("improve.check.passed")}</p>
      </Show>
      <Show when={c()?.state === "problem"}>
        <p class={styles.error} role="alert">
          {t("improve.check.problem")}
        </p>
        <ul class={styles.group}>
          <For
            each={
              (c() as { problems?: Parameters<typeof problemLine>[2][] } | null)?.problems ?? []
            }
          >
            {(p) => <li>{problemLine(t, props.proposal.graphNodes, p)}</li>}
          </For>
        </ul>
      </Show>
      <Show when={c()?.state === "stopped"}>
        <p class={styles.error}>{t("improve.check.stopped")}</p>
      </Show>
      <Show when={c()?.state === "failed"}>
        <p class={styles.error}>{t("improve.check.failed")}</p>
      </Show>
    </div>
  )
}

const kindLine = (t: ReturnType<typeof useApp>["t"], p: Proposal) =>
  p.kind === "prompt"
    ? t("improve.kind.prompt", { number: p.node?.number ?? 0, name: p.node?.name ?? "" })
    : t(`improve.kind.${p.kind}`, { number: 0, name: "" })

/** The card of one proposal (spec 002, "Flows" 3), and its row in the change log (6). */
const Card = (props: {
  proposal: Proposal
  focused: boolean
  onError: (e: unknown) => void
  onOpenRun: (runId: string) => void
}) => {
  const { t, locale } = useApp()
  const p = () => props.proposal
  const [editing, setEditing] = createSignal(false)
  const [text, setText] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const guard = async (work: () => Promise<unknown>) => {
    if (busy()) return
    setBusy(true)
    try {
      await work()
    } catch (e) {
      props.onError(e)
    } finally {
      setBusy(false)
    }
  }
  const accept = () => guard(() => call("proposals.accept", { id: p().id }))
  const reject = () => guard(() => call("proposals.reject", { id: p().id }))
  const undo = () => guard(() => call("proposals.undo", { id: p().id }))
  const begin = () => {
    setText(p().newText ?? "")
    setEditing(true)
  }
  const saveEdited = () =>
    guard(async () => {
      await call("proposals.accept", { id: p().id, text: text() })
      setEditing(false)
    })
  const limit = () => (p().kind === "memory" ? MEMORY_USER_MAX : DOCUMENT_MAX)
  const over = () => charLength(text()) > limit()
  const edited = () => p().kind !== "graph"
  const source = () => {
    const time = formatDateTime(locale(), p().createdAt)
    return t(`improve.source.${p().source.kind}`, { time })
  }
  let card: HTMLLIElement | undefined
  createEffect(() => {
    if (props.focused) card?.scrollIntoView({ block: "nearest" })
  })
  return (
    <li
      class={styles.item}
      ref={card}
      data-testid="proposal-card"
      data-kind={p().kind}
      data-state={p().state}
      data-focused={props.focused}
      aria-label={kindLine(t, p())}
    >
      <h3 class={styles.title} data-testid="proposal-kind">
        {kindLine(t, p())}
      </h3>
      <Show when={p().reason !== ""}>
        <p class={styles.itemText} data-testid="proposal-reason">
          <span class={styles.meta}>{t("improve.reason")}: </span>
          {p().reason}
        </p>
      </Show>
      <span class={styles.meta} data-testid="proposal-source">
        <Show when={p().source.kind === "run" && p().source.id} fallback={source()}>
          {(id) => (
            <button
              type="button"
              class={styles.link}
              title={t("improve.source.open")}
              onClick={() => props.onOpenRun(id())}
            >
              {source()}
            </button>
          )}
        </Show>
      </span>
      <Show when={p().outside}>
        {(o) => (
          <p class={styles.warn} data-testid="proposal-outside">
            {t("improve.outside")} ({outsideSourceText(t, o())})
          </p>
        )}
      </Show>
      <Show when={p().kind === "document" || p().kind === "prompt"}>
        <Show
          when={p().diff}
          fallback={
            <div class={styles.compare}>
              <div>
                <h4 class={styles.subTitle}>{t("improve.text.old")}</h4>
                <pre class={styles.text}>{p().oldText}</pre>
              </div>
              <div>
                <h4 class={styles.subTitle}>{t("improve.text.new")}</h4>
                <pre class={styles.text}>{p().newText}</pre>
              </div>
            </div>
          }
        >
          {(d) => <Diff segments={d()} />}
        </Show>
      </Show>
      <Show when={p().kind === "memory"}>
        <p class={styles.itemText} data-testid="proposal-fact">
          <span class={styles.meta}>{t("improve.fact")}: </span>
          {p().newText}
        </p>
      </Show>
      <Show when={p().kind === "graph" && p().graph}>
        {(g) => (
          <>
            <GraphDiff change={g()} />
            <CheckLines proposal={p()} />
          </>
        )}
      </Show>
      <Show when={p().state === "waiting"}>
        <Show when={p().acceptBlock === "run_working"}>
          <p class={styles.muted} data-testid="proposal-run-working">
            {t("improve.acceptBlock.run_working")}
          </p>
        </Show>
        <Show when={editing()}>
          <textarea
            class={styles.input}
            aria-label={t("improve.edit.label")}
            value={text()}
            onInput={(e) => setText(e.currentTarget.value)}
            data-testid="proposal-edit-input"
          />
          <span class={styles.count} data-over={over()}>
            {t("memory.count", { n: charLength(text()), max: limit() })}
          </span>
        </Show>
        <div class={styles.actions}>
          <Show
            when={editing()}
            fallback={
              <>
                <Button
                  variant="primary"
                  disabled={busy() || p().acceptBlock !== null}
                  onClick={() => void accept()}
                  data-testid="proposal-accept"
                >
                  {t("improve.accept")}
                </Button>
                <Show when={edited()}>
                  <Button
                    disabled={busy() || p().acceptBlock === "run_working"}
                    onClick={begin}
                    data-testid="proposal-edit"
                  >
                    {t("improve.edit")}
                  </Button>
                </Show>
                <Button
                  disabled={busy()}
                  onClick={() => void reject()}
                  data-testid="proposal-reject"
                >
                  {t("improve.reject")}
                </Button>
              </>
            }
          >
            <Button onClick={() => setEditing(false)} data-testid="proposal-edit-cancel">
              {t("improve.edit.cancel")}
            </Button>
            <Button
              variant="primary"
              disabled={busy() || over() || text().trim() === ""}
              onClick={() => void saveEdited()}
              data-testid="proposal-edit-save"
            >
              {t("improve.edit.save")}
            </Button>
          </Show>
        </div>
      </Show>
      <Show when={p().state !== "waiting"}>
        <span class={styles.state} data-state={p().state} data-testid="proposal-state">
          {p().state === "undone"
            ? t("improve.undone.at", {
                time: formatDateTime(locale(), p().undoneAt ?? p().answeredAt ?? 0),
              })
            : t("improve.answered", {
                state: t(`improve.state.${p().state}`),
                time: formatDateTime(locale(), p().answeredAt ?? 0),
              })}
        </span>
        <Show when={p().stateReason}>
          {(r) => (
            <span class={styles.meta} data-testid="proposal-reason-code">
              {t(`improve.reason.${r()}`)}
            </span>
          )}
        </Show>
        <Show when={p().state === "applied"}>
          <Show when={p().kind !== "graph" && p().diff}>{(d) => <Diff segments={d()} />}</Show>
          <Show
            when={p().canUndo}
            fallback={
              <Show when={p().undoBlock}>
                {(why) => (
                  <span class={styles.meta} data-testid="proposal-undo-blocked">
                    {t(`improve.undoBlock.${why()}`)}
                  </span>
                )}
              </Show>
            }
          >
            <div class={styles.actions}>
              <Button disabled={busy()} onClick={() => void undo()} data-testid="proposal-undo">
                {t("improve.undo")}
              </Button>
            </div>
          </Show>
        </Show>
      </Show>
    </li>
  )
}

/**
 * The page "Self-improvement" of a workflow (spec 002, "Flows" 2): the switch, and the tabs
 * "Waiting" and "Change log". The cards never apply anything by themselves: each button is one
 * click of the user.
 */
export const ImprovementPanel = (props: {
  workflow: WorkflowDetail
  onOpenRun: (runId: string) => void
}) => {
  const { t } = useApp()
  const [tab, setTab] = createSignal<Tab>("waiting")
  const [focus, setFocus] = createSignal<string | null>(null)
  const [problem, setProblem] = createSignal<ErrorText>()
  const fail = (e: unknown) => setProblem(describeError(e))
  const [view, { refetch }] = createResource(
    () => props.workflow.id,
    (id): Promise<ProposalsView | undefined> =>
      call("proposals.list", { workflowId: id }).catch(() => undefined),
  )
  onCleanup(window.robot.on("proposals.changed", () => void refetch()))
  onCleanup(window.robot.on("workflows.changed", () => void refetch()))
  // A request from outside (the chat, the memory page, a run) opens the tab Waiting and marks a card.
  createEffect(() => {
    const r = improveRequest()
    if (!r || r.workflowId !== props.workflow.id) return
    setTab("waiting")
    setFocus(r.proposalId)
    void refetch()
  })
  const v = () => view.latest
  const setSwitch = (enabled: boolean) => {
    setProblem(undefined)
    call("workflows.setSelfImprovement", { id: props.workflow.id, enabled })
      .then(() => refetch())
      .catch(fail)
  }
  return (
    <div class={styles.page} data-testid="improvement-panel">
      <p class={styles.muted}>{t("improve.hint")}</p>
      <div class={styles.row}>
        <span class={styles.title}>{t("improve.switch")}</span>
        <Switch
          label={t("improve.switch")}
          checked={v()?.enabled ?? props.workflow.selfImprovement}
          testId="improve-switch"
          onChange={setSwitch}
        />
      </div>
      <Show when={v()?.programBlock}>
        {(program) => (
          <p class={styles.warn} data-testid="improve-program">
            {t("improve.program", { program: program() })}
          </p>
        )}
      </Show>
      <Show when={problem()}>
        {(p) => (
          <p class={styles.error} role="alert" data-testid="improve-error">
            {t(p().key, p().params)}
          </p>
        )}
      </Show>
      <div class={styles.row} role="tablist" aria-label={t("improve.tabs")}>
        <For each={TABS}>
          {(name) => (
            <Button
              role="tab"
              aria-selected={tab() === name}
              variant={tab() === name ? "primary" : "default"}
              data-testid={`improve-tab-${name}`}
              onClick={() => setTab(name)}
            >
              {name === "waiting" && (v()?.waiting.length ?? 0) > 0
                ? t("improve.tab.waiting.n", { n: v()?.waiting.length ?? 0 })
                : t(`improve.tab.${name}`)}
            </Button>
          )}
        </For>
      </div>
      <Show when={tab() === "waiting"}>
        <div class={styles.page} role="tabpanel">
          <Show when={v() && !v()?.enabled}>
            <p class={styles.warn} role="status" data-testid="improve-off">
              {t("improve.off")}
            </p>
          </Show>
          <Show when={v()?.full}>
            <p class={styles.warn} role="status" data-testid="improve-full">
              {t("improve.full")}
            </p>
          </Show>
          <Show
            when={(v()?.waiting.length ?? 0) > 0}
            fallback={
              <p class={styles.muted} data-testid="improve-none">
                {t("improve.none")}
              </p>
            }
          >
            <ul class={styles.list}>
              <Keyed each={v()?.waiting} by={(p) => p.id}>
                {(p) => (
                  <Card
                    proposal={p()}
                    focused={focus() === p().id}
                    onError={fail}
                    onOpenRun={props.onOpenRun}
                  />
                )}
              </Keyed>
            </ul>
          </Show>
        </div>
      </Show>
      <Show when={tab() === "log"}>
        <div class={styles.page} role="tabpanel">
          <Show
            when={(v()?.log.length ?? 0) > 0}
            fallback={
              <p class={styles.muted} data-testid="improve-log-none">
                {t("improve.log.none")}
              </p>
            }
          >
            <ul class={styles.list} data-testid="improve-log">
              <Keyed each={v()?.log} by={(p) => p.id}>
                {(p) => (
                  <Card proposal={p()} focused={false} onError={fail} onOpenRun={props.onOpenRun} />
                )}
              </Keyed>
            </ul>
          </Show>
        </div>
      </Show>
    </div>
  )
}
