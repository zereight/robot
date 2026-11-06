import { sameChatDay, startsChatGroup, type WorkflowChatMessage } from "@robot/shared"
import { ChevronDown, ChevronUp, X } from "lucide-solid"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { describeError } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { showToast } from "../ui/toast.ts"
import { WorkMark } from "../ui/WorkMark.tsx"
import { Composer } from "./Composer.tsx"
import styles from "./chat.module.css"
import { findHits, locate, stepHit } from "./find.ts"
import { formatDay } from "./format.ts"
import { MessageRow } from "./MessageRow.tsx"
import { createChatState } from "./state.ts"

const PHRASES = 20

/** The line under the last row while the responsible document works (spec 003, "States"). */
const WorkingLine = (props: { since: number }) => {
  const { t } = useApp()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(timer))
  // About half of the turns show a playful phrase. The turn keeps the one it got.
  const phrase = () => {
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

/** The chat of a workflow, beside its canvas (spec 001, 003). */
export const ChatPanel = (props: { workflowId: string }) => {
  const { t, locale } = useApp()
  const { history, error } = createChatState(() => props.workflowId)
  const [replyTo, setReplyTo] = createSignal<WorkflowChatMessage>()
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
  const onScroll = () => {
    if (!scroller) return
    setStick(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 48)
  }
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
        setStick(true)
        setReplyTo(undefined)
        setFinding(false)
        setQuery("")
      },
    ),
  )

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
            <div
              class={styles.scroll}
              ref={(el) => {
                scroller = el
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
                <For each={h().messages}>
                  {(message, i) => {
                    const previous = () => h().messages[i() - 1]
                    const newDay = () =>
                      !previous() || !sameChatDay(previous()?.createdAt ?? 0, message.createdAt)
                    return (
                      <>
                        <Show when={newDay()}>
                          <div class={styles.day} data-testid="day-line">
                            {formatDay(
                              locale(),
                              message.createdAt,
                              t("chat.today"),
                              t("chat.yesterday"),
                            )}
                          </div>
                        </Show>
                        <MessageRow
                          message={message}
                          name={h().workflowName}
                          header={newDay() || startsChatGroup(previous(), message)}
                          quoted={message.replyTo ? byId().get(message.replyTo) : undefined}
                          last={i() === h().messages.length - 1}
                          working={h().working}
                          onReply={setReplyTo}
                          onJump={jump}
                          onRetry={retry}
                        />
                      </>
                    )
                  }}
                </For>
              </Show>
              <Show when={h().working && h().workingSince !== null}>
                <WorkingLine since={h().workingSince ?? 0} />
              </Show>
            </div>
            <Show when={!stick()}>
              <button
                type="button"
                class={styles.jumpLatest}
                onClick={() => {
                  setStick(true)
                  toBottom()
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
            <Composer
              history={h()}
              replyTo={replyTo()}
              onCancelReply={() => setReplyTo(undefined)}
              onSent={() => {
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
