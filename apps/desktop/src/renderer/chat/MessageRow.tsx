import {
  type Agent,
  type ChatMessage,
  catalogues,
  connectionToolLabel,
  type FilePart,
  foldedToolsKey,
  groupParts,
  handoverOf,
  isNoteOnly,
  type KnowledgeNote,
  type MemoryNote,
  type MemoryUndo,
  type MessageKey,
  type MessagePart,
  messageFiles,
  messageSkill,
  messageText,
  type OutsideSource,
  type PartSegment,
  passesOf,
  passLabelKey,
  type QuestionLead,
  type QuestionPass,
  ROUTINES_MAX,
  type SecretAsk,
  type SecretAuth,
  type SensitiveLabel,
  type SettingChange,
  type SettingsNote,
  type SettingValue,
  SKILLS_MAX,
  type SkillPart,
  type ToolAsk,
  type ToolPart,
  thoughtIsLive,
} from "@robot/shared"
import {
  BookOpen,
  Copy,
  Download,
  ExternalLink,
  GitBranch,
  LoaderCircle,
  Pencil,
  Reply,
  Sparkles,
  User,
  Wrench,
} from "lucide-solid"
import { createResource, createSignal, For, Index, Match, onCleanup, Show, Switch } from "solid-js"
import { Face } from "../agents/Face.tsx"
import { ProfileButton } from "../agents/ProfileButton.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { outsideSourceText } from "../lib/outside.ts"
import { call } from "../lib/rpc.ts"
import { sensitiveLabelText } from "../lib/sensitive.ts"
import { AgentInLine, AgentName } from "../orgs/AgentName.tsx"
import { useAgents } from "../state/agents.tsx"
import { useApp } from "../state/app.tsx"
import { useDevices } from "../state/devices.tsx"
import { openMemory } from "../state/memoryLink.ts"
import { useOrgs } from "../state/orgs.tsx"
import { useUi } from "../state/ui.tsx"
import { AvatarMark } from "../ui/AvatarMark.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import styles from "./chat.module.css"
import { fileSize, formatTime, formatUntil } from "./format.ts"
import { HandedOverText, HandoverCard } from "./Handover.tsx"
import { Markdown } from "./Markdown.tsx"
import { SentPictures } from "./SentPictures.tsx"

export interface MessageRowProps {
  agent: Agent
  message: ChatMessage
  /** True when the row starts a header group. */
  first: boolean
  canEdit: boolean
  flash: boolean
  /** Plays the arrival motion. */
  enter: boolean
  /** True for the echo of a message that this box sent: it slides up from the box. */
  sent?: boolean
  quoted: ChatMessage | undefined
  onReply: () => void
  onJumpTo: (messageId: string) => void
  onEdit: (text: string) => Promise<void>
  onRetry: () => void
  /** Fork at this message (spec 003, "Fork"). None where Fork does not show. */
  onFork?: (() => void) | undefined
  /** Why Fork is off now, in words. */
  forkOff?: string | undefined
  /**
   * "Correct" on a question that the lead answered (spec 004, "Questions of members"): starts a
   * reply in the message box with a mention of the member. None where the box is not a channel's.
   */
  onCorrect?: (() => void) | undefined
}

/** The words of an error code, or "Something went wrong" for a code with no words. */
const errorWords = (t: ReturnType<typeof useApp>["t"], code: string) => {
  const key = `error.${code}`
  return key in catalogues.en ? t(key as MessageKey) : t("error.unknown")
}

/** The muted line of an automatic compact that failed: the turn went on without it (spec 003). */
const CompactFailedLine = (props: { code: string }) => {
  const { t } = useApp()
  return (
    <p class={styles.compactFailed} data-testid="compact-failed">
      {t("chat.compact.failed", { reason: errorWords(t, props.code) })}
    </p>
  )
}

/** The muted line of a connection that was down when the turn started (spec 018, "States"). */
const ConnectionDownLine = (props: { name: string }) => {
  const { t } = useApp()
  return (
    <p class={styles.compactFailed} data-testid="connection-down">
      {t("chat.note.connectionDown", { name: props.name })}
    </p>
  )
}

/** The muted line of a connection with tools that wait for review when the turn started (spec 018). */
const ConnectionHeldLine = (props: { name: string }) => {
  const { t } = useApp()
  return (
    <p class={styles.compactFailed} data-testid="connection-held">
      {t("chat.note.connectionHeld", { name: props.name })}
    </p>
  )
}

type SetupFailed = Extract<MessagePart, { kind: "note"; note: "setup_failed" }>

/** The translation key of a setup that did not succeed (spec 035). */
const setupFailedKey = (code: SetupFailed["code"]): MessageKey => {
  switch (code) {
    case "exit":
      return "chat.note.setupFailed"
    case "timeout":
      return "chat.note.setupFailed.timeout"
    case "spawn":
      return "chat.note.setupFailed.spawn"
    default: {
      const never: never = code
      return never
    }
  }
}

const setupFailedPart = (part: MessagePart): SetupFailed | undefined =>
  part.kind === "note" && part.note === "setup_failed" ? part : undefined

/** The muted line of a setup action that did not succeed (spec 035). The turn went on. */
const SetupFailedLine = (props: { part: SetupFailed }) => {
  const { t } = useApp()
  return (
    <p class={styles.compactFailed} data-testid="setup-failed">
      {t(setupFailedKey(props.part.code), { name: props.part.name })}
    </p>
  )
}

/**
 * The words of the muted line "<main model> reached its limit. <backup model> goes on." (spec 006,
 * "Backup model"). It gives the reset time when the provider named one.
 */
const backupWords = (
  app: ReturnType<typeof useApp>,
  part: Extract<MessagePart, { kind: "note"; note: "backup_goes_on" }>,
) =>
  part.until === null
    ? app.t("chat.note.backupGoesOn", { main: part.main, backup: part.backup })
    : app.t("chat.note.backupGoesOnUntil", {
        main: part.main,
        backup: part.backup,
        time: formatUntil(app.locale(), part.until),
      })

/** The muted line that tells that the backup model goes on (spec 006, "Backup model"). */
const BackupGoesOnLine = (props: {
  part: Extract<MessagePart, { kind: "note"; note: "backup_goes_on" }>
}) => {
  const app = useApp()
  return (
    <p class={styles.compactFailed} data-testid="backup-line">
      {backupWords(app, props.part)}
    </p>
  )
}

type BusyRetry = Extract<MessagePart, { kind: "note"; note: "busy_retry" }>

const busyRetryPart = (part: MessagePart): BusyRetry | undefined =>
  part.kind === "note" && part.note === "busy_retry" ? part : undefined

/** The muted line "The model is busy. Trying again (1 of 3)." (spec 006). */
const BusyRetryLine = (props: { part: BusyRetry }) => {
  const { t } = useApp()
  return (
    <p class={styles.compactFailed} data-testid="busy-line">
      {t("chat.note.busyRetry", { n: props.part.n, of: props.part.of })}
    </p>
  )
}

/** The muted line "Kept going (1 of 8)" (spec 005, "Keep going"; 003). */
const KeptGoingLine = (props: {
  part: Extract<MessagePart, { kind: "note"; note: "kept_going" }>
}) => {
  const { t } = useApp()
  return (
    <p class={styles.compactFailed} data-testid="kept-going-line">
      {t("chat.note.keptGoing", { n: props.part.n, of: props.part.of })}
    </p>
  )
}

/** The line "Compacted". The user opens it to read the summary (spec 003, "Compact"). */
const CompactedLine = (props: { part: Extract<MessagePart, { kind: "compacted" }> }) => {
  const { t } = useApp()
  return (
    <details class={styles.compacted} data-testid="compacted-line">
      <summary>{props.part.auto ? t("chat.compacted.auto") : t("chat.compacted")}</summary>
      <p class={styles.compactedSummary} data-testid="compacted-summary">
        {props.part.summary}
      </p>
    </details>
  )
}

const Thinking = (props: { text: string; live: boolean }) => {
  const { t } = useApp()
  return (
    <details class={styles.thinking} data-testid="thinking">
      <summary>{props.live ? t("chat.thinking") : t("chat.thought")}</summary>
      <p>{props.text}</p>
    </details>
  )
}

/** How a secret is sent, in words. */
const authText = (t: ReturnType<typeof useApp>["t"], auth: SecretAuth) =>
  auth.kind === "bearer"
    ? t("secret.auth.bearer")
    : auth.kind === "header"
      ? t("secret.auth.header", { header: auth.header })
      : t("secret.auth.basic", { user: auth.user })

/**
 * The protected card of spec 020: the reason, the origin in large text, the way to send, a hidden
 * field, Save and Cancel. The field is cleared when the save starts. On a linked device, or when
 * the agent runs on the other computer, the card says where to answer and has no field.
 */
const SecretCard = (props: {
  agent: Agent
  callId: string
  ask: SecretAsk
  /** The name of the computer that runs the agent, when it is not this one. */
  elsewhere: string | undefined
}) => {
  const { t } = useApp()
  const [failure, setFailure] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  let field: HTMLInputElement | undefined
  const answer = async (value: string | null) => {
    setFailure(undefined)
    setBusy(true)
    try {
      await call("secrets.answer", { agentId: props.agent.id, callId: props.callId, value })
    } catch (e) {
      setFailure(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  const save = () => {
    const value = field?.value ?? ""
    // The value leaves the field before the save starts (spec 020).
    if (field) field.value = ""
    if (!value) return
    void answer(value)
  }
  return (
    <div class={styles.secretCard} data-testid="secret-card">
      <strong>
        {props.ask.label
          ? t("secret.card.title", { label: props.ask.label })
          : t("secret.card.titlePlain")}
      </strong>
      <Show when={props.ask.reason}>
        <div data-testid="secret-reason">
          {t("secret.card.reason", { reason: props.ask.reason })}
        </div>
      </Show>
      <div class={styles.time}>{t("secret.card.origin")}</div>
      <div class={styles.secretOrigin} data-testid="secret-origin">
        {props.ask.origin}
      </div>
      <div class={styles.time} data-testid="secret-name">
        {t("secret.card.name", { name: props.ask.name })} · {authText(t, props.ask.auth)}
      </div>
      <Show when={props.ask.replace}>
        <div data-testid="secret-replace">{t("secret.card.replace", { name: props.ask.name })}</div>
      </Show>
      <Show
        when={props.elsewhere === undefined}
        fallback={
          <div class={styles.fromDevice} role="status" data-testid="secret-elsewhere">
            {t("secret.card.elsewhere", { name: props.elsewhere ?? "" })}
          </div>
        }
      >
        <Show when={failure()}>
          {(err) => (
            <div class={styles.fromDevice} role="alert" data-testid="secret-error">
              {t(err().key, err().params)}
            </div>
          )}
        </Show>
        <form
          class={styles.askActions}
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <input
            ref={field}
            class={styles.askInput}
            type="password"
            autocomplete="off"
            spellcheck={false}
            maxLength={16384}
            placeholder={t("secret.card.field")}
            aria-label={t("secret.card.field")}
            data-testid="secret-input"
          />
          <Button type="submit" variant="primary" disabled={busy()} data-testid="secret-save">
            {t("secret.card.save")}
          </Button>
          <Button
            disabled={busy()}
            onClick={() => {
              if (field) field.value = ""
              void answer(null)
            }}
            data-testid="secret-cancel"
          >
            {t("secret.card.cancel")}
          </Button>
        </form>
        <div class={styles.time}>{t("secret.card.hint")}</div>
      </Show>
    </div>
  )
}

const ToolCard = (props: {
  agent: Agent
  part: Extract<MessagePart, { kind: "tool" }>
  /** The name of the other computer when the task runs there (spec 019). */
  from: string | undefined
  onCorrect?: (() => void) | undefined
}) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const devices = useDevices()
  const [answer, setAnswer] = createSignal("")
  const [failure, setFailure] = createSignal<ErrorText>()
  const respond = async (value: string) => {
    setFailure(undefined)
    try {
      await call("tools.respond", { agentId: props.agent.id, callId: props.part.id, answer: value })
    } catch (e) {
      setFailure(describeError(e))
    }
  }
  /** The card of a task on the other computer cannot be answered while that computer is away. */
  const away = () => props.from !== undefined && !devices.sync.pairOnline()
  /** A computer cannot change what an agent may always do on another computer (spec 019). */
  const mayAlways = () => !ui.linked() && props.from === undefined
  return (
    <>
      <details class={styles.tool} data-testid="tool-card" open={props.part.state === "waiting"}>
        <summary>
          <Wrench size={14} />
          <span class={styles.toolLabel}>
            {props.part.name === "search_chats"
              ? t("chat.tool.searchChats")
              : props.part.connection?.kind === "search"
                ? t("chat.tool.searchTools", {
                    words: props.part.connection.words,
                    found: props.part.connection.found,
                  })
                : props.part.connection?.kind === "call"
                  ? connectionToolLabel(
                      props.part.connection.connection,
                      props.part.connection.tool,
                    )
                  : props.part.label || props.part.name}
          </span>
          {/* A step that the permission level refused says so (spec 007). */}
          <span
            class={styles.toolState}
            data-state={props.part.refused ? "refused" : props.part.state}
            data-testid="tool-state"
          >
            {props.part.refused
              ? t(
                  props.part.refused === "address"
                    ? "chat.tool.refusedAddress"
                    : props.part.refused === "rule"
                      ? "chat.tool.refusedRule"
                      : "chat.tool.refusedReadOnly",
                )
              : t(`chat.tool.${props.part.state}` as MessageKey)}
          </span>
          {/* A step that an Allow rule let run says so (spec 007, "Permission rules"). */}
          <Show when={props.part.ruleAllowed}>
            <span class={styles.fromDevice} data-testid="tool-rule-allowed">
              {t("chat.tool.ruleAllowed")}
            </span>
          </Show>
          {/* A step that the check of "Ask when unsure" let run says so (spec 007). */}
          <Show when={props.part.checkAllowed !== undefined}>
            <span class={styles.fromDevice} data-testid="tool-check-allowed">
              {t("chat.tool.checkAllowed")}
            </span>
          </Show>
          {/* A call of a connection tool that its read-only mark let run says so (spec 018). */}
          <Show when={props.part.readOnlyTrusted}>
            <span class={styles.fromDevice} data-testid="tool-read-only-trusted">
              {t("chat.tool.readOnlyTrusted")}
            </span>
          </Show>
          <Show when={props.part.reason}>
            {(reason) => (
              <span class={styles.toolReason} data-testid="tool-reason" data-code={reason().code}>
                {t(`error.${reason().code}` as MessageKey, {
                  detail: reason().detail ?? "",
                  next: reason().next ?? "",
                })}
              </span>
            )}
          </Show>
          <Show when={props.from}>
            {(from) => (
              <span class={styles.fromDevice} data-testid="tool-origin">
                {t("link.fromDevice", { name: from() })}
              </span>
            )}
          </Show>
          <Show when={props.part.answeredInChat}>
            <span class={styles.fromDevice} data-testid="tool-answered-in-chat">
              {t("chat.tool.answeredInChat")}
            </span>
          </Show>
          <Show when={props.part.secret}>
            {(result) => (
              <span class={styles.fromDevice} data-testid="secret-result" data-result={result()}>
                {result() === "saved" ? t("secret.card.saved") : t("secret.card.cancelled")}
              </span>
            )}
          </Show>
          <Show when={props.part.decision}>
            {(decision) => (
              <span
                class={styles.fromDevice}
                data-testid="tool-decision"
                data-answer={decision().answer}
              >
                {decision().answer === "allow"
                  ? t("chat.decision.allowed", { name: decision().by })
                  : t("chat.decision.denied", { name: decision().by })}
              </span>
            )}
          </Show>
        </summary>
        <div class={styles.toolBody}>
          <Show when={props.part.ask}>
            {(ask) => (
              <div class={styles.ask} data-testid="ask-card">
                <Show when={ask().askedAt}>
                  {(at) => (
                    <div class={styles.time} data-testid="ask-time">
                      {t("chat.tool.askedAt", { time: formatTime(app.locale(), at()) })}
                    </div>
                  )}
                </Show>
                <Show when={away()}>
                  <div class={styles.fromDevice} role="status" data-testid="ask-origin-offline">
                    {t("sync.originOffline", { name: props.from ?? "" })}
                  </div>
                </Show>
                <Show when={failure()}>
                  {(err) => (
                    <div class={styles.fromDevice} role="alert" data-testid="ask-error">
                      {t(err().key, err().params)}
                    </div>
                  )}
                </Show>
                <Switch>
                  <Match when={ask().kind === "secret" ? (ask() as SecretAsk) : undefined}>
                    {(secret) => (
                      <SecretCard
                        agent={props.agent}
                        callId={props.part.id}
                        ask={secret()}
                        elsewhere={
                          props.from ?? (ui.linked() ? (ui.server()?.name ?? "") : undefined)
                        }
                      />
                    )}
                  </Match>
                  <Match when={ask().kind === "article" ? ask() : undefined}>
                    {(article) => {
                      const a = () => article() as Extract<ToolAsk, { kind: "article" }>
                      return (
                        <div data-testid="ask-article">
                          <div>{t("chat.knowledge.protect", { title: a().title })}</div>
                          <div class={styles.compare}>
                            <section>
                              <div class={styles.time}>{t("chat.knowledge.protect.now")}</div>
                              <pre data-testid="ask-before">{a().before}</pre>
                            </section>
                            <section>
                              <div class={styles.time}>{t("chat.knowledge.protect.new")}</div>
                              <pre data-testid="ask-after">
                                {a().after ?? t("chat.knowledge.protect.deleted")}
                              </pre>
                            </section>
                          </div>
                          <div class={styles.askActions}>
                            <Button
                              variant="primary"
                              disabled={away()}
                              onClick={() => respond("allow")}
                              data-testid="ask-allow"
                            >
                              {t("chat.tool.allow")}
                            </Button>
                            <Button
                              disabled={away()}
                              onClick={() => respond("deny")}
                              data-testid="ask-deny"
                            >
                              {t("chat.tool.deny")}
                            </Button>
                          </div>
                        </div>
                      )
                    }}
                  </Match>
                  <Match when={ask().kind === "question" ? ask() : undefined}>
                    {(question) => (
                      <>
                        <div>{(question() as { question: string }).question}</div>
                        {/* The lead of the channel looks at the question (spec 004). The user can answer. */}
                        <Show when={(question() as { lead?: QuestionLead }).lead}>
                          {(lead) => (
                            <div class={styles.leadLooks} role="status" data-testid="lead-looks">
                              <LoaderCircle
                                size={14}
                                class={styles.leadSpin ?? ""}
                                aria-hidden="true"
                              />
                              <span>{t("lead.looks", { name: lead().name })}</span>
                            </div>
                          )}
                        </Show>
                        {/* One line for each pass: the lead, then the agents of the line (spec 004, 030). */}
                        <For
                          each={passesOf(
                            question() as {
                              passes?: readonly QuestionPass[]
                              passed?: QuestionPass
                            },
                          )}
                        >
                          {(pass) => (
                            <div
                              class={styles.leadPass}
                              data-testid="lead-pass"
                              data-kind={pass.kind}
                            >
                              {t(passLabelKey(pass), { name: pass.name, reason: pass.reason })}
                            </div>
                          )}
                        </For>
                        <Show when={(question() as { lineLate?: boolean }).lineLate}>
                          <div class={styles.leadPass} data-testid="lead-line-late">
                            {t("lead.lineLate")}
                          </div>
                        </Show>
                        <div class={styles.askActions}>
                          <For each={(question() as { choices: readonly string[] }).choices}>
                            {(choice) => (
                              <Button
                                disabled={away()}
                                onClick={() => respond(choice)}
                                data-testid="ask-choice"
                              >
                                {choice}
                              </Button>
                            )}
                          </For>
                        </div>
                        <form
                          class={styles.askActions}
                          onSubmit={(e) => {
                            e.preventDefault()
                            if (answer().trim()) respond(answer().trim())
                          }}
                        >
                          <input
                            class={styles.askInput}
                            value={answer()}
                            placeholder={t("chat.tool.answer")}
                            aria-label={t("chat.tool.answer")}
                            onInput={(e) => setAnswer(e.currentTarget.value)}
                            data-testid="ask-input"
                          />
                          <Button
                            type="submit"
                            variant="primary"
                            disabled={away()}
                            data-testid="ask-send"
                          >
                            {t("chat.tool.send")}
                          </Button>
                        </form>
                      </>
                    )}
                  </Match>
                  <Match when={ask().kind === "approval"}>
                    <div>{t("chat.tool.approval")}</div>
                    {/* A rule that the app cannot read meets the step (spec 007). */}
                    <Show when={(ask() as { unreadable?: true }).unreadable}>
                      <div class={styles.outside} role="note" data-testid="ask-unreadable">
                        <strong>{t("chat.tool.unreadable")}</strong>
                      </div>
                    </Show>
                    {/* The check of "Ask when unsure" was asked and did not allow the step (spec 007). */}
                    <Show when={(ask() as { unsure?: true }).unsure}>
                      <div class={styles.outside} role="note" data-testid="ask-unsure">
                        <strong>{t("chat.tool.unsure")}</strong>
                      </div>
                    </Show>
                    {/* A guarded step in a turn that holds outside content (spec 007). */}
                    <Show when={(ask() as { outside?: OutsideSource }).outside}>
                      {(source) => (
                        <div class={styles.outside} role="note" data-testid="ask-outside">
                          <strong>{t("outside.held")}</strong>
                          <span data-testid="ask-outside-source">
                            {t("outside.first", { source: outsideSourceText(t, source()) })}
                          </span>
                          <span class={styles.outsideHint}>{t("outside.hint")}</span>
                        </div>
                      )}
                    </Show>
                    {/* A step that sends data out in a turn that read a credential place (spec 007). */}
                    <Show when={(ask() as { sensitive?: SensitiveLabel }).sensitive}>
                      {(label) => (
                        <div class={styles.outside} role="note" data-testid="ask-sensitive">
                          <strong>{t("sensitive.askLine")}</strong>
                          <span data-testid="ask-sensitive-label">
                            {t("sensitive.first", { label: sensitiveLabelText(t, label()) })}
                          </span>
                        </div>
                      )}
                    </Show>
                    <pre>{(ask() as { summary: string }).summary}</pre>
                    <div class={styles.askActions}>
                      <Button
                        variant="primary"
                        disabled={away()}
                        onClick={() => respond("allow")}
                        data-testid="ask-allow"
                      >
                        {t("chat.tool.allow")}
                      </Button>
                      {/* A client cannot change what an agent may always do (spec 012). */}
                      <Show when={mayAlways() && !(ask() as { once?: boolean }).once}>
                        <Button onClick={() => respond("always")} data-testid="ask-always">
                          {t("chat.tool.always")}
                        </Button>
                      </Show>
                      <Button
                        disabled={away()}
                        onClick={() => respond("deny")}
                        data-testid="ask-deny"
                      >
                        {t("chat.tool.deny")}
                      </Button>
                    </div>
                  </Match>
                </Switch>
              </div>
            )}
          </Show>
          <Show when={props.part.input}>
            <div class={styles.time}>{t("chat.tool.input")}</div>
            <pre>{props.part.input}</pre>
          </Show>
          <Show when={props.part.output}>
            <div class={styles.time}>{t("chat.tool.output")}</div>
            <pre>{props.part.output}</pre>
          </Show>
        </div>
      </details>
      {/* The lead answered the question in place of the user (spec 004, "Questions of members"). */}
      <Show when={props.part.answeredByLead}>
        {(by) => (
          <div class={styles.leadAnswer} data-testid="lead-answer">
            {/* The passes before the answer of an agent on the line (spec 030). */}
            <Show when={(by().passes ?? []).length > 0}>
              <div class={styles.leadAnswerPasses}>
                <For each={by().passes ?? []}>
                  {(pass) => (
                    <span data-testid="lead-pass" data-kind={pass.kind}>
                      {t(passLabelKey(pass), { name: pass.name, reason: pass.reason })}
                    </span>
                  )}
                </For>
              </div>
            </Show>
            <span class={styles.leadAnswerText} data-testid="lead-answer-text">
              {props.part.output}
            </span>
            <span class={styles.leadAnswerBy} data-testid="lead-answered-by">
              {t("lead.answeredBy", { name: by().name })}
            </span>
            <Show when={by().reason}>
              <span class={styles.leadReason} data-testid="lead-reason">
                {by().reason}
              </span>
            </Show>
            <Show when={props.onCorrect}>
              <Button onClick={() => props.onCorrect?.()} data-testid="lead-correct">
                {t("lead.correct")}
              </Button>
            </Show>
          </div>
        )}
      </Show>
    </>
  )
}

/**
 * The skill chip of a message (spec 017). A click shows the instructions as they were sent, read
 * only. A later edit of the skill does not change them.
 */
const SkillChip = (props: { skill: SkillPart }) => {
  const { t } = useApp()
  const [open, setOpen] = createSignal(false)
  return (
    <div class={styles.skillSent}>
      <button
        type="button"
        class={styles.skillChip}
        aria-expanded={open()}
        title={t("skills.chip.show")}
        onClick={() => setOpen(!open())}
        data-testid="message-skill"
      >
        <Sparkles size={12} />
        <span>{props.skill.name}</span>
      </button>
      <Show when={open()}>
        <pre class={styles.skillSentText} data-testid="message-skill-text">
          {props.skill.instructions}
        </pre>
      </Show>
    </div>
  )
}

const FileChip = (props: { message: ChatMessage; file: FilePart; from: string | undefined }) => {
  const { t } = useApp()
  const ui = useUi()
  const [savedFile, setSavedFile] = createSignal<string>()
  const [busy, setBusy] = createSignal(false)
  const [failure, setFailure] = createSignal<ErrorText>()
  const ask = () => ({
    agentId: props.message.agentId,
    path: props.file.path,
    size: props.file.size,
    messageId: props.message.id,
  })
  // A file of a message from the other computer may not be on this computer (spec 019).
  const [here, { refetch }] = createResource(
    () => props.from !== undefined && !ui.linked(),
    (remote) => (remote ? call("sync.file.here", ask()).catch(() => true) : true),
    { initialValue: true },
  )
  const open = async () => {
    setFailure(undefined)
    setBusy(true)
    try {
      await call("sync.file.open", ask())
      await refetch()
    } catch (e) {
      setFailure(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <li class={styles.chip} title={props.file.path} data-testid="message-file">
      <span class={styles.chipName}>{props.file.name}</span>
      <span class={styles.chipSize}>{fileSize(props.file.size)}</span>
      <Show when={!here()}>
        <span class={styles.chipSize} data-testid="message-file-missing">
          {t("sync.file.notHere")}
        </span>
      </Show>
      <Show when={busy()}>
        <span class={styles.chipSize} data-testid="message-file-copying">
          {t("sync.file.copying")}
        </span>
      </Show>
      <Show when={failure()}>
        {(err) => (
          <span class={styles.chipSize} role="alert" data-testid="message-file-error">
            {t(err().key, err().params)}
          </span>
        )}
      </Show>
      <Show when={!ui.linked()}>
        <IconButton
          label={t("sync.file.open", { name: props.file.name })}
          disabled={busy()}
          onClick={open}
          data-testid="message-file-open"
        >
          <ExternalLink size={12} />
        </IconButton>
      </Show>
      <Show when={ui.linked()}>
        <IconButton
          label={t("link.file.download", { name: props.file.name })}
          disabled={ui.serverOffline()}
          onClick={async () => {
            const result = await call("attachments.save", {
              agentId: props.message.agentId,
              path: props.file.path,
              name: props.file.name,
            }).catch(() => undefined)
            if (result?.saved) setSavedFile(props.file.path)
          }}
          data-testid="message-file-download"
        >
          <Download size={12} />
        </IconButton>
        <Show when={savedFile() === props.file.path}>
          <span class={styles.chipSize} data-testid="message-file-saved">
            {t("link.file.saved")}
          </span>
        </Show>
      </Show>
    </li>
  )
}

const FAILED_KEY: Record<string, MessageKey> = {
  read_article: "chat.knowledge.failed.read",
  write_article: "chat.knowledge.failed.write",
  delete_article: "chat.knowledge.failed.delete",
  add_source: "chat.knowledge.failed.source",
}

/**
 * What a knowledge tool did: a compact card for a read, a muted line with undo for a change.
 * Knowledge stays on the computer that runs the agent (012, 019): a client, and a message that
 * came from the other computer of a sync pair, show the line without undo.
 */
const KnowledgeLine = (props: {
  agent: Agent
  part: ToolPart
  note: KnowledgeNote
  from: string | undefined
}) => {
  const { t } = useApp()
  const ui = useUi()
  const here = () => !ui.linked() && props.from === undefined
  const [tick, setTick] = createSignal(0)
  const [error, setError] = createSignal<ErrorText>()
  onCleanup(
    window.robot.on("knowledge.changed", (e) => {
      if (e.agentId === props.agent.id) setTick((n) => n + 1)
    }),
  )
  const changeId = () => (props.note.kind === "write" ? props.note.changeId : undefined)
  // The change list keeps 50 changes. An older change has no undo.
  const [change] = createResource(
    () => {
      const id = changeId()
      return id && here() ? { id, tick: tick() } : undefined
    },
    ({ id }) =>
      call("knowledge.change", { agentId: props.agent.id, changeId: id }).catch(() => undefined),
  )
  const undo = async () => {
    const id = changeId()
    if (!id) return
    setError(undefined)
    try {
      await call("knowledge.undo", { agentId: props.agent.id, changeId: id })
    } catch (e) {
      setError(describeError(e))
    }
  }
  const reason = (code: string) => {
    const key = `error.${code}` as MessageKey
    return key in catalogues.en ? t(key) : t("error.unknown")
  }
  return (
    <Switch>
      <Match when={props.note.kind === "read" ? props.note : undefined}>
        {(note) => (
          <div class={styles.knowledgeRead} data-testid="knowledge-read-card">
            <BookOpen size={14} />
            <span>{t("chat.knowledge.read", { title: (note() as { title: string }).title })}</span>
          </div>
        )}
      </Match>
      <Match when={props.note.kind === "write" ? props.note : undefined}>
        {(note) => (
          <div class={styles.knowledgeLine} data-testid="knowledge-line">
            <span>
              {t(
                (note() as { change: string }).change === "delete"
                  ? "chat.knowledge.deleted"
                  : "chat.knowledge.updated",
                { title: (note() as { title: string }).title },
              )}
            </span>
            <Show when={change()}>
              {(c) => (
                <Show
                  when={!c().undone}
                  fallback={
                    <span data-testid="knowledge-undone">{t("chat.knowledge.undone")}</span>
                  }
                >
                  <Button onClick={undo} data-testid="knowledge-undo">
                    {t("chat.knowledge.undo")}
                  </Button>
                </Show>
              )}
            </Show>
            <Show when={error()}>
              {(err) => (
                <span class={styles.knowledgeError} role="alert">
                  {t(err().key, err().params)}
                </span>
              )}
            </Show>
          </div>
        )}
      </Match>
      <Match when={props.note.kind === "source" ? props.note : undefined}>
        {(note) => (
          <div class={styles.knowledgeLine} data-testid="knowledge-source-line">
            <span>{t("chat.knowledge.source", { name: (note() as { name: string }).name })}</span>
          </div>
        )}
      </Match>
      <Match when={props.note.kind === "failed" ? props.note : undefined}>
        {(note) => (
          <div class={styles.knowledgeFailed} role="alert" data-testid="knowledge-failed">
            <span>
              {t(FAILED_KEY[props.part.name] ?? "chat.knowledge.failed.write", {
                title: (note() as { title: string }).title,
              })}
            </span>
            <span>{reason((note() as { code: string }).code)}</span>
          </div>
        )}
      </Match>
    </Switch>
  )
}

/** True for an Undo that is off because a newer change exists. */
const newer = (undo: MemoryUndo) => !undo.on && undo.why === "newer"

/**
 * What the memory tool did: a muted line. A saved item has an undo control that does what Undo
 * does in the history. A suggestion has a link to the tab Proposals. Both work on the computer
 * where the change was made. A linked device and the other computer of a sync pair show plain
 * text (012, 019).
 */
const MemoryLine = (props: { agent: Agent; note: MemoryNote; from: string | undefined }) => {
  const { t } = useApp()
  const ui = useUi()
  const here = () => !ui.linked() && props.from === undefined
  const [tick, setTick] = createSignal(0)
  const [error, setError] = createSignal<ErrorText>()
  onCleanup(
    window.robot.on("memory.changed", (e) => {
      if (e.agentId === props.agent.id) setTick((n) => n + 1)
    }),
  )
  // The history keeps 90 days. A change that left it has no undo.
  const [row] = createResource(
    () => {
      const note = props.note
      return note.kind === "saved" && here() ? { id: note.historyId, tick: tick() } : undefined
    },
    ({ id }) => call("memory.history.get", { id }).catch(() => undefined),
  )
  const undo = async () => {
    const note = props.note
    if (note.kind !== "saved") return
    setError(undefined)
    try {
      await call("memory.undo", { id: note.historyId })
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <div
      class={styles.knowledgeLine}
      data-testid={props.note.kind === "saved" ? "memory-saved-line" : "memory-suggested-line"}
    >
      <span>{t(props.note.kind === "saved" ? "chat.memory.saved" : "chat.memory.suggested")}</span>
      <Show when={props.note.kind === "suggested" && here()}>
        <Button onClick={() => openMemory(props.agent.id, "proposals")} data-testid="memory-open">
          {t("chat.memory.open")}
        </Button>
      </Show>
      <Show when={row()}>
        {(r) => (
          <Show
            when={!r().undone}
            fallback={<span data-testid="memory-undone">{t("chat.memory.undone")}</span>}
          >
            <Show
              when={r().undo.on}
              fallback={
                <Show when={newer(r().undo)}>
                  <span data-testid="memory-undo-off">{t("memory.history.newer")}</span>
                </Show>
              }
            >
              <Button onClick={undo} data-testid="memory-undo">
                {t("chat.memory.undo")}
              </Button>
            </Show>
          </Show>
        )}
      </Show>
      <Show when={error()}>
        {(err) => (
          <span class={styles.knowledgeError} role="alert">
            {t(err().key, err().params)}
          </span>
        )}
      </Show>
    </div>
  )
}

type Translate = ReturnType<typeof useApp>["t"]

/** The text of one change from the chat, for its muted line (spec 002). */
const changeText = (t: Translate, change: SettingChange): string => {
  const plain = (v: SettingValue) => (typeof v === "string" && v ? v : t("chat.settings.none"))
  const pair = (key: MessageKey, show: (v: SettingValue) => string) =>
    t(key, { before: show(change.before), after: show(change.after) })
  const option = (prefix: string) => (v: SettingValue) => {
    const key = `${prefix}.${String(v)}` as MessageKey
    return key in catalogues.en ? t(key) : String(v)
  }
  switch (change.field) {
    case "name":
      return pair("chat.settings.name", plain)
    case "role":
      return pair("chat.settings.role", plain)
    case "instructions":
      return t("chat.settings.instructions")
    case "face":
      return t("chat.settings.face")
    case "model": {
      const model = (v: SettingValue) =>
        v && typeof v === "object" && "model" in v ? v : undefined
      const before = model(change.before)
      const after = model(change.after)
      // Only the effort changed: the line names the effort.
      if (before && after && before.model === after.model && before.accountId === after.accountId)
        return pair(
          "chat.settings.effort",
          (v) => model(v)?.effort ?? t("chat.settings.effortDefault"),
        )
      return pair("chat.settings.model", (v) => model(v)?.model ?? t("chat.settings.none"))
    }
    case "language":
      return pair("chat.settings.language", option("settings.language"))
    case "theme":
      return pair("chat.settings.theme", option("settings.theme"))
    case "textSize":
      return pair("chat.settings.textSize", option("settings.textSize"))
    case "compactPlaces":
      return t(change.after ? "chat.settings.compactPlaces.on" : "chat.settings.compactPlaces.off")
    case "reduceMotion":
      return pair("chat.settings.reduceMotion", option("settings.reduceMotion"))
  }
}

/**
 * What a call of the settings tool changed: a muted line with Undo (spec 002). Undo is off when a
 * field changed again since, with the reason. A client of a linked server shows no Undo.
 */
const SettingsLine = (props: {
  agent: Agent
  message: ChatMessage
  part: ToolPart
  note: SettingsNote
}) => {
  const { t } = useApp()
  const ui = useUi()
  const [tick, setTick] = createSignal(0)
  const [error, setError] = createSignal<ErrorText>()
  const bump = () => setTick((n) => n + 1)
  onCleanup(window.robot.on("agents.changed", bump))
  onCleanup(window.robot.on("settings.changed", bump))
  const [state] = createResource(
    () =>
      ui.linked()
        ? undefined
        : { tick: tick(), undone: props.note.undone === true, status: props.message.status },
    () =>
      call("agents.settings.line", {
        agentId: props.agent.id,
        messageId: props.message.id,
        callId: props.part.id,
      }).catch(() => undefined),
  )
  const undo = async () => {
    setError(undefined)
    try {
      await call("agents.settings.undo", {
        agentId: props.agent.id,
        messageId: props.message.id,
        callId: props.part.id,
      })
      bump()
    } catch (e) {
      setError(describeError(e))
    }
  }
  return (
    <div class={styles.knowledgeLine} data-testid="settings-line" data-state={state() ?? ""}>
      <For each={props.note.changes}>
        {(change) => <span data-testid="settings-change">{changeText(t, change)}</span>}
      </For>
      <Show when={state()}>
        {(s) => (
          <Switch>
            <Match when={s() === "undone"}>
              <span data-testid="settings-undone">{t("chat.settings.undone")}</span>
            </Match>
            <Match when={s() === "changed"}>
              <Button disabled data-testid="settings-undo">
                {t("chat.settings.undo")}
              </Button>
              <span data-testid="settings-changed-again">{t("chat.settings.changedAgain")}</span>
            </Match>
            <Match when={s() === "ready"}>
              <Button
                onClick={undo}
                disabled={props.message.status === "streaming"}
                data-testid="settings-undo"
              >
                {t("chat.settings.undo")}
              </Button>
            </Match>
          </Switch>
        )}
      </Show>
      <Show when={error()}>
        {(err) => (
          <span class={styles.knowledgeError} role="alert">
            {t(err().key, err().params)}
          </span>
        )}
      </Show>
    </div>
  )
}

/**
 * A tool step: a knowledge, memory or settings line when the tool is done, otherwise the plain
 * card.
 */
const ToolStep = (props: {
  agent: Agent
  message: ChatMessage
  part: ToolPart
  from: string | undefined
  onCorrect?: (() => void) | undefined
}) => {
  const finished = () => props.part.state === "done" || props.part.state === "failed"
  const note = () => (finished() ? props.part.knowledge : undefined)
  const memory = () => (props.part.state === "done" ? props.part.memory : undefined)
  const settings = () => (props.part.state === "done" ? props.part.settings : undefined)
  return (
    <Show
      when={settings()}
      fallback={
        <Show
          when={note()}
          fallback={
            <Show
              when={memory()}
              fallback={
                <ToolCard
                  agent={props.agent}
                  part={props.part}
                  from={props.from}
                  onCorrect={props.onCorrect}
                />
              }
            >
              {(m) => <MemoryLine agent={props.agent} note={m()} from={props.from} />}
            </Show>
          }
        >
          {(n) => (
            <KnowledgeLine agent={props.agent} part={props.part} note={n()} from={props.from} />
          )}
        </Show>
      }
    >
      {(n) => (
        <SettingsLine agent={props.agent} message={props.message} part={props.part} note={n()} />
      )}
    </Show>
  )
}

/** The steps of a folded run, or undefined for every other row (spec 003, "Folded tool steps"). */
const toolsOf = (segment: PartSegment) => (segment.kind === "tools" ? segment.parts : undefined)

/** The one part of a row, or undefined for a folded run. */
const partOf = (segment: PartSegment) => (segment.kind === "part" ? segment.part : undefined)

/**
 * One row of a reply: a part, or the one line of a run of tool steps.
 *
 * The row is keyed by its place in the reply, not by the value of its segment. A segment is a new
 * object at each change of the reply, so a row keyed by it is made again on every change: an open
 * line closed, and the reply jumped on every step of a long turn (spec 003). The places are safe
 * because the main process only adds a part or changes one in place, and never removes or reorders
 * one, so the row of a place keeps its meaning from the first change to the last.
 */
const SegmentRow = (props: {
  agent: Agent
  message: ChatMessage
  segment: () => PartSegment
  from: string | undefined
  onCorrect?: (() => void) | undefined
}) => (
  <Show
    when={toolsOf(props.segment())}
    fallback={
      <Show when={partOf(props.segment())}>
        {(part) => (
          <PartView
            agent={props.agent}
            message={props.message}
            part={part()}
            from={props.from}
            onCorrect={props.onCorrect}
          />
        )}
      </Show>
    }
  >
    {(parts) => (
      <ToolsFolded
        agent={props.agent}
        message={props.message}
        parts={parts()}
        from={props.from}
        onCorrect={props.onCorrect}
      />
    )}
  </Show>
)

/**
 * A run of plain tool steps as one muted line, when the setting "Show tool steps" is off. The user
 * opens it to read the cards. A step that runs joins the run, so the line keeps its place while
 * the turn goes on (spec 003).
 */
const ToolsFolded = (props: {
  agent: Agent
  message: ChatMessage
  parts: readonly ToolPart[]
  from: string | undefined
  onCorrect?: (() => void) | undefined
}) => {
  const { t } = useApp()
  return (
    <details class={styles.toolsFolded} data-testid="tools-folded" data-count={props.parts.length}>
      <summary data-testid="tools-folded-line">
        {t(foldedToolsKey(props.parts.length), { count: props.parts.length })}
      </summary>
      <For each={props.parts}>
        {(part) => (
          <ToolStep
            agent={props.agent}
            message={props.message}
            part={part}
            from={props.from}
            onCorrect={props.onCorrect}
          />
        )}
      </For>
    </details>
  )
}

/** "Read at the next step" under a message that joined the turn, with Delete while it may go. */
const UnreadLine = (props: { message: ChatMessage; unread: "waiting" | "handed" }) => {
  const { t } = useApp()
  const [failure, setFailure] = createSignal<ErrorText>()
  const remove = async () => {
    setFailure(undefined)
    try {
      await call("chat.unread.delete", {
        agentId: props.message.agentId,
        messageId: props.message.id,
      })
    } catch (e) {
      setFailure(describeError(e))
    }
  }
  return (
    <div class={styles.unread} data-testid="unread-line">
      <span>{t("chat.unread")}</span>
      <Show when={props.unread === "waiting"}>
        <button
          type="button"
          class={styles.unreadDelete}
          onClick={remove}
          data-testid="unread-delete"
        >
          {t("chat.unread.delete")}
        </button>
      </Show>
      <Show when={failure()}>
        {(err) => <span role="alert">{t(err().key, err().params)}</span>}
      </Show>
    </div>
  )
}

const FailedRow = (props: { message: ChatMessage; onRetry: () => void }) => {
  const app = useApp()
  const { t } = app
  const reason = () => {
    const error = props.message.error
    if (!error) return t("error.unknown")
    const key = `error.${error.code}`
    return key in catalogues.en
      ? t(key as MessageKey, { detail: error.detail })
      : t("error.unknown")
  }
  return (
    <div class={styles.failed} role="alert" data-testid="failed-row">
      <span class={styles.failedText}>
        {reason()}
        <Show when={props.message.error?.resetsAt}>
          {(at) => <> {t("chat.limitResets", { time: formatTime(app.locale(), at()) })}</>}
        </Show>
      </span>
      <Button onClick={props.onRetry} data-testid="retry">
        {t("chat.retry")}
      </Button>
      {/* How far the turn went (spec 005). It sits beside Retry. */}
      <Show when={props.message.progress}>
        {(progress) => (
          <p class={styles.failedLine} data-testid="progress-line" data-progress={progress()}>
            {t(`progress.line.${progress()}` as MessageKey)}
          </p>
        )}
      </Show>
    </div>
  )
}

/**
 * One muted line with no task: the watch of a routine checked and saw no change (spec 009,
 * "Post when nothing changed"), or a part of a starter was not made (spec 002, "Starters").
 */
const NoteLine = (props: { message: ChatMessage }) => {
  const app = useApp()
  const { t } = app
  const notes = () =>
    props.message.parts.filter(
      (p): p is Extract<MessagePart, { kind: "note" }> => p.kind === "note",
    )
  const wordsOf = (part: Extract<MessagePart, { kind: "note" }>) => {
    // The muted line of a handover has a link to the new thread (spec 003, "Hand over").
    if (part.note === "handed_over") return ""
    if (part.note === "watch_unchanged") return t("routines.note.unchanged", { name: part.routine })
    if (part.note === "compact_failed")
      return t("chat.compact.failed", { reason: errorWords(t, part.code) })
    if (part.note === "connection_down") return t("chat.note.connectionDown", { name: part.name })
    if (part.note === "connection_held") return t("chat.note.connectionHeld", { name: part.name })
    if (part.note === "setup_failed") return t(setupFailedKey(part.code), { name: part.name })
    if (part.note === "backup_goes_on") return backupWords(app, part)
    if (part.note === "kept_going") return t("chat.note.keptGoing", { n: part.n, of: part.of })
    if (part.note === "busy_retry") return t("chat.note.busyRetry", { n: part.n, of: part.of })
    if (part.note === "tree_repaired")
      return t(
        part.why === "loop" ? "channels.parent.cleared.loop" : "channels.parent.cleared.levels",
      )
    return t(`starters.note.${part.what}.${part.why}` as MessageKey, {
      name: part.name,
      n: part.what === "routine" ? ROUTINES_MAX : SKILLS_MAX,
    })
  }
  const handedOver = () => {
    const part = notes()[0]
    return notes().length === 1 && part?.note === "handed_over" ? part : undefined
  }
  return (
    <div class={styles.noteLine} data-testid="note-line">
      <Show
        when={handedOver()}
        fallback={
          <span class={styles.noteStack}>
            <For each={notes()}>
              {(part) => (
                <span {...(part.note === "busy_retry" ? { "data-testid": "busy-line" } : {})}>
                  {wordsOf(part)}
                </span>
              )}
            </For>
          </span>
        }
      >
        {(part) => (
          <span data-testid="handed-over-line">
            <HandedOverText part={part()} />
          </span>
        )}
      </Show>
      <span>{formatTime(app.locale(), props.message.createdAt)}</span>
    </div>
  )
}

const compactedOf = (message: ChatMessage) =>
  message.parts.find(
    (p): p is Extract<MessagePart, { kind: "compacted" }> => p.kind === "compacted",
  )

/** One part of an agent message: text, thinking, a muted line, or a tool step. */
const PartView = (props: {
  agent: Agent
  message: ChatMessage
  part: MessagePart
  from: string | undefined
  onCorrect?: (() => void) | undefined
}) => (
  <Switch>
    <Match when={props.part.kind === "text"}>
      <Markdown
        text={(props.part as Extract<MessagePart, { kind: "text" }>).text}
        scope={`message:${props.message.id}`}
      />
    </Match>
    <Match when={props.part.kind === "thinking"}>
      <Thinking
        text={(props.part as Extract<MessagePart, { kind: "thinking" }>).text}
        live={thoughtIsLive(props.message)}
      />
    </Match>
    <Match
      when={
        props.part.kind === "note" && props.part.note === "compact_failed" ? props.part : undefined
      }
    >
      {(note) => <CompactFailedLine code={(note() as { code: string }).code} />}
    </Match>
    <Match
      when={
        props.part.kind === "note" && props.part.note === "connection_down" ? props.part : undefined
      }
    >
      {(note) => <ConnectionDownLine name={(note() as { name: string }).name} />}
    </Match>
    <Match
      when={
        props.part.kind === "note" && props.part.note === "connection_held" ? props.part : undefined
      }
    >
      {(note) => <ConnectionHeldLine name={(note() as { name: string }).name} />}
    </Match>
    <Match
      when={
        props.part.kind === "note" && props.part.note === "backup_goes_on" ? props.part : undefined
      }
    >
      {(note) => (
        <BackupGoesOnLine
          part={note() as Extract<MessagePart, { kind: "note"; note: "backup_goes_on" }>}
        />
      )}
    </Match>
    <Match when={setupFailedPart(props.part)}>{(note) => <SetupFailedLine part={note()} />}</Match>
    <Match
      when={props.part.kind === "note" && props.part.note === "kept_going" ? props.part : undefined}
    >
      {(note) => (
        <KeptGoingLine
          part={note() as Extract<MessagePart, { kind: "note"; note: "kept_going" }>}
        />
      )}
    </Match>
    <Match when={busyRetryPart(props.part)}>{(note) => <BusyRetryLine part={note()} />}</Match>
    <Match when={props.part.kind === "tool"}>
      <ToolStep
        agent={props.agent}
        message={props.message}
        part={props.part as Extract<MessagePart, { kind: "tool" }>}
        from={props.from}
        onCorrect={props.onCorrect}
      />
    </Match>
  </Switch>
)

export const MessageRow = (props: MessageRowProps) => (
  <Show
    when={!isNoteOnly(props.message.parts)}
    fallback={
      <Show when={compactedOf(props.message)} fallback={<NoteLine message={props.message} />}>
        {(part) => (
          <div data-message-id={props.message.id} data-testid="message-compacted">
            <CompactedLine part={part()} />
          </div>
        )}
      </Show>
    }
  >
    <Show when={handoverOf(props.message)} fallback={<FullMessageRow {...props} />}>
      {(card) => <HandoverCard message={props.message} part={card()} />}
    </Show>
  </Show>
)

/** The agent who wrote a quoted message, when that agent is still known. */
function quotedSpeaker(
  quoted: ChatMessage,
  current: Agent,
  lookup: (id: string) => Agent | undefined,
) {
  if (quoted.author !== "agent") return undefined
  const id = quoted.speakerId ?? quoted.agentId
  const found = lookup(id)
  if (found) return { id: found.id, name: found.name }
  if (id === current.id) return { id: current.id, name: current.name }
  return undefined
}

const FullMessageRow = (props: MessageRowProps) => {
  const app = useApp()
  const { t } = app
  const agents = useAgents()
  const orgs = useOrgs()
  const devices = useDevices()
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  /** A message from another linked device shows its name. This device does not name itself. */
  const fromOther = () => {
    const from = props.message.fromDevice
    return from && from !== devices.state()?.self.name ? from : undefined
  }
  const isAgent = () => props.message.author === "agent"
  const name = () => (isAgent() ? props.agent.name : t("chat.you"))
  /** The name for a screen reader: with the prefix on, "<name>, <whole organization name>" (spec 036). */
  const label = () => (isAgent() ? orgs.shown(props.agent.id, props.agent.name).label : name())
  const time = () => formatTime(app.locale(), props.message.createdAt)
  /** The name of the sender, as the window shows it: an agent has its organization prefix. */
  const sender = () =>
    isAgent() ? <AgentName id={props.agent.id} name={props.agent.name} /> : name()

  const startEdit = () => {
    setDraft(messageText(props.message))
    setEditing(true)
  }
  const saveEdit = async () => {
    const text = draft().trim()
    if (!text) return
    await props.onEdit(text)
    setEditing(false)
  }

  return (
    <article
      class={styles.row}
      data-first={props.first}
      data-flash={props.flash}
      data-enter={props.enter}
      data-sent={props.sent === true ? "true" : undefined}
      data-message-id={props.message.id}
      data-author={props.message.author}
      data-status={props.message.status}
      data-testid="message"
      aria-label={`${label()}, ${time()}`}
    >
      <Show when={props.first} fallback={<span class={styles.gutterTime}>{time()}</span>}>
        <Show
          when={isAgent()}
          fallback={
            <span class={styles.avatar}>
              <AvatarMark icon={User} size={40} testId="user-mark" />
            </span>
          }
        >
          <span class={styles.avatarSlot}>
            {/* The face opens the profile (spec 002). A removed agent has no profile to open. */}
            <Show
              when={props.agent.id}
              fallback={<Face face={props.agent.face} image={props.agent.faceImage} size={40} />}
            >
              <ProfileButton agent={props.agent} testId="message-avatar">
                <Face face={props.agent.face} image={props.agent.faceImage} size={40} />
              </ProfileButton>
            </Show>
          </span>
        </Show>
      </Show>
      <div class={styles.content}>
        <Show when={props.quoted}>
          {(quoted) => (
            <button
              type="button"
              class={styles.replyLink}
              onClick={() => props.onJumpTo(quoted().id)}
              data-testid="reply-link"
            >
              <Reply size={12} />
              {/* The sender of the quoted message: an agent has its organization prefix (spec 036). */}
              <Show
                when={quotedSpeaker(quoted(), props.agent, (id) => agents.byId(id))}
                fallback={t("chat.repliesTo", {
                  name: quoted().author === "agent" ? t("channels.removedAgent") : t("chat.you"),
                  excerpt: messageText(quoted()).slice(0, 80),
                })}
              >
                {(speaker) => (
                  <AgentInLine
                    line={(name) =>
                      t("chat.repliesTo", { name, excerpt: messageText(quoted()).slice(0, 80) })
                    }
                    id={speaker().id}
                    name={speaker().name}
                  />
                )}
              </Show>
            </button>
          )}
        </Show>
        <Show when={props.first}>
          <div class={styles.head}>
            {/* The name of an agent opens its profile, as the face does. */}
            <Show
              when={isAgent() && props.agent.id}
              fallback={<span class={styles.name}>{sender()}</span>}
            >
              <ProfileButton agent={props.agent} class={styles.nameButton} testId="message-name">
                <span class={styles.name}>{sender()}</span>
              </ProfileButton>
            </Show>
            <Show when={isAgent()}>
              <span class={styles.bot}>{t("chat.bot")}</span>
            </Show>
            <span class={styles.time}>{time()}</span>
          </div>
        </Show>
        <Show
          when={!editing()}
          fallback={
            <div class={styles.box}>
              <textarea
                class={styles.input}
                value={draft()}
                rows={2}
                onInput={(e) => setDraft(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                    e.preventDefault()
                    void saveEdit()
                  } else if (e.key === "Escape") setEditing(false)
                }}
                data-testid="edit-input"
              />
              <Button onClick={() => setEditing(false)}>{t("chat.cancel")}</Button>
              <Button variant="primary" onClick={saveEdit} data-testid="edit-save">
                {t("chat.save")}
              </Button>
            </div>
          }
        >
          <Show
            when={isAgent()}
            fallback={
              <>
                <SentPictures message={props.message} />
                <Show when={messageSkill(props.message)}>
                  {(skill) => <SkillChip skill={skill()} />}
                </Show>
                <Show when={messageText(props.message)}>
                  <p class={styles.userText}>{messageText(props.message)}</p>
                </Show>
                <Show when={fromOther()}>
                  {(from) => (
                    <p class={styles.fromDevice} data-testid="from-device">
                      {t("link.fromDevice", { name: from() })}
                    </p>
                  )}
                </Show>
                <Show when={props.message.fromTeams}>
                  {(sender) => (
                    <p class={styles.fromDevice} data-testid="from-teams">
                      {t("teams.mark.fromName", { name: sender() })}
                    </p>
                  )}
                </Show>
                <Show when={messageFiles(props.message).length > 0}>
                  <ul class={styles.chips} data-testid="message-files">
                    <For each={messageFiles(props.message)}>
                      {(file) => (
                        <FileChip message={props.message} file={file} from={fromOther()} />
                      )}
                    </For>
                  </ul>
                </Show>
                <Show when={props.message.unread}>
                  {(unread) => <UnreadLine message={props.message} unread={unread()} />}
                </Show>
              </>
            }
          >
            <Index each={groupParts(props.message.parts, !app.settings.showToolSteps)}>
              {(segment) => (
                <SegmentRow
                  agent={props.agent}
                  message={props.message}
                  segment={segment}
                  from={fromOther()}
                  onCorrect={props.onCorrect}
                />
              )}
            </Index>
          </Show>
          <Show when={props.message.editedAt}>
            <span class={styles.edited}> {t("chat.edited")}</span>
          </Show>
          <Show when={props.message.status === "stopped"}>
            <span class={styles.stopped} data-testid="stopped-mark">
              {t("chat.stopped")}
            </span>
          </Show>
          {/* A reply that stopped at the step limit has an error: its task has failed (spec 005). */}
          <Show
            when={
              props.message.status === "failed" ||
              (props.message.status === "stopped" && props.message.error !== null)
            }
          >
            <FailedRow message={props.message} onRetry={props.onRetry} />
          </Show>
        </Show>
      </div>
      <Show when={!editing() && props.message.status !== "streaming"}>
        <div class={styles.actions}>
          <IconButton label={t("chat.reply")} onClick={props.onReply} data-testid="action-reply">
            <Reply size={16} />
          </IconButton>
          <IconButton
            label={t("chat.copy")}
            onClick={() => call("app.copy", { text: messageText(props.message) })}
            data-testid="action-copy"
          >
            <Copy size={16} />
          </IconButton>
          <Show when={props.canEdit}>
            <IconButton label={t("chat.edit")} onClick={startEdit} data-testid="action-edit">
              <Pencil size={16} />
            </IconButton>
          </Show>
          <Show when={props.onFork}>
            {(fork) => (
              <IconButton
                label={props.forkOff ?? t("chat.fork")}
                onClick={() => fork()()}
                disabled={props.forkOff !== undefined}
                data-testid="action-fork"
              >
                <GitBranch size={16} />
              </IconButton>
            )}
          </Show>
        </div>
      </Show>
    </article>
  )
}
