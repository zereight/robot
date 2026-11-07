import {
  type ChatAnswer,
  type ChatMarks,
  type ChatMeter,
  type ModelChoice,
  sameChatDay,
  startsChatGroup,
  type WorkflowChatMessage,
} from "@robot/shared"
import { ChevronDown, ChevronUp, X } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { outsideText, sensitiveText } from "../lib/runText.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Confirm } from "../ui/Confirm.tsx"
import { Button } from "../ui/controls.tsx"
import { Keyed } from "../ui/Keyed.tsx"
import { Spinner } from "../ui/Spinner.tsx"
import { showToast } from "../ui/toast.ts"
import { WorkMark } from "../ui/WorkMark.tsx"
import { BrowserStrip } from "./BrowserStrip.tsx"
import { CompactedLine, compactedPart } from "./CompactedLine.tsx"
import { Composer } from "./Composer.tsx"
import { ContextMeter } from "./ContextMeter.tsx"
import cards from "./cards.module.css"
import styles from "./chat.module.css"
import { findHits, locate, stepHit } from "./find.ts"
import { formatDay } from "./format.ts"
import { MessageRow } from "./MessageRow.tsx"
import { RunCards } from "./RunCards.tsx"
import { createChatState } from "./state.ts"

const PHRASES = 20

/** The line under the last row while the responsible document works (spec 003, "States"). */
const WorkingLine = (props: { since: number; compacting: boolean }) => {
  const { t } = useApp()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  // About half of the turns show a playful phrase. The turn keeps the one it got.
  const phrase = () => {
    // A compact says what happens, with no playful phrase (spec 003, "Compact").
    if (props.compacting) return t("chat.compacting")
    const seed = Math.floor(props.since / 7)
    return seed % 2 === 0
      ? t("chat.working")
      : t(`chat.phrase.${(seed % PHRASES) + 1}` as Parameters<typeof t>[0])
  }
  const seconds = () => Math.max(0, Math.floor((now() - props.since) / 1000))
  return (
    <div class={styles.working} role="status" data-testid="working-line">
      <WorkMark />
      <span>{phrase()}</span>
      <span class={styles.elapsed}>{t("chat.elapsed", { seconds: seconds() })}</span>
    </div>
  )
}

/**
 * The header of the chat: the account and the model that answer now, and a list to pick another
 * one. The list is read when the chat opens and when an account changes, not for every message.
 */
const AnswerHeader = (props: {
  running: boolean
  workflowId: string
  answer: ChatAnswer
  unsafeAccount: string | null
  meter: ChatMeter
  compacting: boolean
  onCompact: () => void
}) => {
  const { t } = useApp()
  const ui = useUi()
  const [choices, { refetch }] = createResource(
    (): Promise<readonly ModelChoice[]> => call("models.available").catch(() => []),
  )
  onCleanup(window.robot.on("providers.changed", () => void refetch()))
  const key = (accountId: string, model: string) => `${accountId}\u0000${model}`
  const options = () => {
    const now = props.answer
    const out: { value: string; label: string }[] = []
    // An account whose program cannot be locked to text only is not offered (spec 007).
    for (const c of (choices() ?? []).filter((x) => x.chatSafe !== false))
      for (const m of c.models)
        if (m.hidden !== true || (c.accountId === now.accountId && m.id === now.model))
          out.push({
            value: key(c.accountId, m.id),
            label: t("chat.model.option", { account: c.accountName, model: m.id }),
          })
    const current = key(now.accountId, now.model)
    // The list may not be read yet, or may not hold the model that answers: it always shows it.
    if (!out.some((o) => o.value === current))
      out.unshift({
        value: current,
        label: t("chat.model.option", { account: now.accountName, model: now.model }),
      })
    return out
  }
  const pick = (value: string) => {
    const [accountId = "", model = ""] = value.split("\u0000")
    call("chat.setModel", { workflowId: props.workflowId, accountId, model }).catch(
      (e: unknown) => {
        const text = describeError(e)
        showToast("error", text.key, text.params)
      },
    )
  }
  return (
    <>
      <div class={styles.head}>
        <Show when={props.running}>
          <Spinner testId="chat-spinner" label={t("workflows.run.state.running")} />
        </Show>
        <label for="chat-model">{t("chat.model.label")}</label>
        <select
          id="chat-model"
          class={styles.modelPick}
          data-testid="chat-model"
          onChange={(e) => pick(e.currentTarget.value)}
        >
          <For each={options()}>
            {(o) => (
              <option
                value={o.value}
                selected={o.value === key(props.answer.accountId, props.answer.model)}
              >
                {o.label}
              </option>
            )}
          </For>
        </select>
        <ContextMeter
          meter={props.meter}
          compacting={props.compacting}
          canCompact={ui.server()?.kind === "local"}
          onCompact={props.onCompact}
        />
      </div>
      <Show when={props.unsafeAccount}>
        {(account) => (
          <p class={styles.noFeedback} role="status" data-testid="chat-unsafe-account">
            {t("chat.unsafeAccount", { account: account() })}
          </p>
        )}
      </Show>
      <Show when={!props.answer.feedback}>
        <p class={styles.noFeedback} role="status" data-testid="chat-no-feedback">
          {t("chat.noFeedback", { account: props.answer.accountName })}
        </p>
      </Show>
    </>
  )
}

/**
 * The marks of the chat (spec 007, "The mark of a place"): outside content, the program mark and a
 * sensitive read. They stay until the user clears them, after a confirm.
 */
const MarksLine = (props: { workflowId: string; marks: ChatMarks }) => {
  const { t } = useApp()
  const [asking, setAsking] = createSignal(false)
  const any = () => props.marks.outside || props.marks.program || props.marks.sensitive
  return (
    <Show when={any()}>
      <Show
        when={asking()}
        fallback={
          <div class={cards.marks} data-testid="chat-marks">
            <Show when={props.marks.outside}>
              {(source) => (
                <span data-testid="chat-mark-outside">
                  {t("chat.marks.outside", { source: outsideText(t, source()) })}
                </span>
              )}
            </Show>
            <Show when={props.marks.program}>
              <span data-testid="chat-mark-program">{t("chat.marks.program")}</span>
            </Show>
            <Show when={props.marks.sensitive}>
              {(label) => (
                <span data-testid="chat-mark-sensitive">
                  {t("chat.marks.sensitive", { label: sensitiveText(t, label()) })}
                </span>
              )}
            </Show>
            <Button onClick={() => setAsking(true)} data-testid="chat-marks-clear">
              {t("chat.marks.clear")}
            </Button>
          </div>
        }
      >
        <Confirm
          ask={t("chat.marks.clear.ask")}
          confirm={t("chat.marks.clear.confirm")}
          keep={t("common.keep")}
          testId="chat-marks-ask"
          confirmTestId="chat-marks-confirm"
          keepTestId="chat-marks-keep"
          onKeep={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false)
            void call("chat.clearMarks", { workflowId: props.workflowId }).catch(() => {})
          }}
        />
      </Show>
    </Show>
  )
}

/** True for a box that takes typed text. */
const isTextEntry = (el: HTMLElement): boolean =>
  el.isContentEditable || el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement

/** The chat of a workflow, beside its canvas (spec 001, 003). */
export const ChatPanel = (props: {
  workflowId: string
  /** True while a run of the workflow is not final: the head shows a spinner (specs/039). */
  running?: boolean
}) => {
  const { t, locale } = useApp()
  const ui = useUi()
  const { history, error } = createChatState(() => props.workflowId)
  const [replyTo, setReplyTo] = createSignal<WorkflowChatMessage>()
  const [compactError, setCompactError] = createSignal<ErrorText>()
  const [stick, setStick] = createSignal(true)
  const [finding, setFinding] = createSignal(false)
  const [query, setQuery] = createSignal("")
  const [current, setCurrent] = createSignal(0)
  const [count, setCount] = createSignal(0)
  let scroller: HTMLDivElement | undefined
  let findBox: HTMLInputElement | undefined

  const messages = () => history()?.messages ?? []
  const byId = createMemo(() => new Map(messages().map((m) => [m.id, m])))

  const toBottom = () => {
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }
  const atBottom = () =>
    scroller !== undefined &&
    scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48
  // The unread count clears when the chat shows its latest message (spec 003, "Mark as unread").
  // A scroll that the reader did not cause (the chat follows a new reply, a layout change) is not
  // the reader seeing the end, so only a scroll after a wheel, a touch, a drag or a key counts.
  let readerAt = 0
  const readerActed = (e: Event) => {
    // Typing in a box of the chat (the edit box of a message) is not the reader looking at the end.
    if (e.type === "keydown" && e.target instanceof HTMLElement && isTextEntry(e.target)) return
    readerAt = Date.now()
  }
  const markRead = () => {
    if ((history()?.unread.count ?? 0) > 0)
      void call("chat.read", { workflowId: props.workflowId }).catch(() => {})
  }
  const onScroll = () => {
    if (!scroller) return
    setStick(atBottom())
    if (atBottom() && Date.now() - readerAt < 1000) markRead()
  }
  // A chat that fits in its box shows its latest message and never scrolls, so no scroll event can
  // clear its count. After a mark (or any change of the messages or the size of the box) the count
  // clears when the whole chat is in view, and only while the window is shown.
  const clearIfWhole = () => {
    if (!scroller || (history()?.unread.count ?? 0) === 0) return
    if (document.visibilityState !== "visible") return
    if (scroller.scrollHeight <= scroller.clientHeight + 1) markRead()
  }
  createEffect(() => {
    history()?.unread.count
    messages()
    requestAnimationFrame(clearIfWhole)
  })
  // The chat follows the latest message, until the reader scrolls up.
  createEffect(() => {
    messages()
    history()?.working
    if (stick()) queueMicrotask(toBottom)
  })
  createEffect(
    on(
      () => props.workflowId,
      () => {
        positioned = false
        setStick(true)
        setReplyTo(undefined)
        setFinding(false)
        setQuery("")
      },
    ),
  )

  // When the chat opens with unread replies, it opens at the first of them (spec 003, "Mark as
  // unread"). When the first unread reply is already at the end of the chat, the chat shows its
  // latest message and the count clears at once.
  let positioned = false
  createEffect(() => {
    const h = history()
    if (!h || positioned) return
    positioned = true
    const first = h.unread.firstId
    if (first === null) return
    setStick(false)
    requestAnimationFrame(() => {
      document.getElementById(`message-${first}`)?.scrollIntoView({ block: "start" })
      if (atBottom()) markRead()
    })
  })
  const goToUnread = () => {
    const first = history()?.unread.firstId
    if (first) document.getElementById(`message-${first}`)?.scrollIntoView({ block: "start" })
  }

  const jump = (id: string) => {
    const el = document.getElementById(`message-${id}`)
    if (!el) return
    el.scrollIntoView({ block: "center" })
    el.setAttribute("data-flash", "true")
    setTimeout(() => el.removeAttribute("data-flash"), 1200)
  }

  // Find in the chat (flow 10): Cmd+F opens a bar. The hits are marks on the text that is drawn,
  // so the chat is not drawn again for a find.
  const marks = () => (CSS as unknown as { highlights?: Map<string, unknown> }).highlights
  const clearMarks = () => {
    marks()?.delete("chat-find")
    marks()?.delete("chat-find-current")
  }
  /** The ranges of every hit, in the order of the messages. */
  const ranges = (): Range[] => {
    const q = query()
    if (!finding() || q === "" || !scroller) return []
    const out: Range[] = []
    for (const container of scroller.querySelectorAll('[data-testid="message-text"]')) {
      const nodes: Text[] = []
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text)
      const segments = nodes.map((n) => n.data)
      for (const hit of findHits(segments.join(""), q)) {
        const a = locate(segments, hit.start)
        const b = locate(segments, hit.end, true)
        const first = nodes[a.segment]
        const last = nodes[b.segment]
        if (!first || !last) continue
        const range = document.createRange()
        range.setStart(first, a.offset)
        range.setEnd(last, b.offset)
        out.push(range)
      }
    }
    return out
  }
  const paint = () => {
    clearMarks()
    const found = ranges()
    setCount(found.length)
    const HighlightClass = (globalThis as unknown as { Highlight?: new (...r: Range[]) => unknown })
      .Highlight
    if (!HighlightClass || found.length === 0) return
    const at = Math.min(current(), found.length - 1)
    marks()?.set("chat-find", new HighlightClass(...found))
    const here = found[at]
    if (here) {
      marks()?.set("chat-find-current", new HighlightClass(here))
      here.startContainer.parentElement?.scrollIntoView({ block: "center" })
    }
  }
  createEffect(
    on([query, finding, current, messages], () => {
      queueMicrotask(paint)
    }),
  )
  const closeFind = () => {
    setFinding(false)
    setQuery("")
    setCurrent(0)
    clearMarks()
  }
  onCleanup(clearMarks)
  const step = (by: 1 | -1) => setCurrent((c) => stepHit(c, count(), by))

  onMount(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        // Settings cover the chat: Cmd+F finds in a chat that shows, and does nothing here (spec 001).
        if (ui.settingsSection() !== undefined) return
        event.preventDefault()
        setFinding(true)
        queueMicrotask(() => findBox?.select())
      }
    }
    window.addEventListener("keydown", onKey)
    onCleanup(() => window.removeEventListener("keydown", onKey))
  })

  const toastError = (e: unknown) => {
    const text = describeError(e)
    showToast("error", text.key, text.params)
  }
  /** Compact (spec 003). A failure shows in the error line above the box. */
  const compactNow = () => {
    setCompactError(undefined)
    call("chat.compact", { workflowId: props.workflowId }).catch((e: unknown) =>
      setCompactError(describeError(e)),
    )
  }
  const retry = () => void call("chat.retry", { workflowId: props.workflowId }).catch(toastError)
  const resume = (mode: "continue" | "again") =>
    void call("chat.resume", { workflowId: props.workflowId, mode }).catch(toastError)

  return (
    <section class={styles.panel} aria-label={t("chat.title")} data-testid="chat">
      <Show when={finding()}>
        <div class={styles.findBar} data-testid="find-bar">
          <input
            ref={(el) => {
              findBox = el
            }}
            class={styles.findInput}
            type="search"
            value={query()}
            placeholder={t("chat.find.placeholder")}
            aria-label={t("chat.find.placeholder")}
            data-testid="find-input"
            onInput={(e) => {
              setQuery(e.currentTarget.value)
              setCurrent(0)
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                step(e.shiftKey ? -1 : 1)
              } else if (e.key === "Escape") {
                e.preventDefault()
                closeFind()
              }
            }}
          />
          <span class={styles.findCount} data-testid="find-count">
            {query() === ""
              ? ""
              : count() === 0
                ? t("chat.find.none")
                : t("chat.find.count", { n: Math.min(current(), count() - 1) + 1, m: count() })}
          </span>
          <button
            type="button"
            class={styles.action}
            onClick={() => step(-1)}
            aria-label={t("chat.find.previous")}
            title={t("chat.find.previous")}
            data-testid="find-previous"
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            class={styles.action}
            onClick={() => step(1)}
            aria-label={t("chat.find.next")}
            title={t("chat.find.next")}
            data-testid="find-next"
          >
            <ChevronDown size={14} />
          </button>
          <button
            type="button"
            class={styles.action}
            onClick={closeFind}
            aria-label={t("chat.find.close")}
            title={t("chat.find.close")}
            data-testid="find-close"
          >
            <X size={14} />
          </button>
        </div>
      </Show>
      <Show
        when={history()}
        fallback={
          <p class={styles.loading} role={error() ? "alert" : "status"}>
            {error() ? t("error.unknown") : t("chat.loading")}
          </p>
        }
      >
        {(h) => (
          <>
            <Show when={h().answer}>
              {(answer) => (
                <AnswerHeader
                  running={props.running === true}
                  workflowId={props.workflowId}
                  answer={answer()}
                  unsafeAccount={h().unsafeAccount}
                  meter={h().meter}
                  compacting={h().compacting}
                  onCompact={compactNow}
                />
              )}
            </Show>
            <Show when={h().unread.count > 0}>
              <button
                type="button"
                class={styles.unread}
                title={t("chat.unread.go")}
                onClick={goToUnread}
                data-testid="chat-unread"
                data-count={h().unread.count}
              >
                {t("chat.unread", { count: h().unread.count })}
              </button>
            </Show>
            <MarksLine workflowId={props.workflowId} marks={h().marks} />
            <div
              class={styles.scroll}
              ref={(el) => {
                scroller = el
                // The box can grow (the window gets larger) until the whole chat is in view.
                const sizes = new ResizeObserver(() => clearIfWhole())
                sizes.observe(el)
                onCleanup(() => sizes.disconnect())
                // What the reader does to the chat: only a scroll after one of these may clear the count.
                for (const type of ["wheel", "touchmove", "pointerdown", "keydown"])
                  el.addEventListener(type, readerActed, { passive: true })
              }}
              onScroll={onScroll}
              data-testid="chat-scroll"
            >
              <Show
                when={h().messages.length > 0}
                fallback={
                  <div class={styles.empty} data-testid="chat-empty">
                    <strong>{h().workflowName}</strong>
                    <span>{t("chat.empty")}</span>
                  </div>
                }
              >
                <Keyed each={h().messages} by={(message) => message.id}>
                  {(item, i) => {
                    const message = item
                    const previous = () => h().messages[i() - 1]
                    const newDay = () =>
                      !previous() || !sameChatDay(previous()?.createdAt ?? 0, message().createdAt)
                    return (
                      <>
                        <Show when={newDay()}>
                          <div class={styles.day} data-testid="day-line">
                            {formatDay(
                              locale(),
                              message().createdAt,
                              t("chat.today"),
                              t("chat.yesterday"),
                            )}
                          </div>
                        </Show>
                        <Show
                          when={compactedPart(message()) === undefined}
                          fallback={<CompactedLine message={message()} />}
                        >
                          <MessageRow
                            message={message()}
                            name={h().workflowName}
                            header={newDay() || startsChatGroup(previous(), message())}
                            quoted={
                              message().replyTo ? byId().get(message().replyTo ?? "") : undefined
                            }
                            last={i() === h().messages.length - 1}
                            working={h().working}
                            editable={h().editableId === message().id}
                            onReply={setReplyTo}
                            onJump={jump}
                            onRetry={retry}
                          />
                        </Show>
                      </>
                    )
                  }}
                </Keyed>
              </Show>
              <Show when={h().cards.length > 0}>
                <RunCards cards={h().cards} />
              </Show>
              <Show when={h().working && h().workingSince !== null}>
                <WorkingLine since={h().workingSince ?? 0} compacting={h().compacting} />
              </Show>
            </div>
            <Show when={!stick()}>
              <button
                type="button"
                class={styles.jumpLatest}
                onClick={() => {
                  setStick(true)
                  toBottom()
                  markRead()
                }}
                data-testid="jump-latest"
              >
                {t("chat.jumpLatest")}
              </button>
            </Show>
            <Show when={h().notice}>
              {(notice) => (
                <div class={styles.notice} role="status" data-testid="restart-notice">
                  <span>{notice().notSent ? t("chat.notice.notSent") : t("chat.notice.cut")}</span>
                  <Show
                    when={notice().notSent}
                    fallback={
                      <Button onClick={() => resume("continue")} data-testid="notice-continue">
                        {t("chat.continue")}
                      </Button>
                    }
                  >
                    <Button onClick={() => resume("again")} data-testid="notice-again">
                      {t("chat.sendAgain")}
                    </Button>
                  </Show>
                </div>
              )}
            </Show>
            <BrowserStrip workflowId={props.workflowId} />
            <Composer
              history={h()}
              replyTo={replyTo()}
              onCancelReply={() => setReplyTo(undefined)}
              compactError={compactError()}
              onCompact={compactNow}
              onSent={() => {
                setCompactError(undefined)
                setStick(true)
                queueMicrotask(toBottom)
              }}
            />
          </>
        )}
      </Show>
    </section>
  )
}
