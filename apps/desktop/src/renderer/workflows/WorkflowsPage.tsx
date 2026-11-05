import {
  type MessageKey,
  starterMenuOff,
  type Workflow,
  type WorkflowFilePreview,
  type WorkflowOwner,
} from "@robot/shared"
import { Ellipsis } from "lucide-solid"
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js"
import type { ErrorText } from "../lib/errors.ts"
import { isForView } from "../lib/events.ts"
import { showRevealed } from "../lib/reveal.ts"
import { call } from "../lib/rpc.ts"
import shell from "../shell/shell.module.css"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useOrgs } from "../state/orgs.tsx"
import { flashRow, openTarget, takeTarget } from "../state/target.ts"
import { useUi } from "../state/ui.tsx"
import { Confirm } from "../ui/Confirm.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import { Menu, type MenuItem } from "../ui/Menu.tsx"
import { Presence } from "../ui/Presence.tsx"
import { ownerChoice, ownerFromChoice } from "./ownerChoice.ts"
import { useOwnerNames } from "./useOwner.ts"
import { WorkflowEditor } from "./WorkflowEditor.tsx"
import {
  describeFileError,
  ExportCcDialog,
  ExportWorkflowsDialog,
  ImportWorkflowsDialog,
  WorkflowFileProblemDialog,
} from "./WorkflowFileDialogs.tsx"
import { WorkflowStarterDialog } from "./WorkflowStarterDialog.tsx"
import styles from "./workflows.module.css"

/** The filter "Owner" of the page: every workflow, the ones with no owner, or one owner. */
const ALL = "all"
const NONE = "none"

const WorkflowList = (props: {
  onOpen: (
    workflow: Workflow | null,
    options?: { frame?: boolean; owner?: WorkflowOwner | null },
  ) => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const agents = useAgents()
  const orgs = useOrgs()
  // A linked server that comes back online is asked again. Its workflows are not cached (012).
  const [workflows, { refetch }] = createResource(
    () => (ui.serverOffline() ? undefined : ui.server()?.id),
    (serverId) => call("workflows.list", { serverId }).catch(() => [] as readonly Workflow[]),
    { initialValue: [] as readonly Workflow[] },
  )
  onCleanup(
    window.robot.on("workflows.changed", ({ serverId }, from) => {
      // A server that syncs with this computer can send the same ids (spec 012, 019).
      const view = ui.linked() ? ui.server()?.id : undefined
      if (serverId === ui.server()?.id && isForView(view, from)) void refetch()
    }),
  )
  // The filter "Owner" (spec 010). An owner that is gone leaves the choices, so the list shows all.
  const [ownerFilter, setOwnerFilter] = createSignal(ALL)
  const filterOwner = (): WorkflowOwner | null =>
    ownerFilter() === ALL || ownerFilter() === NONE ? null : ownerFromChoice(ownerFilter())
  const ownerName = useOwnerNames(workflows)
  const shown = () =>
    workflows().filter((w) =>
      ownerFilter() === ALL
        ? true
        : ownerFilter() === NONE
          ? w.owner === null
          : ownerChoice(w.owner) === ownerFilter(),
    )
  createEffect(() => {
    const choice = ownerFilter()
    if (choice === ALL || choice === NONE) return
    const owner = ownerFromChoice(choice)
    const exists =
      owner?.kind === "organization" ? !!orgs.byId(owner.id) : !!owner && !!agents.byId(owner.id)
    if (!exists) setOwnerFilter(ALL)
  })
  // The Today page asks for a workflow: its card lights up. A workflow that is gone is dropped.
  createEffect(() => {
    const target = openTarget()
    const list = workflows()
    if (target?.kind !== "workflow" || workflows.loading) return
    // The card must be on screen, so a filter of the owner does not hide it.
    setOwnerFilter(ALL)
    if (list.some((w) => w.id === target.id)) {
      queueMicrotask(() => {
        if (flashRow(`[data-workflow-id="${target.id}"]`)) takeTarget("workflow")
      })
    } else takeTarget("workflow")
  })
  // A checklist item asked for one workflow: show its card and focus its switch.
  createEffect(() => {
    const target = ui.revealTarget()
    if (target?.kind !== "workflow" || !workflows().some((w) => w.id === target.id)) return
    queueMicrotask(() => {
      const card = document.querySelector<HTMLElement>(`[data-workflow-id="${target.id}"]`)
      if (card) showRevealed(card, "wf-enabled")
      ui.clearReveal()
    })
  })
  const [exporting, setExporting] = createSignal(false)
  const [exportingCc, setExportingCc] = createSignal(false)
  const [importPreview, setImportPreview] = createSignal<WorkflowFilePreview>()
  const [fileProblem, setFileProblem] = createSignal<ErrorText>()
  const [starting, setStarting] = createSignal(false)
  // The danger button of a card asks first (spec 000, "Danger buttons").
  const [deleting, setDeleting] = createSignal<string>()

  /**
   * "New from a starter" (spec 010, "Starters"). It is off, with the reason, when no agent exists
   * and for a linked computer without the switch "Can create and change agents".
   */
  const starterItem = (): MenuItem => {
    const off = starterMenuOff({ canChange: ui.canChange(), agentCount: agents.agents().length })
    return {
      label: t("workflowStarter.menu"),
      onSelect: () => setStarting(true),
      testId: "wf-menu-starter",
      ...(off
        ? {
            disabled: true,
            reason:
              off === "no_switch"
                ? t("workflowStarter.menu.noSwitch", { name: ui.server()?.name ?? "" })
                : t("workflowStarter.menu.noAgent"),
          }
        : {}),
    }
  }

  /** Asks for a workflow file. A readable file opens the dialog that lists its workflows. */
  const startImport = async () => {
    const serverId = ui.server()?.id
    if (!serverId) return
    try {
      const found = await call("workflowFile.open", { serverId })
      if (found) setImportPreview(found)
    } catch (e) {
      setFileProblem(describeFileError(e))
    }
  }

  return (
    <div class={styles.list} data-testid="wf-list">
      <div class={styles.bar}>
        <Show when={ui.canChange()}>
          <Button
            variant="primary"
            // A new workflow starts with the owner that the filter names (spec 010).
            onClick={() => props.onOpen(null, { owner: filterOwner() })}
            data-testid="wf-new"
          >
            {t("workflows.new")}
          </Button>
        </Show>
        <label class={styles.inline}>
          {t("workflows.owner")}
          <select
            class={styles.input}
            aria-label={t("workflows.owner.filter")}
            value={ownerFilter()}
            onChange={(e) => setOwnerFilter(e.currentTarget.value)}
            data-testid="wf-owner-filter"
          >
            <option value={ALL} selected={ownerFilter() === ALL}>
              {t("workflows.owner.all")}
            </option>
            <option value={NONE} selected={ownerFilter() === NONE}>
              {t("workflows.owner.none")}
            </option>
            <Show when={orgs.orgs().length > 0}>
              <optgroup label={t("workflows.owner.organizations")}>
                <For each={orgs.orgs()}>
                  {(o) => {
                    const value = ownerChoice({ kind: "organization", id: o.id })
                    return (
                      <option value={value} selected={ownerFilter() === value}>
                        {o.name}
                      </option>
                    )
                  }}
                </For>
              </optgroup>
            </Show>
            <Show when={agents.agents().length > 0}>
              <optgroup label={t("workflows.owner.agents")}>
                <For each={agents.agents()}>
                  {(a) => {
                    const value = ownerChoice({ kind: "agent", id: a.id })
                    return (
                      <option value={value} selected={ownerFilter() === value}>
                        {a.name}
                      </option>
                    )
                  }}
                </For>
              </optgroup>
            </Show>
          </select>
        </label>
        <Menu
          label={t("workflowFile.menu")}
          icon={<Ellipsis size={16} />}
          testId="wf-menu"
          items={
            // The workflow file stays on the server (spec 012, "Workflows").
            ui.linked()
              ? [
                  {
                    label: t("link.openOnServer", { name: ui.server()?.name ?? "" }),
                    onSelect: () => {},
                    disabled: true,
                    testId: "wf-menu-open-on-server",
                  },
                  starterItem(),
                ]
              : [
                  {
                    label: t("workflowFile.menu.export"),
                    onSelect: () => setExporting(true),
                    testId: "wf-menu-export",
                  },
                  {
                    label: t("workflowFile.menu.exportCc"),
                    onSelect: () => setExportingCc(true),
                    testId: "wf-menu-export-cc",
                  },
                  {
                    label: t("workflowFile.menu.importFile"),
                    onSelect: () => void startImport(),
                    testId: "wf-menu-import-file",
                  },
                  starterItem(),
                ]
          }
        />
      </div>
      <Presence when={exportingCc()}>
        {() => <ExportCcDialog workflows={workflows()} onClose={() => setExportingCc(false)} />}
      </Presence>
      <Presence when={exporting()}>
        {() => (
          <ExportWorkflowsDialog workflows={workflows()} onClose={() => setExporting(false)} />
        )}
      </Presence>
      <Presence when={importPreview()}>
        {(preview) => (
          <ImportWorkflowsDialog preview={preview} onClose={() => setImportPreview(undefined)} />
        )}
      </Presence>
      <Presence when={starting()}>
        {() => (
          <WorkflowStarterDialog
            onClose={() => setStarting(false)}
            onCreated={(workflow) => {
              setStarting(false)
              props.onOpen(workflow, { frame: true })
            }}
          />
        )}
      </Presence>
      <Presence when={fileProblem()}>
        {(problem) => (
          <WorkflowFileProblemDialog problem={problem} onClose={() => setFileProblem(undefined)} />
        )}
      </Presence>
      <Show
        when={shown().length > 0}
        fallback={
          <p class={styles.hint} data-testid="wf-list-empty">
            {t("workflows.empty")}
          </p>
        }
      >
        <For each={shown()}>
          {(w) => (
            <div
              class={styles.card}
              data-testid="wf-card"
              data-workflow-id={w.id}
              data-running={w.running}
              data-enabled={w.enabled}
            >
              <div class={styles.cardMain}>
                <strong>{w.name}</strong>
                <span class={styles.hint}>
                  {t(`workflows.trigger.${w.trigger.kind}` as MessageKey)} ·{" "}
                  {t("workflows.stepCount", { n: w.steps.length })}
                  {w.running ? ` · ${t("workflows.runState.running")}` : ""}
                  {w.enabled ? "" : ` · ${t("workflows.off")}`}
                </span>
                <Show when={w.owner}>
                  {(owner) => (
                    <span class={styles.hint} data-testid="wf-owner">
                      {t("workflows.owner.card", { name: ownerName(owner()) })}
                    </span>
                  )}
                </Show>
                <Show when={w.runsOn !== null}>
                  <span class={styles.hint} data-testid="wf-runs-on">
                    {t("sync.runsOn", { name: w.runsOn || t("sync.anotherComputer") })}
                  </span>
                </Show>
              </div>
              <Switch
                label={t("workflows.enabled.label", { name: w.name })}
                checked={w.enabled}
                disabled={!ui.canChange()}
                onChange={(enabled) => call("workflows.update", { id: w.id, patch: { enabled } })}
                testId="wf-enabled"
              />
              <Show
                // A client does not offer "Run on this computer": Run is off for it (spec 012).
                when={w.runsOn === null || ui.linked()}
                fallback={
                  <Button
                    onClick={() => call("workflows.runHere", { id: w.id })}
                    data-testid="wf-run-here"
                  >
                    {t("sync.runHere")}
                  </Button>
                }
              >
                <Button
                  onClick={() => call("workflows.run", { id: w.id })}
                  disabled={w.running || w.runsOn !== null}
                  data-testid="wf-card-run"
                >
                  {t("workflows.run")}
                </Button>
              </Show>
              <Button onClick={() => props.onOpen(w)} data-testid="wf-open">
                {t("workflows.open")}
              </Button>
              <Show when={ui.canChange()}>
                <Show
                  when={deleting() === w.id}
                  fallback={
                    <Button
                      variant="danger"
                      disabled={w.running}
                      onClick={() => setDeleting(w.id)}
                      data-testid="wf-delete-card"
                    >
                      {t("agents.memory.delete")}
                    </Button>
                  }
                >
                  <Confirm
                    ask={t("workflows.delete.ask", { name: w.name })}
                    confirm={t("agents.memory.delete")}
                    keep={t("common.keep")}
                    onConfirm={() => {
                      setDeleting(undefined)
                      void call("workflows.delete", { id: w.id })
                    }}
                    onKeep={() => setDeleting(undefined)}
                    testId="wf-delete-card-ask"
                    confirmTestId="wf-delete-card-confirm"
                    keepTestId="wf-delete-card-keep"
                  />
                </Show>
              </Show>
            </div>
          )}
        </For>
      </Show>
    </div>
  )
}

/** The page of workflows. Routines have their own page (spec 001). */
export const WorkflowsPage = () => {
  const { t } = useApp()
  const ui = useUi()
  const [open, setOpen] = createSignal<{
    workflow: Workflow | null
    frame?: boolean
    owner?: WorkflowOwner | null
  }>()
  // The Today page asks for a workflow: leave the editor so the list can show the card.
  createEffect(() => {
    if (openTarget()?.kind === "workflow") setOpen(undefined)
  })
  // A workflow belongs to one server. Another server on screen closes the editor.
  createEffect(
    on(
      () => ui.server()?.id,
      () => setOpen(undefined),
      { defer: true },
    ),
  )
  // A checklist item opens the list where the user does the step (spec 014).
  createEffect(() => {
    if (ui.revealTarget()?.kind === "workflow") setOpen(undefined)
  })
  return (
    <div class={`${shell.page} ${styles.page}`} data-testid="workflows-page">
      <Show
        when={open()}
        fallback={
          <Show
            when={!ui.serverOffline()}
            fallback={
              <p class={shell.pageNotice} data-testid="wf-offline">
                {t("link.state.offline", { name: ui.server()?.name ?? "" })}
              </p>
            }
          >
            <WorkflowList
              onOpen={(workflow, options) =>
                setOpen({
                  workflow,
                  ...(options?.frame ? { frame: true } : {}),
                  ...(options?.owner ? { owner: options.owner } : {}),
                })
              }
            />
          </Show>
        }
      >
        {(o) => (
          <WorkflowEditor
            workflow={o().workflow}
            onBack={() => setOpen(undefined)}
            {...(o().frame ? { frame: true } : {})}
            owner={o().owner ?? null}
          />
        )}
      </Show>
    </div>
  )
}
