import type { TeachState } from "@robot/shared"
import { Maximize2, Minimize2 } from "lucide-solid"
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
 * The browser of one agent, as the chat screen sees it. The page shows in one of two places: a
 * small box in the activity panel, or the whole conversation area when the user enlarges it. The
 * chat is never split. Make it once for each open agent chat.
 */
export interface BrowserView {
  /** The agent has a page open, or the user teaches a task in it. */
  readonly shown: Accessor<boolean>
  /** The user holds the page. */
  readonly control: Accessor<boolean>
  readonly teaching: Accessor<Extract<TeachState, { phase: "recording" }> | undefined>
  /** The page fills the conversation area. It does so while the user teaches a task. */
  readonly large: Accessor<boolean>
  readonly setEnlarged: (on: boolean) => void
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
  const shown = () => !linked() && Boolean(state()?.open || teaching())
  const [enlarged, setEnlarged] = createSignal(false)
  const large = () => shown() && (enlarged() || teaching() !== undefined)
  // A page that closes leaves the next page small again.
  createEffect(() => {
    if (!shown()) setEnlarged(false)
  })
  const [smallBox, setSmallBox] = createSignal<HTMLElement>()
  const [largeBox, setLargeBox] = createSignal<HTMLElement>()
  useBrowserPlace(agentId, shown, () => (large() ? largeBox() : smallBox()))
  return {
    shown,
    control: () => state()?.control ?? false,
    teaching,
    large,
    setEnlarged,
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
 * The small browser in the activity panel: a live view of the page, its state, and a button that
 * makes it large. While the user holds the page, "Give back" is here too, so the agent never waits
 * on a control that the user forgot.
 */
export const BrowserCard = (props: { agentId: string; view: BrowserView }) => {
  const { t } = useApp()
  return (
    <Show when={props.view.shown() && !props.view.large()}>
      <section
        class={styles.browserCard}
        aria-label={t("browser.title")}
        data-testid="browser-card"
        data-control={props.view.control()}
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
          <IconButton
            label={t("browser.enlarge")}
            onClick={() => props.view.setEnlarged(true)}
            data-testid="browser-enlarge"
          >
            <Maximize2 size={14} />
          </IconButton>
        </div>
        <div
          ref={boxRef(props.view.setSmallBox)}
          class={styles.browserThumb}
          data-testid="browser-thumb"
        />
      </section>
    </Show>
  )
}

/**
 * The large browser: it covers the conversation area, under the header. The bar has the state,
 * "Take control" or "Give back", the button that makes it small, and "Close browser". While the
 * user teaches a task, the teaching bar takes the place of this bar.
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
                onClick={() => props.view.setEnlarged(false)}
                data-testid="browser-shrink"
              >
                <Minimize2 size={14} />
              </IconButton>
              <Button
                onClick={() => call("browser.close", { agentId: props.agentId })}
                data-testid="browser-close"
              >
                {t("browser.close")}
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
 * A button in the header that makes the page large. It shows only when the activity panel is
 * closed, because then the page has no small place and this is the way to reach it.
 */
export const BrowserHeaderButton = (props: {
  view: BrowserView
  panelVisible: Accessor<boolean>
}) => {
  const { t } = useApp()
  return (
    <Show when={props.view.shown() && !props.view.large() && !props.panelVisible()}>
      <IconButton
        label={t("browser.enlarge")}
        onClick={() => props.view.setEnlarged(true)}
        data-testid="browser-open-large"
      >
        <Maximize2 size={18} />
      </IconButton>
    </Show>
  )
}
