import { createEffect, createResource, onCleanup, Show } from "solid-js"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./agents.module.css"

/** What covers the place of the browser when it is open. The page is hidden under these. */
const COVERS = '[role="dialog"], [role="menu"]'

/**
 * Tells the app where the browser page shows, each time the place changes. The page is a native
 * view above this screen, so the screen only keeps an empty box for it. Dialogs and menus draw
 * under the page, so the page hides while one is open.
 */
const useBrowserPlace = (agentId: () => string, box: () => HTMLElement | undefined) => {
  createEffect(() => {
    const id = agentId()
    let last = ""
    const send = (bounds: { x: number; y: number; width: number; height: number } | null) => {
      const key = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : "hidden"
      if (key === last) return
      last = key
      void call("browser.place", { agentId: id, bounds }).catch(() => {})
    }
    // The place can move without a resize of the box (panels that open, a list that is dragged),
    // so the box is measured on each frame. Nothing is sent unless the numbers changed.
    let frame = requestAnimationFrame(function measure() {
      const el = box()
      if (el) {
        const rect = el.getBoundingClientRect()
        const hidden = rect.width < 1 || rect.height < 1 || document.querySelector(COVERS) !== null
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
      }
      frame = requestAnimationFrame(measure)
    })
    onCleanup(() => {
      cancelAnimationFrame(frame)
      void call("browser.place", { agentId: id, bounds: null }).catch(() => {})
    })
  })
}

const Pane = (props: { agentId: string; control: boolean }) => {
  const { t } = useApp()
  let box: HTMLDivElement | undefined
  useBrowserPlace(
    () => props.agentId,
    () => box,
  )
  return (
    <section
      class={styles.browserPane}
      aria-label={t("browser.title")}
      data-testid="browser-pane"
      data-control={props.control}
    >
      <div class={styles.browserBar} data-testid="browser-bar" data-control={props.control}>
        <span class={styles.browserStatus}>
          {props.control ? t("browser.yours") : t("browser.agents")}
        </span>
        <Button
          onClick={() =>
            call("browser.control", { agentId: props.agentId, control: !props.control })
          }
          data-testid="browser-control"
        >
          {props.control ? t("browser.giveBack") : t("browser.takeOver")}
        </Button>
        <Button
          onClick={() => call("browser.close", { agentId: props.agentId })}
          data-testid="browser-close"
        >
          {t("browser.close")}
        </Button>
      </div>
      <div ref={box} class={styles.browserView} data-testid="browser-view" />
    </section>
  )
}

/**
 * The browser of an agent, in the same window as the chat. It shows while the agent has a page
 * open. The user can take the controls, give them back, or close it.
 */
export const BrowserPane = (props: { agentId: string }) => {
  const [state, { refetch }] = createResource(
    () => props.agentId,
    (agentId) => call("browser.state", { agentId }),
  )
  onCleanup(
    window.robot.on("browser.changed", ({ agentId }) => {
      if (agentId === props.agentId) void refetch()
    }),
  )
  return (
    <Show when={state()?.open}>
      <Pane agentId={props.agentId} control={state()?.control ?? false} />
    </Show>
  )
}
