import {
  type ChecklistItem,
  type ChecklistWorld,
  checklistItemDone,
  type ImportChecklist,
  type Routine,
} from "@robot/shared"
import { Check } from "lucide-solid"
import { createResource, For, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./imports.module.css"

export interface ChecklistRow {
  readonly key: string
  readonly text: string
  readonly action: string
  readonly done: boolean
  readonly onAction: () => void
}

/** The checklist that an import leaves: a message from the app, not from an agent (spec 014). */
export const ChecklistCard = (props: {
  rows: readonly ChecklistRow[]
  testId: string
  place: "chat" | "canvas"
}) => {
  const { t } = useApp()
  const done = () => props.rows.filter((r) => r.done).length
  return (
    <section
      class={styles.checklist}
      data-testid={props.testId}
      data-place={props.place}
      data-author="app"
      aria-label={t("checklist.title")}
    >
      <div class={styles.head}>
        <span class={styles.from} data-testid="checklist-from">
          {t("checklist.from")}
        </span>
        <span class={styles.title}>{t("checklist.title")}</span>
        <span class={styles.hint} data-testid="checklist-progress">
          {t("checklist.progress", { done: done(), count: props.rows.length })}
        </span>
      </div>
      <span class={styles.hint}>{t("checklist.intro")}</span>
      <ul class={styles.items}>
        <For each={props.rows}>
          {(row) => (
            <li class={styles.item} data-testid="checklist-item" data-done={row.done}>
              <span class={styles.mark} aria-hidden="true">
                <Show when={row.done}>
                  <Check size={12} stroke-width={3} />
                </Show>
              </span>
              <span class={styles.text}>{row.text}</span>
              <Show
                when={!row.done}
                fallback={<span class={styles.doneLabel}>{t("checklist.done")}</span>}
              >
                <Button onClick={row.onAction} data-testid="checklist-action">
                  {row.action}
                </Button>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </section>
  )
}

/** The node number of a step: its place in the graph now, or the number in its id. */
const stepNumber = (stepId: string, steps: readonly { id: string }[]) => {
  const at = steps.findIndex((s) => s.id === stepId)
  return at >= 0 ? at + 1 : Number(stepId.replace(/\D/g, "")) || 0
}

/** The text and the button of one item. */
export const useChecklistRows = () => {
  const { t } = useApp()
  return (
    checklist: ImportChecklist,
    world: ChecklistWorld,
    act: (item: ChecklistItem) => void,
  ): ChecklistRow[] => {
    const steps = world.workflow?.steps ?? []
    return checklist.items.map((item, i) => {
      const done = checklistItemDone(item, world)
      const base = { key: `${checklist.id}-${i}`, done, onAction: () => act(item) }
      switch (item.kind) {
        case "routine":
          return {
            ...base,
            text: t("checklist.routine", { name: item.name }),
            action: t("checklist.turnOn"),
          }
        case "stepAgent":
          return {
            ...base,
            text: t("checklist.stepAgent", { n: stepNumber(item.stepId, steps), name: item.name }),
            action: t("checklist.pick"),
          }
        case "stepPlace":
          return {
            ...base,
            text: t("checklist.stepPlace", { n: stepNumber(item.stepId, steps), name: item.name }),
            action: t("checklist.pick"),
          }
        default:
          return { ...base, text: t("checklist.workflowOn"), action: t("checklist.turnOn") }
      }
    })
  }
}

/** The checklist message at the start of the chat of an imported agent. */
export const AgentChecklist = (props: { agentId: string }) => {
  const ui = useUi()
  const rows = useChecklistRows()
  // A linked server does not tell this window about its imports.
  const [checklist] = createResource(
    () => (ui.linked() ? undefined : props.agentId),
    (agentId) => call("checklists.forAgent", { agentId }).catch(() => null),
  )
  const [routines, { refetch }] = createResource(
    () => (checklist() ? ui.server()?.id : undefined),
    (serverId) => call("routines.list", { serverId }),
  )
  onCleanup(window.robot.on("routines.changed", () => void refetch()))
  const ready = () => {
    const list = checklist()
    const all = routines.latest as readonly Routine[] | undefined
    return list && all ? { list, all } : undefined
  }
  return (
    <Show when={ready()}>
      {(r) => (
        <ChecklistCard
          testId="chat-checklist"
          place="chat"
          rows={rows(r().list, { routine: (id) => r().all.find((x) => x.id === id) }, (item) => {
            if (item.kind === "routine") ui.reveal({ kind: "routine", id: item.routineId })
          })}
        />
      )}
    </Show>
  )
}
