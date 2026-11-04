import { type Agent, type AgentModel, type MarkPlace, NO_MARKS, runtimeModel } from "@robot/shared"
import { Ellipsis } from "lucide-solid"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import { ChatView } from "../chat/ChatView.tsx"
import { ContextMeter } from "../chat/ContextMeter.tsx"
import { formatUntil } from "../chat/format.ts"
import { createHandoverState, HandoverDialog, offKey } from "../chat/Handover.tsx"
import { PlaceMarksLine } from "../chat/PlaceMarksLine.tsx"
import { ThreadList } from "../chat/ThreadList.tsx"
import { createThreads, openThreadOf } from "../chat/threads.ts"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import { TeamsMark } from "../settings/TeamsMark.tsx"
import type { PlaceView } from "../shell/Shell.tsx"
import { useApp } from "../state/app.tsx"
import { memoryTarget } from "../state/memoryLink.ts"
import { profileTarget, setProfileTarget } from "../state/profileTarget.ts"
import { useProviders } from "../state/providers.tsx"
import { useUi } from "../state/ui.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Menu } from "../ui/Menu.tsx"
import { Presence } from "../ui/Presence.tsx"
import { AgentActivity } from "./AgentActivity.tsx"
import { AgentProfileDialog } from "./AgentDialogs.tsx"
import styles from "./agents.module.css"
import {
  BrowserCard,
  BrowserHeaderButton,
  BrowserLarge,
  createBrowserView,
} from "./BrowserPane.tsx"
import { Face } from "./Face.tsx"
import {
  closeTeachForm,
  DraftCard,
  openTeachForm,
  TeachDialog,
  teachBlocked,
  teachFormFor,
  useTeach,
} from "./Teach.tsx"

/**
 * A runtime model shows with its version. An API model shows its id, which has the version. A
 * model of none shows the words for "no model".
 */
const useModelName = () => {
  const { t } = useApp()
  const providers = useProviders()
  return (model: AgentModel | null) => {
    if (!model) return t("agents.noModel")
    const known = runtimeModel(providers.byId(model.accountId)?.kind, model.model)
    return known?.labelKey ? t(known.labelKey) : (known?.label ?? model.model)
  }
}

/**
 * The hold of the main model of an agent while it lasts (spec 006, "Backup model"). A linked device
 * shows what its server tells it. The hold also ends here when its time passes, with no new push.
 */
const createHold = (agent: () => Agent) => {
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    const until = agent().hold?.until
    if (until === undefined) return
    const wait = until - Date.now()
    if (wait <= 0) return setNow(Date.now())
    const timer = setTimeout(() => setNow(Date.now()), Math.min(wait + 20, 2 ** 31 - 1))
    onCleanup(() => clearTimeout(timer))
  })
  return () => {
    const held = agent().hold
    return held && held.until > now() ? held : null
  }
}

/**
 * The line under the header while the main model is held: "Backup until <time>" and the button
 * that ends the hold (spec 006). A linked device shows the button only with the switch "Can create
 * and change agents" (spec 012). It is a line of its own because the header has no room for it.
 */
const HoldLine = (props: { agent: Agent }) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const nameOf = useModelName()
  const hold = createHold(() => props.agent)
  const useMain = () => call("agents.useMain", { id: props.agent.id }).catch(() => undefined)
  return (
    <Show when={hold()}>
      {(held) => (
        <div class={styles.holdLine} data-testid="chat-header-hold">
          <span data-testid="chat-header-backup">
            {t("backup.until", { time: formatUntil(app.locale(), held().until) })}
          </span>
          <Show when={ui.canChange()}>
            <button
              type="button"
              class={styles.holdButton}
              onClick={useMain}
              data-testid="chat-header-use-main"
            >
              {t("backup.useMain", { model: nameOf(props.agent.model) })}
            </button>
          </Show>
        </div>
      )}
    </Show>
  )
}

const Header = (props: { agent: Agent; picking: boolean; setPicking: (on: boolean) => void }) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const [open, setOpen] = createSignal(false)
  // The line "Suggested for memory" in the chat opens the profile on the tab Proposals (spec 008).
  createEffect(() => {
    if (memoryTarget()?.agentId === props.agent.id) setOpen(true)
  })
  // A page that names this agent (the org chart, spec 029) asks for the profile once.
  createEffect(() => {
    if (profileTarget() !== props.agent.id) return
    setProfileTarget(undefined)
    setOpen(true)
  })
  const teach = useTeach()
  // "Hand over" is off with a reason in words (spec 003, "Hand over"). This computer only.
  const handover = createHandoverState(
    () => props.agent.id,
    () => openThreadOf(props.agent.id),
  )
  const [handingOver, setHandingOver] = createSignal(false)
  const nameOf = useModelName()
  // While the main model is held, the header shows the backup model that takes the turns (spec
  // 006, "Backup model"). The time the hold ends, and the button that ends it, are in the line
  // under the header (`HoldLine`): the header is one row and has no room for them in a narrow
  // chat. The hold also ends here when its time passes.
  const hold = createHold(() => props.agent)
  const modelName = () => nameOf(hold()?.model ?? props.agent.model)
  return (
    <>
      {/* A client without the switch opens the profile too, as read-only text (spec 012). */}
      <button
        type="button"
        class={styles.headerName}
        aria-label={t("agents.openProfile", { name: props.agent.name })}
        title={props.agent.name}
        onClick={() => setOpen(true)}
        data-readonly={ui.canChange() ? undefined : "true"}
        data-testid="chat-header-agent"
      >
        <Face
          face={props.agent.face}
          image={props.agent.faceImage}
          size={24}
          agentId={props.agent.id}
        />
        <span>{props.agent.name}</span>
      </button>
      <Show
        when={ui.canChange()}
        fallback={
          <span class={styles.headerModel} data-testid="chat-header-model" data-readonly="true">
            {modelName()}
          </span>
        }
      >
        <button
          type="button"
          class={styles.headerModel}
          aria-label={t("model.choose")}
          onClick={() => props.setPicking(true)}
          data-testid="chat-header-model"
        >
          {modelName()}
        </button>
      </Show>
      {/* The Teams link serves this agent: a muted mark, with the state word if it is not On. */}
      <TeamsMark kind="agent" id={props.agent.id} />
      {/* A linked computer and the phone show the main thread only (spec 003, 011, 012). */}
      <Show when={!ui.linked()}>
        <ThreadList agentId={props.agent.id} />
        <ContextMeter agentId={props.agent.id} threadId={openThreadOf(props.agent.id)} />
      </Show>
      {/* "Teach a task" needs the browser of this computer: a client has no menu (spec 017). */}
      <Show when={!ui.linked()}>
        <Menu
          label={t("chat.menu")}
          icon={<Ellipsis size={16} />}
          testId="chat-header-menu"
          items={[
            {
              label: t("teach.menu"),
              onSelect: () => openTeachForm(props.agent.id),
              disabled: teachBlocked(teach(), props.agent.id) !== undefined,
              testId: "chat-menu-teach",
            },
            ...(() => {
              const reason = teachBlocked(teach(), props.agent.id)
              return reason
                ? [
                    {
                      label: t(reason.key, reason.params),
                      onSelect: () => {},
                      heading: true,
                      testId: "chat-menu-teach-reason",
                    },
                  ]
                : []
            })(),
            {
              label: t("handover.menu"),
              onSelect: () => setHandingOver(true),
              disabled: handover()?.off !== null,
              testId: "chat-menu-handover",
            },
            ...(() => {
              const off = handover()?.off
              return off
                ? [
                    {
                      label: t(offKey(off)),
                      onSelect: () => {},
                      heading: true,
                      testId: "chat-menu-handover-reason",
                    },
                  ]
                : []
            })(),
          ]}
        />
        <Presence when={handingOver()}>
          {() => (
            <HandoverDialog
              agentId={props.agent.id}
              threadId={openThreadOf(props.agent.id)}
              onClose={() => setHandingOver(false)}
            />
          )}
        </Presence>
      </Show>
      <Presence when={open()}>
        {() => <AgentProfileDialog agent={props.agent} onClose={() => setOpen(false)} />}
      </Presence>
      <Presence when={props.picking}>
        {() => <ModelDialog agent={props.agent} onClose={() => props.setPicking(false)} />}
      </Presence>
    </>
  )
}

/** Changes the model of an agent. The next turn uses it; earlier turns stay. */
const ModelDialog = (props: { agent: Agent; onClose: () => void }) => {
  const { t } = useApp()
  const [model, setModel] = createSignal<AgentModel | null>(props.agent.model)
  const [error, setError] = createSignal<ErrorText>()
  const save = async () => {
    try {
      await call("agents.update", { id: props.agent.id, patch: { model: model() } })
      props.onClose()
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <Dialog label={t("model.choose")} onClose={props.onClose} testId="model-dialog">
      <div class={styles.form}>
        <h2 class={styles.title}>{t("model.choose")}</h2>
        <ModelPicker value={model()} onChange={setModel} />
        <Show when={error()}>
          {(err) => <div class={styles.error}>{t(err().key, err().params)}</div>}
        </Show>
        <div class={styles.actions}>
          <Button onClick={props.onClose}>{t("agents.cancel")}</Button>
          <Button variant="primary" onClick={save} disabled={!model()} data-testid="model-save">
            {t("model.save")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}

/**
 * The header line of the marks of the open chat or thread (spec 007). The main thread holds the
 * marks of the agent. A thread is a place of its own and holds its own marks. A linked computer
 * and the phone show the main thread only.
 */
const AgentMarksLine = (props: { agent: Agent }) => {
  const ui = useUi()
  const threads = createThreads(() => props.agent.id)
  const threadId = () => (ui.linked() ? null : openThreadOf(props.agent.id))
  const place = (): MarkPlace => {
    const id = threadId()
    return id ? { kind: "thread", id } : { kind: "agent", id: props.agent.id }
  }
  const marks = () => {
    const id = threadId()
    if (!id)
      return { outside: props.agent.outside ?? null, sensitive: props.agent.sensitive ?? null }
    return threads.list.threads.find((x) => x.id === id)?.marks ?? NO_MARKS
  }
  return <PlaceMarksLine place={place()} marks={marks()} />
}

/** The first screen of a chat: a large face, the name and the role. Nothing moves. */
const Start = (props: { agent: Agent }) => {
  const { t } = useApp()
  return (
    <div class={styles.start} data-testid="chat-start">
      <Face face={props.agent.face} image={props.agent.faceImage} size={80} />
      <h2>{props.agent.name}</h2>
      <p>{t("chat.start")}</p>
      <Show when={props.agent.role}>
        <p>{props.agent.role}</p>
      </Show>
    </div>
  )
}

export const agentPlaceView = (agent: () => Agent | undefined): PlaceView | undefined => {
  const current = agent()
  if (!current) return undefined
  const ui = useUi()
  const [picking, setPicking] = createSignal(false)
  const teach = useTeach()
  /** The browser of this agent: small in the activity panel, large over the conversation. */
  const browser = createBrowserView(current.id, ui.linked)
  /** The draft skill card of this agent, while "Teach a task" has one (spec 017). */
  const draft = (agentId: string) => {
    const now = teach()
    return now.phase !== "idle" && now.phase !== "recording" && now.agentId === agentId
      ? now
      : undefined
  }
  return {
    header: (
      <Show when={agent()}>
        {(a) => <Header agent={a()} picking={picking()} setPicking={setPicking} />}
      </Show>
    ),
    headerActions: <BrowserHeaderButton view={browser} panelVisible={ui.activityPanelVisible} />,
    panel: (
      <Show when={agent()}>
        {(a) => (
          <>
            <BrowserCard agentId={a().id} view={browser} />
            <AgentActivity agent={a()} />
          </>
        )}
      </Show>
    ),
    body: (
      <Show when={agent()}>
        {(a) => (
          <div class={styles.split}>
            {/* The chat keeps its whole width. The large browser covers it only when the user asks. */}
            <div class={styles.chatColumn} inert={browser.large()}>
              <HoldLine agent={a()} />
              <AgentMarksLine agent={a()} />
              <ChatView
                agent={a()}
                threadId={ui.linked() ? null : openThreadOf(a().id)}
                start={<Start agent={a()} />}
                onConnect={() => ui.openSettings("providers")}
                onChooseModel={() => setPicking(true)}
                end={
                  <Show when={!ui.linked() && draft(a().id)}>
                    {(state) => <DraftCard state={state()} />}
                  </Show>
                }
              />
            </div>
            <BrowserLarge agentId={a().id} view={browser} />
            <Presence when={!ui.linked() && teachFormFor() === a().id}>
              {() => <TeachDialog agentId={a().id} onClose={closeTeachForm} />}
            </Presence>
          </div>
        )}
      </Show>
    ),
  }
}
