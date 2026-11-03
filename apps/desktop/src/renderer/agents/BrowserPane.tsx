import type { TeachState } from "@robot/shared"
import { Eye, EyeOff, Maximize2, Minimize2 } from "lucide-solid"
import {
  type Accessor,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  Show,
} from "solid-js"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button, IconButton } from "../ui/controls.tsx"
import styles from "./agents.module.css"
import { TeachBar, useTeach } from "./Teach.tsx"

/** What covers the place of the browser when it is open. The page is hidden under these. */
const COVERS = '[role="dialog"], [role="menu"]'

/**
 * Tells the app where the browser page shows, each time the place changes. The page is a native
 * view above this screen, so the screen only keeps an empty box for it. Dialogs and menus draw
 * under the page, so the page hides while one is open. With no box, the page is hidden: it goes
 * on working for the agent.
 */
const useBrowserPlace = (
  agentId: string,
  active: Accessor<boolean>,
  box: () => HTMLElement | undefined,
) => {
  createEffect(() => {
    if (!active()) return
    let last = ""
    const send = (bounds: { x: number; y: number; width: number; height: number } | null) => {
      const key = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : "hidden"
      if (key === last) return
      last = key
      void call("browser.place", { agentId, bounds }).catch(() => {})
    }
    // The place can move without a resize of the box (panels that open, a list that is dragged),
    // so the box is measured on each frame. Nothing is sent unless the numbers changed.
    let frame = requestAnimationFrame(function measure() {
      const el = box()
      const rect = el?.getBoundingClientRect()
      const hidden =
        !rect || rect.width < 1 || rect.height < 1 || document.querySelector(COVERS) !== null
      send(
        hidden
          ? null
          : {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
      )
      frame = requestAnimationFrame(measure)
    })
    onCleanup(() => {
      cancelAnimationFrame(frame)
      void call("browser.place", { agentId, bounds: null }).catch(() => {})
    })
  })
}

/**
 * The browser of one agent, as the chat screen sees it. The page works in the background and stays
 * hidden. The user shows it when they want to look: small in the activity panel, or large over the
 * whole conversation area. The agent can ask the user to look, and the user can say no. Hiding the
 * view never closes the page, so the agent goes on. The chat is never split. Make it once for each
 * open agent chat.
 */
export interface BrowserView {
  /** The agent has a page open, or the user teaches a task in it. The view may still be hidden. */
  readonly available: Accessor<boolean>
  /** The user looks at the page, small or large. */
  readonly watching: Accessor<boolean>
  /** The user holds the page. */
  readonly control: Accessor<boolean>
  readonly teaching: Accessor<Extract<TeachState, { phase: "recording" }> | undefined>
  /** The page fills the conversation area. It does so while the user teaches a task. */
  readonly large: Accessor<boolean>
  /** Why the agent asks the user to look, or null. */
  readonly suggest: Accessor<string | null>
  /** Shows the page small, in the activity panel. */
  readonly show: () => void
  /** Shows the page large. */
  readonly enlarge: () => void
  /** Makes a large page small again. */
  readonly shrink: () => void
  /** Hides the page. It stays open for the agent. */
  readonly hide: () => void
  /** The user does not want to look now: the request of the agent goes away. */
  readonly dismissSuggest: () => void
  readonly setSmallBox: (el: HTMLElement | undefined) => void
  readonly setLargeBox: (el: HTMLElement | undefined) => void
}

export const createBrowserView = (agentId: string, linked: Accessor<boolean>): BrowserView => {
  const [state, { refetch }] = createResource(
    () => agentId,
    (id) => call("browser.state", { agentId: id }),
  )
  onCleanup(
    window.robot.on("browser.changed", (event) => {
      if (event.agentId === agentId) void refetch()
    }),
  )
  const teach = useTeach()
  const teaching = () => {
    const now = teach()
    return now.phase === "recording" && now.agentId === agentId ? now : undefined
  }
  // A linked server has no browser view in a client: the client has no control of it (spec 012).
  const available = () => !linked() && Boolean(state()?.open || teaching())
  const [watching, setWatching] = createSignal(false)
  const [enlarged, setEnlarged] = createSignal(false)
  const large = () => available() && watching() && (enlarged() || teaching() !== undefined)
  const suggest = () => (available() ? (state()?.suggest ?? null) : null)
  const dismissSuggest = () => {
    void call("browser.dismissSuggest", { agentId }).catch(() => {})
  }
  // A page that closes leaves the next page hidden again.
  createEffect(() => {
    if (!available()) {
      setWatching(false)
      setEnlarged(false)
    }
  })
  const hide = () => {
    setEnlarged(false)
    setWatching(false)
  }
  // The user teaches a task in the page, so the page must show: this is the user's own request.
  // When the teaching ends, the page hides again.
  createEffect((was: boolean) => {
    const now = teaching() !== undefined
    if (now) setWatching(true)
    else if (was) hide()
    return now
  }, false)
  // The user looks already: a request to look has nothing left to ask.
  createEffect(() => {
    if (watching() && suggest() !== null) dismissSuggest()
  })
  const [smallBox, setSmallBox] = createSignal<HTMLElement>()
  const [largeBox, setLargeBox] = createSignal<HTMLElement>()
  useBrowserPlace(agentId, available, () => (large() ? largeBox() : smallBox()))
  return {
    available,
    watching,
    control: () => state()?.control ?? false,
    teaching,
    large,
    suggest,
    show: () => setWatching(true),
    enlarge: () => {
      setWatching(true)
      setEnlarged(true)
    },
    shrink: () => setEnlarged(false),
    hide,
    dismissSuggest,
    setSmallBox,
    setLargeBox,
  }
}

/** The ref of a box: it tells the view where the box is, and forgets it when the box goes. */
const boxRef = (set: (el: HTMLElement | undefined) => void) => (el: HTMLElement) => {
  set(el)
  onCleanup(() => set(undefined))
}

/**
 * The browser in the activity panel. By default it is one quiet line: who uses the page, and a
 * button that shows it. The page itself shows only when the user asks, or says yes to a request of
 * the agent. While the user holds the page, "Give back" is here too, so the agent never waits on a
 * control that the user forgot.
 */
export const BrowserCard = (props: { agentId: string; view: BrowserView }) => {
  const { t } = useApp()
  return (
    <Show when={props.view.available() && !props.view.large()}>
      <section
        class={styles.browserCard}
        aria-label={t("browser.title")}
        data-testid="browser-card"
        data-control={props.view.control()}
        data-watching={props.view.watching()}
      >
        <div class={styles.browserCardBar}>
          <span class={styles.browserStatus}>
            {props.view.control() ? t("browser.yours") : t("browser.agents")}
          </span>
          <Show when={props.view.control()}>
            <Button
              onClick={() => call("browser.control", { agentId: props.agentId, control: false })}
              data-testid="browser-card-give-back"
            >
              {t("browser.giveBack")}
            </Button>
          </Show>
          <Show
            when={props.view.watching()}
            fallback={
              <IconButton
                label={t("browser.show")}
                onClick={props.view.show}
                data-testid="browser-show"
              >
                <Eye size={14} />
              </IconButton>
            }
          >
            <IconButton
              label={t("browser.enlarge")}
              onClick={props.view.enlarge}
              data-testid="browser-enlarge"
            >
              <Maximize2 size={14} />
            </IconButton>
            <IconButton
              label={t("browser.hide")}
              onClick={props.view.hide}
              data-testid="browser-hide"
            >
              <EyeOff size={14} />
            </IconButton>
          </Show>
        </div>
        <Show when={!props.view.watching() ? props.view.suggest() : null}>
          {(reason) => (
            <div class={styles.browserAsk} role="status" data-testid="browser-ask">
              <span class={styles.browserAskText}>
                {t("browser.asks")}
                <span class={styles.browserAskReason}>{reason()}</span>
              </span>
              <div class={styles.browserAskActions}>
                <Button variant="primary" onClick={props.view.show} data-testid="browser-ask-show">
                  {t("browser.show")}
                </Button>
                <Button onClick={props.view.dismissSuggest} data-testid="browser-ask-no">
                  {t("browser.notNow")}
                </Button>
              </div>
            </div>
          )}
        </Show>
        <Show when={props.view.watching()}>
          <div
            ref={boxRef(props.view.setSmallBox)}
            class={styles.browserThumb}
            data-testid="browser-thumb"
          />
        </Show>
      </section>
    </Show>
  )
}

/**
 * The large browser: it covers the conversation area, under the header. The bar has the state,
 * "Take control" or "Give back", the button that makes it small, and "Hide browser". Hide does not
 * close the page: the agent goes on with it. While the user teaches a task, the teaching bar takes
 * the place of this bar.
 */
export const BrowserLarge = (props: { agentId: string; view: BrowserView }) => {
  const { t } = useApp()
  return (
    <Show when={props.view.large()}>
      <section
        class={styles.browserLarge}
        aria-label={t("browser.title")}
        data-testid="browser-pane"
        data-control={props.view.control()}
      >
        <Show
          when={props.view.teaching()}
          fallback={
            <div
              class={styles.browserBar}
              data-testid="browser-bar"
              data-control={props.view.control()}
            >
              <span class={styles.browserStatus}>
                {props.view.control() ? t("browser.yours") : t("browser.agents")}
              </span>
              <Button
                onClick={() =>
                  call("browser.control", {
                    agentId: props.agentId,
                    control: !props.view.control(),
                  })
                }
                data-testid="browser-control"
              >
                {props.view.control() ? t("browser.giveBack") : t("browser.takeOver")}
              </Button>
              <IconButton
                label={t("browser.shrink")}
                onClick={props.view.shrink}
                data-testid="browser-shrink"
              >
                <Minimize2 size={14} />
              </IconButton>
              <Button onClick={props.view.hide} data-testid="browser-hide">
                {t("browser.hide")}
              </Button>
            </div>
          }
        >
          {(state) => <TeachBar state={state()} />}
        </Show>
        <div
          ref={boxRef(props.view.setLargeBox)}
          class={styles.browserView}
          data-testid="browser-view"
        />
      </section>
    </Show>
  )
}

/**
 * A button in the header that shows the page large. It shows only when the activity panel is
 * closed, because then the page has no small place and this is the way to reach it. When the agent
 * asks the user to look, the button is marked and its name tells the reason.
 */
export const BrowserHeaderButton = (props: {
  view: BrowserView
  panelVisible: Accessor<boolean>
}) => {
  const { t } = useApp()
  return (
    <Show when={props.view.available() && !props.view.large() && !props.panelVisible()}>
      <IconButton
        label={
          props.view.suggest() !== null
            ? `${t("browser.asks")} ${props.view.suggest()}`
            : t("browser.show")
        }
        onClick={props.view.enlarge}
        class={props.view.suggest() !== null ? styles.browserAsking : ""}
        data-testid="browser-open-large"
        data-asking={props.view.suggest() !== null}
      >
        <Eye size={18} />
      </IconButton>
    </Show>
  )
}
