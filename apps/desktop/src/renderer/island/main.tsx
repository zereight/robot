import {
  attentionIndex,
  catalogues,
  formatRunTime,
  ISLAND_CLOSE_MS,
  ISLAND_RESULT_MS,
  type IslandAttention,
  type IslandDoing,
  type IslandState,
  islandShape,
  type MessageKey,
  resolveLocale,
  translate,
} from "@robot/shared"
import { Bot, ChevronLeft, ChevronRight } from "lucide-solid"
import {
  createEffect,
  createMemo,
  createRoot,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { render } from "solid-js/web"
import { Face } from "../agents/Face.tsx"
import { call } from "../lib/rpc.ts"
import "./island.css"

const [initialSettings, info] = await Promise.all([call("settings.get"), call("app.info")])
// The language and the motion setting can change while the island is open.
const [settings, setSettings] = createSignal(initialSettings)
window.robot.on("settings.changed", setSettings)
const locale = () => resolveLocale(settings().language, info.systemLocale)
const t = (key: MessageKey, params?: Record<string, string | number>) =>
  translate(locale(), key, params)
const [systemReduced, setSystemReduced] = createSignal(
  matchMedia("(prefers-reduced-motion: reduce)").matches,
)
matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", (e) =>
  setSystemReduced(e.matches),
)
const noMotion = () =>
  settings().reduceMotion === "on" || (settings().reduceMotion === "system" && systemReduced())
createRoot(() => createEffect(() => (document.documentElement.lang = locale())))

const placeText = (place: string | null) =>
  place === null ? t("island.place.direct") : t("island.place.channel", { name: place })

const doingText = (doing: IslandDoing) =>
  doing.kind === "plan"
    ? doing.label
    : doing.kind === "tool"
      ? t(`island.doing.${doing.tool}`)
      : t("island.doing.working")

/** The kind of step for an approval, or "Question". */
const stepText = (a: IslandAttention) =>
  a.kind === "question"
    ? t("island.step.question")
    : t(a.step ? `island.step.${a.step}` : "island.step.approval")

/** The reason of a failure, in the language of the interface. */
const reasonText = (reason: { code: string; detail: string } | null) => {
  if (!reason) return ""
  const key = `error.${reason.code}`
  return t(key in catalogues.en ? (key as MessageKey) : "error.unknown", { detail: reason.detail })
}

/** Keeps the window as big as the content: the page tells the main process its size. */
const useFit = () => {
  let element: HTMLElement | undefined
  onMount(() => {
    if (!element) return
    let last = ""
    const send = () => {
      if (!element) return
      const box = element.getBoundingClientRect()
      const size = { width: Math.ceil(box.width), height: Math.ceil(box.height) }
      const key = `${size.width}x${size.height}`
      if (key === last) return
      last = key
      void call("island.fit", size)
    }
    const watcher = new ResizeObserver(send)
    watcher.observe(element)
    send()
    onCleanup(() => watcher.disconnect())
  })
  return (el: HTMLElement) => {
    element = el
  }
}

const Island = () => {
  const [state, setState] = createSignal<IslandState>(initialState)
  onCleanup(window.robot.on("island.state", setState))
  const fit = useFit()

  const shape = () => islandShape(state())
  const [detail, setDetail] = createSignal(false)
  // Set when the user closes the card with a click. The pointer must leave before it opens again.
  let held = false
  let closeTimer: ReturnType<typeof setTimeout> | undefined
  const [pointer, setPointer] = createSignal(false)

  const canDetail = () => shape() === "bar" && state().count > 0
  const view = (): "bar" | "detail" | "attention" | "result" => {
    const s = shape()
    if (s === "attention" || s === "result") return s
    return detail() && canDetail() ? "detail" : "bar"
  }

  const stopClose = () => {
    if (closeTimer) clearTimeout(closeTimer)
    closeTimer = undefined
  }
  const enter = () => {
    setPointer(true)
    stopClose()
    if (!held && canDetail()) setDetail(true)
  }
  const leave = () => {
    setPointer(false)
    held = false
    stopClose()
    closeTimer = setTimeout(() => setDetail(false), ISLAND_CLOSE_MS)
  }
  const toggle = () => {
    if (!canDetail()) return
    if (detail()) {
      setDetail(false)
      held = true
    } else setDetail(true)
  }
  onCleanup(stopClose)
  // The card goes when no agent works any more, or when another card takes the island.
  createEffect(() => {
    if (!canDetail()) setDetail(false)
  })
  // The pointer can leave while the window is hidden or changes shape. A leave that no event
  // reports must still close the card.
  const onDocumentLeave = () => leave()
  document.documentElement.addEventListener("mouseleave", onDocumentLeave)
  onCleanup(() => document.documentElement.removeEventListener("mouseleave", onDocumentLeave))

  // The time of each row ticks once each second while the detail card is open.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (view() !== "detail") return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  // The attention card: which request shows.
  const [index, setIndex] = createSignal(0)
  let before: readonly IslandAttention[] = initialState.waiting
  createEffect(
    on(
      () => state().waiting,
      (next) => {
        setIndex(attentionIndex(before, index(), next))
        before = next
      },
    ),
  )
  const current = createMemo(() => state().waiting[index()] ?? state().waiting[0])
  const step = (by: number) => {
    const n = state().waiting.length
    if (n > 1) setIndex((index() + by + n) % n)
  }

  // The result card stays 6 seconds, and as long as the pointer is on it.
  let resultTimer: ReturnType<typeof setTimeout> | undefined
  let resultDue = false
  const resultId = () => state().result?.id
  const dismiss = (id: number) => void call("island.dismissResult", { id })
  createEffect(
    on(resultId, (id) => {
      if (resultTimer) clearTimeout(resultTimer)
      resultDue = false
      if (id === undefined) return
      resultTimer = setTimeout(() => {
        if (pointer()) resultDue = true
        else dismiss(id)
      }, ISLAND_RESULT_MS)
    }),
  )
  createEffect(() => {
    const id = resultId()
    if (!pointer() && resultDue && id !== undefined) {
      resultDue = false
      dismiss(id)
    }
  })
  onCleanup(() => resultTimer && clearTimeout(resultTimer))

  const respond = (a: IslandAttention, answer: "allow" | "always" | "deny") =>
    call("island.respond", { agentId: a.agentId, callId: a.callId, answer })
  const open = (target: IslandAttention["target"]) => call("island.openApp", { target })

  return (
    <section
      ref={fit}
      class="island"
      aria-label={t("island.label")}
      data-view={view()}
      data-motion={noMotion() ? "off" : "on"}
      data-testid="island"
      onPointerEnter={enter}
      onPointerLeave={leave}
    >
      {/* The bar stays above the detail card and the result card. The attention card replaces it. */}
      <Show when={view() !== "attention"}>
        <button
          type="button"
          class="bar"
          data-testid="island-bar"
          aria-expanded={view() === "detail"}
          aria-label={
            state().count > 0 ? t("island.count.label", { count: state().count }) : t("app.name")
          }
          onClick={toggle}
        >
          <Bot size={16} aria-hidden="true" />
          <span class="spacer" />
          <Show when={state().count > 0} fallback={<span class="dot" data-testid="island-idle" />}>
            <span class="faces" data-testid="island-working">
              <For each={state().working}>
                {(a) => (
                  <span class="face" title={a.name}>
                    <Face face={a.face} size={22} />
                  </span>
                )}
              </For>
            </span>
            <span class="count" data-testid="island-count" aria-hidden="true">
              {state().count}
            </span>
          </Show>
        </button>
      </Show>

      <Show when={view() === "detail"}>
        <section
          class="card detail"
          aria-label={t("island.detail.label")}
          data-testid="island-detail"
        >
          <For each={state().rows}>
            {(row) => (
              <button
                type="button"
                class="row"
                data-testid="island-row"
                aria-label={t("island.row.label", {
                  name: row.agent.name,
                  place: placeText(row.place),
                  doing: doingText(row.doing),
                  time: formatRunTime(now() - row.since),
                })}
                onClick={() => open(row.target)}
              >
                <Face face={row.agent.face} size={28} />
                <span class="row-text">
                  <span class="row-head">
                    <strong data-testid="island-row-name">{row.agent.name}</strong>
                    <span class="place" data-testid="island-row-place">
                      {placeText(row.place)}
                    </span>
                  </span>
                  <span class="doing" data-testid="island-row-doing" data-kind={row.doing.kind}>
                    {doingText(row.doing)}
                  </span>
                </span>
                <span class="time" data-testid="island-row-time">
                  {formatRunTime(now() - row.since)}
                </span>
              </button>
            )}
          </For>
          <Show when={state().count > state().rows.length}>
            <div class="more" data-testid="island-more">
              {t("island.more", { count: state().count - state().rows.length })}
            </div>
          </Show>
        </section>
      </Show>

      <Show when={view() === "attention" ? current() : undefined}>
        {(a) => (
          <section
            class="card attention"
            aria-label={t("island.attention.label")}
            data-testid="island-attention"
          >
            <div class="head">
              <Face face={a().agent.face} size={30} />
              <div class="text">
                <strong>{a().agent.name}</strong>
                <span class="meta" data-testid="island-meta">
                  {placeText(a().place)} · {stepText(a())}
                </span>
              </div>
              <Show when={state().waiting.length > 1}>
                <div class="pager">
                  <button
                    type="button"
                    class="icon"
                    data-testid="island-prev"
                    aria-label={t("island.previous")}
                    onClick={() => step(-1)}
                  >
                    <ChevronLeft size={14} aria-hidden="true" />
                  </button>
                  <span
                    class="position"
                    role="status"
                    data-testid="island-position"
                    aria-label={t("island.position.label", {
                      index: index() + 1,
                      count: state().waiting.length,
                    })}
                  >
                    {t("island.position", { index: index() + 1, count: state().waiting.length })}
                  </span>
                  <button
                    type="button"
                    class="icon"
                    data-testid="island-next"
                    aria-label={t("island.next")}
                    onClick={() => step(1)}
                  >
                    <ChevronRight size={14} aria-hidden="true" />
                  </button>
                </div>
              </Show>
            </div>
            <span class="summary" data-kind={a().kind} data-testid="island-summary">
              {a().summary}
            </span>
            <div class="buttons">
              <Show when={a().kind === "approval"}>
                <button
                  type="button"
                  class="primary"
                  data-testid="island-allow"
                  onClick={() => respond(a(), "allow")}
                >
                  {t("chat.tool.allow")}
                </button>
                <button
                  type="button"
                  data-testid="island-always"
                  onClick={() => respond(a(), "always")}
                >
                  {t("chat.tool.always")}
                </button>
                <button
                  type="button"
                  data-testid="island-deny"
                  onClick={() => respond(a(), "deny")}
                >
                  {t("chat.tool.deny")}
                </button>
              </Show>
              <button type="button" data-testid="island-open" onClick={() => open(a().target)}>
                {t("island.open")}
              </button>
            </div>
          </section>
        )}
      </Show>

      <Show when={view() === "result" ? state().result : undefined}>
        {(r) => (
          <div
            class="card result"
            role="status"
            aria-label={t(`island.result.${r().kind}`)}
            data-testid="island-result"
            data-kind={r().kind}
          >
            <div class="head">
              <Face face={r().agent.face} size={30} />
              <div class="text">
                <span class="row-head">
                  <strong data-testid="island-result-name">{r().agent.name}</strong>
                  <span class="place" data-testid="island-result-place">
                    {placeText(r().place)}
                  </span>
                </span>
                <span class="summary" data-testid="island-result-line">
                  {r().reason ? reasonText(r().reason) : r().line}
                </span>
              </div>
            </div>
            <div class="buttons">
              <button
                type="button"
                data-testid="island-result-open"
                onClick={() => open(r().target)}
              >
                {t("island.open")}
              </button>
            </div>
          </div>
        )}
      </Show>
    </section>
  )
}

const initialState: IslandState = await call("island.get")
const root = document.getElementById("root")
if (root) render(() => <Island />, root)
