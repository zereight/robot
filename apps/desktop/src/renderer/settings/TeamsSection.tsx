import {
  type Agent,
  type Channel,
  isLimitProblem,
  type MessageKey,
  problemField,
  TEAMS_DIALOG_FACT_KEYS,
  TEAMS_FACT_KEYS,
  type TeamsFieldName,
  type TeamsPatch,
  type TeamsTargetKind,
  teamsPauseReasonKey,
  teamsRecordReasonKey,
  teamsStateTextKey,
} from "@robot/shared"
import {
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch as SwitchCase,
} from "solid-js"
import { formatDateTime, formatTime } from "../chat/format.ts"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { setOpenTarget } from "../state/target.ts"
import { useTeams } from "../state/teams.tsx"
import { useUi } from "../state/ui.tsx"
import { wholeBox } from "../teams/place.ts"
import { Button, Segmented, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import { NameList } from "./NameList.tsx"
import styles from "./settings.module.css"
import teamStyles from "./teams.module.css"

/**
 * What covers the place of the Teams page when it is open. The page is a native view above the
 * screen, so it hides while a box or a menu is open. The settings page is a dialog too, and it is
 * not a cover.
 */
const COVERS = '[role="dialog"]:not([data-testid="settings"]), [role="menu"]'

/**
 * The empty box where the Teams page shows. The page is a native view above this screen: this box
 * only keeps its place and tells the app where it is, on each frame. The place is given only while
 * the scroll area shows all of the box. A native view cannot show a part of itself, and a cut place
 * would make the page smaller as the box scrolls out. So the page hides until the box is whole
 * again, and it never covers the list of settings beside it.
 */
const PageBox = () => {
  const { t } = useApp()
  let box: HTMLElement | undefined
  onMount(() => {
    // The page shows only while the whole box shows, so a box that opens below the fold scrolls
    // into view once. Otherwise "Show the Teams page" would seem to do nothing.
    box?.scrollIntoView?.({ block: "nearest" })
    let last = ""
    const send = (bounds: { x: number; y: number; width: number; height: number } | null) => {
      const key = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : "hidden"
      if (key === last) return
      last = key
      void call("teams.place", { bounds }).catch(() => {})
    }
    let frame = requestAnimationFrame(function measure() {
      const rect = box?.getBoundingClientRect()
      const area = box?.parentElement?.closest("section")?.getBoundingClientRect()
      const covered = document.querySelector(COVERS) !== null
      send(rect && area && !covered ? wholeBox(rect, area) : null)
      frame = requestAnimationFrame(measure)
    })
    onCleanup(() => {
      cancelAnimationFrame(frame)
      void call("teams.place", { bounds: null }).catch(() => {})
    })
  })
  return (
    <section
      ref={box}
      class={teamStyles.page}
      aria-label={t("teams.page.label")}
      data-testid="teams-page-box"
    />
  )
}

/**
 * Settings, Teams (spec 028): the page text, the sign-in, the Teams page, the form, the switch and
 * the state of the Teams link. This computer only: a linked device shows no such part.
 */
export const TeamsSection = () => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const teams = useTeams()
  const view = () => teams.view()
  const fields = () => view().fields

  const [agents, { refetch: refetchAgents }] = createResource(
    () => ui.localServer()?.id,
    (serverId) => call("agents.list", { serverId, archived: false }),
    { initialValue: [] as readonly Agent[] },
  )
  const [channels, { refetch: refetchChannels }] = createResource(
    () => ui.localServer()?.id,
    (serverId) => call("channels.list", { serverId }),
    { initialValue: [] as readonly Channel[] },
  )
  onCleanup(window.robot.on("agents.changed", () => void refetchAgents()))
  onCleanup(window.robot.on("channels.changed", () => void refetchChannels()))
  onCleanup(window.robot.on("places.changed", () => void refetchChannels()))
  // The page hides when the user leaves this part: no Teams page stays on its own.
  onCleanup(() => {
    void call("teams.hidePage").catch(() => {})
  })

  const [error, setError] = createSignal<ErrorText>()
  /** The switch refused: every reason shows under its field. */
  const [showReasons, setShowReasons] = createSignal(false)
  const [dialog, setDialog] = createSignal<"on" | "signOut" | "remove">()
  /** The kind of target in the form. It differs from the saved kind until a target is picked. */
  const [pickedKind, setPickedKind] = createSignal<TeamsTargetKind>()
  const kind = (): TeamsTargetKind => pickedKind() ?? fields().targetKind ?? "agent"

  /** Runs a call and shows the reason when it fails. */
  const run = async (action: () => Promise<unknown>) => {
    setError(undefined)
    try {
      await action()
      return true
    } catch (e) {
      setError(describeError(e))
      return false
    }
  }
  const commit = (patch: TeamsPatch) => run(() => call("teams.update", patch))

  /** Fields that the switch locks while it is on. */
  const locked = () => view().enabled

  const reasons = (field: TeamsFieldName) => (
    <For
      each={view().problems.filter(
        (p) => problemField(p) === field && (showReasons() || isLimitProblem(p)),
      )}
    >
      {(problem) => (
        <div class={teamStyles.problem} role="alert" data-testid={`teams-problem-${problem}`}>
          {t(`teams.problem.${problem}` as MessageKey)}
        </div>
      )}
    </For>
  )

  const stateText = () => {
    const v = view()
    if (v.state === "on")
      return t("teams.state.on", {
        title: v.fields.chatTitle,
        time: v.lastReadAt === null ? "" : formatTime(app.locale(), v.lastReadAt),
      })
    return t(teamsStateTextKey(v.state, v.chat))
  }

  const toggle = (next: boolean) => {
    if (!next) {
      setShowReasons(false)
      void run(() => call("teams.setEnabled", { enabled: false }))
      return
    }
    // The switch stays off while something is missing, and says what.
    if (view().problems.length > 0) {
      setShowReasons(true)
      return
    }
    setError(undefined)
    setDialog("on")
  }
  const turnOn = async () => {
    const ok = await run(async () => {
      const next = await call("teams.setEnabled", { enabled: true })
      if (!next.enabled) setShowReasons(true)
    })
    if (ok) setDialog(undefined)
  }

  // Drafts: a field saves when the user leaves it, so a half-typed text is never judged.
  const [titleDraft, setTitleDraft] = createSignal<string>()
  const [callDraft, setCallDraft] = createSignal<string>()
  const [markerDraft, setMarkerDraft] = createSignal<string>()

  const textField = (options: {
    label: MessageKey
    hint: MessageKey
    field: TeamsFieldName
    value: () => string
    draft: () => string | undefined
    setDraft: (value: string | undefined) => void
    save: (value: string) => Promise<unknown>
    disabled?: () => boolean
    testId: string
    placeholder?: MessageKey
    extra?: () => unknown
  }) => (
    <div class={teamStyles.field} data-testid={`${options.testId}-field`}>
      <label class={styles.label} for={options.testId}>
        {t(options.label)}
      </label>
      <div class={teamStyles.note}>{t(options.hint)}</div>
      <div class={teamStyles.fieldRow}>
        <input
          id={options.testId}
          class={teamStyles.input}
          type="text"
          autocomplete="off"
          spellcheck={false}
          value={options.draft() ?? options.value()}
          placeholder={options.placeholder ? t(options.placeholder) : undefined}
          disabled={options.disabled?.() ?? false}
          onInput={(e) => options.setDraft(e.currentTarget.value)}
          onBlur={() => {
            const next = options.draft()
            options.setDraft(undefined)
            if (next !== undefined && next !== options.value()) void options.save(next)
          }}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          data-testid={options.testId}
          data-user-data
        />
        {options.extra?.() as never}
      </div>
      {reasons(options.field)}
    </div>
  )

  /** The names that the open chat shows, for the button "Find in the chat". */
  const findSenders = () => call("teams.readSenders")

  const listField = (options: {
    label: MessageKey
    hint: MessageKey
    field: TeamsFieldName
    value: () => readonly string[]
    save: (names: string[]) => Promise<boolean>
    testId: string
  }) => (
    <div class={teamStyles.field} data-testid={`${options.testId}-field`}>
      <label class={styles.label} for={options.testId}>
        {t(options.label)}
      </label>
      <div class={teamStyles.note}>{t(options.hint)}</div>
      <NameList
        id={options.testId}
        names={options.value()}
        onChange={options.save}
        find={findSenders}
      />
      {reasons(options.field)}
    </div>
  )

  /** Shows the task of a record on the Tasks page; the settings close. */
  const openTask = (taskId: string) => {
    setOpenTarget({ kind: "task", id: taskId })
    ui.closeSettings()
    ui.selectPage("tasks")
  }

  const targetList = () =>
    kind() === "agent"
      ? agents().map((a) => ({ id: a.id, name: a.name }))
      : channels().map((c) => ({ id: c.id, name: c.name }))
  const pickedAgent = () =>
    kind() === "agent" ? agents().find((a) => a.id === fields().targetId) : undefined

  const Facts = (props: { keys: readonly MessageKey[]; testId: string }) => (
    <ol class={teamStyles.facts} data-testid={props.testId}>
      <For each={props.keys}>{(key) => <li>{t(key)}</li>}</For>
    </ol>
  )

  return (
    <div data-testid="teams">
      <Show
        when={view().exists}
        fallback={
          <>
            <h2 class={teamStyles.title}>{t("teams.title")}</h2>
            <Facts keys={TEAMS_FACT_KEYS} testId="teams-facts" />
            <div class={teamStyles.field}>
              <div class={teamStyles.actions}>
                <Button
                  variant="primary"
                  onClick={() => void run(() => call("teams.setup"))}
                  data-testid="teams-setup"
                >
                  {t("teams.setup")}
                </Button>
              </div>
            </div>
          </>
        }
      >
        <details class={teamStyles.factsFold} data-testid="teams-facts-fold">
          <summary>{t("teams.facts.title")}</summary>
          <Facts keys={TEAMS_FACT_KEYS} testId="teams-facts" />
        </details>

        <div class={teamStyles.field} data-testid="teams-switch-row">
          <div class={teamStyles.fieldBar}>
            <div>
              <div class={styles.label}>{t("teams.switch")}</div>
              <div class={styles.hint}>{t("teams.switch.hint")}</div>
            </div>
            <Switch
              label={t("teams.switch")}
              checked={view().enabled}
              onChange={toggle}
              testId="teams-switch"
            />
          </div>
          <p
            class={teamStyles.state}
            role="status"
            data-state={view().state}
            data-testid="teams-state"
          >
            {stateText()}
          </p>
          <Show when={view().state === "paused"}>
            <Show when={view().pauseReason}>
              {(reason) => (
                <div class={teamStyles.note} data-testid="teams-state-reason">
                  {t(teamsPauseReasonKey(reason()))}
                </div>
              )}
            </Show>
            <div class={teamStyles.actions}>
              <Button
                variant="primary"
                onClick={() => void run(() => call("teams.resume"))}
                data-testid="teams-resume"
              >
                {t("teams.resume")}
              </Button>
            </div>
          </Show>
          <Show when={view().state !== "on" && view().lastReadAt !== null}>
            <div class={teamStyles.note} data-testid="teams-last-read">
              {t("teams.state.lastRead", {
                time: formatTime(app.locale(), view().lastReadAt as number),
              })}
            </div>
          </Show>
          <Show when={view().state === "signedOut"}>
            <div class={teamStyles.actions}>
              <Button
                variant="primary"
                onClick={() => void run(() => call("teams.showPage"))}
                data-testid="teams-state-signin"
              >
                {t("teams.state.signIn")}
              </Button>
            </div>
          </Show>
        </div>

        <div class={teamStyles.field} data-testid="teams-signin">
          <div class={teamStyles.fieldBar}>
            <div>
              <div class={styles.label}>{t("teams.signIn.title")}</div>
              <div class={styles.hint} data-testid="teams-signin-state">
                {view().signedIn ? t("teams.signIn.yes") : t("teams.signIn.no")}
              </div>
            </div>
            <div class={teamStyles.actions}>
              <Button
                variant={view().signedIn ? "default" : "primary"}
                onClick={() => void run(() => call("teams.showPage"))}
                data-testid="teams-signin-button"
              >
                {t("teams.signIn.button")}
              </Button>
              <Show when={view().signInProfileId !== null}>
                <Button
                  onClick={() => {
                    setError(undefined)
                    setDialog("signOut")
                  }}
                  data-testid="teams-signout"
                >
                  {t("teams.signOut.button")}
                </Button>
              </Show>
            </div>
          </div>
          <div class={teamStyles.note}>{t("teams.signIn.hint")}</div>
          {reasons("signIn")}
        </div>

        <div class={teamStyles.field} data-testid="teams-page">
          <div class={teamStyles.fieldBar}>
            <div>
              <div class={styles.label}>{t("teams.page.label")}</div>
              <div class={styles.hint}>{t("teams.page.hint")}</div>
            </div>
            <Button
              onClick={() =>
                void run(() => call(view().pageShown ? "teams.hidePage" : "teams.showPage"))
              }
              data-testid="teams-page-toggle"
            >
              {view().pageShown ? t("teams.page.hide") : t("teams.page.show")}
            </Button>
          </div>
          <Show when={view().pageShown}>
            <PageBox />
          </Show>
        </div>

        <div class={teamStyles.field} data-testid="teams-target">
          <div class={teamStyles.fieldBar}>
            <span class={styles.label}>{t("teams.target")}</span>
            <Segmented
              label={t("teams.target")}
              testId="teams-target-kind"
              value={kind()}
              onChange={(next) => {
                setPickedKind(next)
                // A saved target of the other kind goes: its id would not fit.
                if (fields().targetKind !== null && fields().targetKind !== next)
                  void commit({ targetKind: next })
              }}
              options={[
                { value: "agent", label: t("teams.target.agent"), disabled: locked() },
                { value: "channel", label: t("teams.target.channel"), disabled: locked() },
              ]}
            />
          </div>
          <select
            class={teamStyles.select}
            aria-label={t("teams.target")}
            disabled={locked()}
            onChange={(e) => {
              const id = e.currentTarget.value
              void commit({ targetKind: kind(), targetId: id === "" ? null : id })
            }}
            data-testid="teams-target-pick"
          >
            <option
              value=""
              selected={fields().targetId === null || fields().targetKind !== kind()}
            >
              {kind() === "agent" ? t("teams.target.pickAgent") : t("teams.target.pickChannel")}
            </option>
            <For each={targetList()}>
              {(target) => (
                <option
                  value={target.id}
                  selected={fields().targetKind === kind() && fields().targetId === target.id}
                  data-user-data
                >
                  {target.name}
                </option>
              )}
            </For>
          </select>
          <Show when={pickedAgent()?.permission === "full"}>
            <div class={teamStyles.note} data-testid="teams-target-full">
              {t("teams.target.full")}
            </div>
          </Show>
          {reasons("target")}
        </div>

        {textField({
          label: "teams.chat.title",
          hint: "teams.chat.hint",
          field: "chatTitle",
          value: () => fields().chatTitle,
          draft: titleDraft,
          setDraft: setTitleDraft,
          save: (value) => commit({ chatTitle: value }),
          disabled: locked,
          testId: "teams-chat-title",
          placeholder: "teams.chat.placeholder",
          extra: () => (
            <Button
              disabled={locked()}
              onClick={() => void run(() => call("teams.useChat"))}
              data-testid="teams-use-chat"
            >
              {t("teams.chat.use")}
            </Button>
          ),
        })}

        <div class={teamStyles.field} data-testid="teams-kind">
          <div class={teamStyles.fieldBar}>
            <span class={styles.label}>{t("teams.kind")}</span>
            <Segmented
              label={t("teams.kind")}
              testId="teams-kind-pick"
              value={fields().chatKind}
              onChange={(chatKind) => void commit({ chatKind })}
              options={[
                { value: "person", label: t("teams.kind.person"), disabled: locked() },
                { value: "group", label: t("teams.kind.group"), disabled: locked() },
              ]}
            />
          </div>
        </div>

        {listField({
          label: "teams.allow",
          hint: "teams.allow.hint",
          field: "allow",
          value: () => fields().allow,
          save: (allow) => commit({ allow }),
          testId: "teams-allow",
        })}
        {listField({
          label: "teams.bots",
          hint: "teams.bots.hint",
          field: "bots",
          value: () => fields().bots,
          save: (bots) => commit({ bots }),
          testId: "teams-bots",
        })}
        <Show when={view().botListWins}>
          <div class={teamStyles.note} data-testid="teams-bot-wins">
            {t("teams.bots.wins")}
          </div>
        </Show>

        {textField({
          label: "teams.call",
          hint: "teams.call.hint",
          field: "callText",
          value: () => fields().callText,
          draft: callDraft,
          setDraft: setCallDraft,
          save: (value) => commit({ callText: value }),
          testId: "teams-call",
        })}
        {textField({
          label: "teams.marker",
          hint: "teams.marker.hint",
          field: "marker",
          value: () => fields().marker,
          draft: markerDraft,
          setDraft: setMarkerDraft,
          save: (value) => commit({ marker: value }),
          disabled: locked,
          testId: "teams-marker",
        })}
        <Show when={locked()}>
          <div class={teamStyles.note} data-testid="teams-locked">
            {t("teams.locked")}
          </div>
        </Show>

        <div class={teamStyles.field} data-testid="teams-records">
          <div class={styles.label}>{t("teams.records.title")}</div>
          <div class={teamStyles.note}>{t("teams.records.hint")}</div>
          <Show
            when={view().records.length > 0}
            fallback={
              <div class={teamStyles.note} data-testid="teams-records-empty">
                {t("teams.records.empty")}
              </div>
            }
          >
            <ul class={teamStyles.records} data-testid="teams-records-list">
              <For each={view().records}>
                {(record) => (
                  <li
                    class={teamStyles.record}
                    data-testid="teams-record"
                    data-reason={record.reason}
                  >
                    <span class={teamStyles.recordTime}>
                      {formatDateTime(app.locale(), record.at)}
                    </span>
                    <span class={teamStyles.recordReason}>
                      {t(teamsRecordReasonKey(record.reason))}
                    </span>
                    <Show when={record.placeName}>
                      {(name) => (
                        <span class={teamStyles.note} data-user-data>
                          {name()}
                        </span>
                      )}
                    </Show>
                    <Show when={record.taskId}>
                      {(taskId) => (
                        <button
                          type="button"
                          class={teamStyles.recordLink}
                          onClick={() => openTask(taskId())}
                          data-testid="teams-record-task"
                        >
                          {t("teams.record.openTask")}
                        </button>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>

        <div class={teamStyles.field}>
          <div class={teamStyles.actions}>
            <Button
              onClick={() => {
                setError(undefined)
                setDialog("remove")
              }}
              data-testid="teams-remove"
            >
              {t("teams.remove.button")}
            </Button>
          </div>
        </div>
      </Show>

      <Show when={error()}>
        {(err) => (
          <div class={teamStyles.problem} role="alert" data-testid="teams-error">
            {t(err().key, err().params)}
          </div>
        )}
      </Show>

      <Presence when={dialog()}>
        {(which) => (
          <SwitchCase>
            <Match when={which === "on"}>
              <Dialog
                label={t("teams.dialog.title")}
                onClose={() => setDialog(undefined)}
                testId="teams-on-dialog"
              >
                <h2 class={styles.label}>{t("teams.dialog.title")}</h2>
                <Facts keys={TEAMS_DIALOG_FACT_KEYS} testId="teams-on-facts" />
                <Show when={error()}>
                  {(err) => <div class={teamStyles.problem}>{t(err().key, err().params)}</div>}
                </Show>
                <div class={styles.actions}>
                  <Button onClick={() => setDialog(undefined)} data-testid="teams-on-back">
                    {t("teams.dialog.back")}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void turnOn()}
                    data-testid="teams-on-confirm"
                  >
                    {t("teams.dialog.on")}
                  </Button>
                </div>
              </Dialog>
            </Match>
            <Match when={which === "signOut"}>
              <Dialog
                label={t("teams.signOut.title")}
                onClose={() => setDialog(undefined)}
                testId="teams-signout-dialog"
              >
                <h2 class={styles.label}>{t("teams.signOut.title")}</h2>
                <p>{t("teams.signOut.body")}</p>
                <div class={styles.actions}>
                  <Button onClick={() => setDialog(undefined)}>{t("teams.cancel")}</Button>
                  <Button
                    variant="primary"
                    onClick={async () => {
                      if (await run(() => call("teams.signOut"))) setDialog(undefined)
                    }}
                    data-testid="teams-signout-confirm"
                  >
                    {t("teams.signOut.button")}
                  </Button>
                </div>
              </Dialog>
            </Match>
            <Match when={which === "remove"}>
              <Dialog
                label={t("teams.remove.title")}
                onClose={() => setDialog(undefined)}
                testId="teams-remove-dialog"
              >
                <h2 class={styles.label}>{t("teams.remove.title")}</h2>
                <p>{t("teams.remove.body")}</p>
                <div class={styles.actions}>
                  <Button onClick={() => setDialog(undefined)}>{t("teams.cancel")}</Button>
                  <Button
                    variant="primary"
                    onClick={async () => {
                      if (await run(() => call("teams.remove"))) setDialog(undefined)
                    }}
                    data-testid="teams-remove-confirm"
                  >
                    {t("teams.remove.button")}
                  </Button>
                </div>
              </Dialog>
            </Match>
          </SwitchCase>
        )}
      </Presence>
    </div>
  )
}
