import type { MessageKey, SetupFailCode, SetupList } from "@robot/shared"
import { ChevronDown, Play } from "lucide-solid"
import { createEffect, createSignal, on, Show } from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { type MenuItem, PopupMenu } from "../ui/Menu.tsx"
import { Presence } from "../ui/Presence.tsx"
import { showToast } from "../ui/toast.ts"
import styles from "./agents.module.css"
import { SetupEditorDialog } from "./SetupEditor.tsx"

const MENU_WIDTH = 320

const failKey = (code: SetupFailCode): MessageKey => {
  switch (code) {
    case "exit":
      return "setup.failed"
    case "timeout":
      return "setup.timeout"
    case "spawn":
      return "setup.spawn"
    default: {
      const never: never = code
      return never
    }
  }
}

const empty: SetupList = { actions: [], allowed: false, unreadable: false }

/**
 * The setup entry for the setup actions of this agent's workspace (spec 035). With no list it
 * opens the empty editor. A linked computer does not mount it.
 */
export const SetupMenu = (props: { agentId: string }) => {
  const { t } = useApp()
  const [list, setList] = createSignal<SetupList>(empty)
  const [busy, setBusy] = createSignal(false)
  const [open, setOpen] = createSignal<{ top: number; left: number }>()
  const [editing, setEditing] = createSignal(false)
  let trigger: HTMLButtonElement | undefined

  const load = () => {
    void call("setup.list", { agentId: props.agentId })
      .then(setList)
      .catch(() => setList(empty))
  }
  createEffect(on(() => props.agentId, load))

  const first = () => list().actions[0]
  const automatic = () => list().actions.some((action) => action.onOwnCopy || action.onTurnStart)

  const run = (name: string) => {
    if (busy()) return
    setBusy(true)
    void call("setup.run", { agentId: props.agentId, name })
      .then((result) => {
        if (result.status === "ran") showToast("success", "setup.ran", { name })
        else if (result.status === "failed") showToast("error", failKey(result.code), { name })
      })
      .catch((error: unknown) => {
        const described = describeError(error)
        showToast("error", described.key, described.params)
      })
      .finally(() => setBusy(false))
  }

  const allow = (on: boolean) => {
    void call("setup.allow", { agentId: props.agentId, on })
      .then(setList)
      .catch((error: unknown) => {
        const described = describeError(error)
        showToast("error", described.key, described.params)
      })
  }

  const items = (): MenuItem[] => {
    const now = list()
    const rows: MenuItem[] = now.actions.map((action) => ({
      label: action.name,
      title: action.command,
      icon: <Play size={14} />,
      disabled: busy(),
      testId: "setup-action",
      onSelect: () => run(action.name),
    }))
    if (automatic()) {
      const marked = now.actions.filter((action) => action.onOwnCopy || action.onTurnStart)
      rows.push({
        label: now.allowed ? t("setup.stop") : t("setup.allow"),
        title: marked.map((action) => action.command).join("\n"),
        testId: now.allowed ? "setup-stop" : "setup-allow",
        onSelect: () => allow(!now.allowed),
      })
    }
    rows.push({
      label: t("setup.manage"),
      testId: "setup-manage",
      onSelect: () => setEditing(true),
    })
    return rows
  }

  const toggle = () => {
    if (open()) return setOpen(undefined)
    load()
    const box = trigger?.getBoundingClientRect()
    if (!box) return
    setOpen({
      top: box.bottom + 4,
      left: Math.max(8, Math.min(box.left, window.innerWidth - MENU_WIDTH - 8)),
    })
  }

  return (
    <>
      <Show when={list().unreadable}>
        <button
          type="button"
          class={styles.setupRun}
          onClick={() => setEditing(true)}
          data-testid="setup-unreadable"
        >
          <span>{t("setup.unreadable")}</span>
        </button>
      </Show>
      <Show when={first()}>
        {(action) => (
          <button
            ref={trigger}
            type="button"
            class={styles.setupRun}
            aria-haspopup="menu"
            aria-expanded={open() !== undefined}
            onClick={toggle}
            data-testid="setup-run"
          >
            <span>{t("setup.run", { name: action().name })}</span>
            <ChevronDown size={14} />
          </button>
        )}
      </Show>
      <Show when={!list().unreadable && !first()}>
        <button
          type="button"
          class={styles.setupRun}
          onClick={() => setEditing(true)}
          data-testid="setup-manage"
        >
          <span>{t("setup.manage")}</span>
        </button>
      </Show>
      <Show when={open()}>
        {(at) => (
          <PopupMenu
            items={items()}
            top={at().top}
            left={at().left}
            width={MENU_WIDTH}
            label={t("setup.run", { name: first()?.name ?? "" })}
            testId="setup-menu"
            onClose={(refocus) => {
              setOpen(undefined)
              if (refocus) trigger?.focus()
            }}
          />
        )}
      </Show>
      <Presence when={editing()}>
        {() => (
          <SetupEditorDialog
            agentId={props.agentId}
            onClose={() => setEditing(false)}
            onSaved={(next) => {
              setList(next)
              setEditing(false)
            }}
          />
        )}
      </Presence>
    </>
  )
}
