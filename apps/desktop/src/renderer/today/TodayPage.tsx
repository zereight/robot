import {
  listPage,
  type MessageKey,
  TODAY_PAGE_SIZE,
  type TodayGroupId,
  type TodayKind,
  type TodayOpen,
  type TodayRow,
  visibleGroups,
} from "@robot/shared"
import {
  CalendarClock,
  CircleCheck,
  CirclePause,
  CircleX,
  Eye,
  Gauge,
  KeyRound,
  Link2,
  MessageCircleQuestion,
  OctagonX,
  ShieldAlert,
} from "lucide-solid"
import { createMemo, createSignal, For, type JSX, Show } from "solid-js"
import { Face } from "../agents/Face.tsx"
import { openThread } from "../chat/threads.ts"
import shell from "../shell/shell.module.css"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { setFocusMessage } from "../state/focus.ts"
import { setOpenTarget } from "../state/target.ts"
import { useToday } from "../state/today.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { rowLine, rowSource, whenText } from "./format.ts"
import styles from "./today.module.css"

const ICONS: Record<TodayKind, () => JSX.Element> = {
  approval: () => <ShieldAlert size={18} />,
  question: () => <MessageCircleQuestion size={18} />,
  part_failed: () => <CircleX size={18} />,
  part_review: () => <Eye size={18} />,
  task_failed: () => <CircleX size={18} />,
  task_blocked: () => <OctagonX size={18} />,
  routine_failed: () => <CircleX size={18} />,
  routine_paused: () => <CirclePause size={18} />,
  account_signin: () => <KeyRound size={18} />,
  account_limit: () => <Gauge size={18} />,
  teams_signed_out: () => <Link2 size={18} />,
  teams_paused: () => <CirclePause size={18} />,
  routine_done: () => <CircleCheck size={18} />,
  workflow_done: () => <CircleCheck size={18} />,
  routine_next: () => <CalendarClock size={18} />,
  workflow_next: () => <CalendarClock size={18} />,
  followup_next: () => <CalendarClock size={18} />,
}

const TodayRowView = (props: { row: TodayRow; group: TodayGroupId; onOpen: () => void }) => {
  const app = useApp()
  const { t } = app
  const agents = useAgents()
  const agent = () => (props.row.agentId ? agents.byId(props.row.agentId) : undefined)
  const kind = () => t(`today.kind.${props.row.kind}` as MessageKey)
  const line = () => rowLine(t, app.locale(), props.row)
  const source = () => rowSource(t, app.locale(), props.row)
  return (
    <li>
      <button
        type="button"
        class={styles.row}
        data-testid="today-row"
        data-kind={props.row.kind}
        data-attention={props.group}
        aria-label={`${kind()}: ${line()}${source() ? `. ${source()}` : ""}`}
        onClick={props.onOpen}
      >
        <span class={styles.icon} title={kind()} aria-hidden="true">
          {ICONS[props.row.kind]()}
        </span>
        <span class={styles.face} aria-hidden="true">
          <Show when={agent()}>
            {(a) => <Face face={a().face} image={a().faceImage} size={24} agentId={a().id} />}
          </Show>
        </span>
        <span class={styles.text}>
          <span class={styles.line} data-testid="today-line">
            {line()}
          </span>
          <Show when={source()}>
            <span class={styles.meta} data-testid="today-source">
              {source()}
            </span>
          </Show>
        </span>
        <time class={styles.time} data-testid="today-time">
          {whenText(app.locale(), props.row.at)}
        </time>
      </button>
    </li>
  )
}

/** The Today page (spec 021): what waits for the user, what went wrong, what ran, what runs next. */
export const TodayPage = () => {
  const { t } = useApp()
  const today = useToday()
  const ui = useUi()
  const [shown, setShown] = createSignal<Partial<Record<TodayGroupId, number>>>({})
  const view = createMemo(() => {
    const snapshot = today.snapshot()
    return snapshot ? visibleGroups(snapshot, shown()) : []
  })

  /** A click opens the place at the card, the task, the routine, the workflow or the account. */
  const open = (target: TodayOpen) => {
    switch (target.kind) {
      case "place":
        if (target.target.kind === "agent") openThread(target.target.id, target.target.threadId)
        ui.selectPlace({ kind: target.target.kind, id: target.target.id }, ui.localServer()?.id)
        setFocusMessage(target.target.messageId)
        return
      case "task":
        setOpenTarget({ kind: "task", id: target.id })
        ui.selectPage("tasks")
        return
      case "routine":
      case "workflow":
        setOpenTarget({ kind: target.kind, id: target.id })
        ui.selectPage(listPage(target.kind))
        return
      case "account":
        setOpenTarget({ kind: "account", id: target.id })
        ui.openSettings("providers")
        return
      case "teams":
        ui.openSettings("teams")
    }
  }

  return (
    <div class={`${shell.page} ${styles.page}`} data-testid="today-page">
      <For each={view()}>
        {(entry) => (
          <section
            class={styles.group}
            data-testid={`today-group-${entry.group.id}`}
            aria-labelledby={`today-heading-${entry.group.id}`}
          >
            <h2 class={styles.heading} id={`today-heading-${entry.group.id}`}>
              {t(`today.group.${entry.group.id}` as MessageKey)}
              <Show when={entry.group.rows.length > 0}>
                <span class={styles.count} data-testid="today-count">
                  {entry.group.rows.length}
                </span>
              </Show>
            </h2>
            <Show
              when={!entry.group.unreadable}
              fallback={
                <p class={styles.muted} data-testid="today-unreadable">
                  {t("today.unreadable")}
                </p>
              }
            >
              <Show
                when={entry.rows.length > 0}
                fallback={
                  <p class={styles.muted} data-testid="today-empty">
                    {t("today.empty")}
                  </p>
                }
              >
                <ul class={styles.list}>
                  <For each={entry.rows}>
                    {(row) => (
                      <TodayRowView
                        row={row}
                        group={entry.group.id}
                        onOpen={() => open(row.open)}
                      />
                    )}
                  </For>
                  <Show when={entry.more > 0}>
                    <li>
                      <Button
                        class={styles.more}
                        onClick={() =>
                          setShown({
                            ...shown(),
                            [entry.group.id]: entry.rows.length + TODAY_PAGE_SIZE,
                          })
                        }
                        data-testid="today-more"
                      >
                        {t("today.more")}
                      </Button>
                    </li>
                  </Show>
                </ul>
              </Show>
            </Show>
          </section>
        )}
      </For>
    </div>
  )
}
