import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js"
import { guardNativePage } from "../lib/nativePageGuard.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./browser.module.css"

/** What covers the place of the page when it is open. The page hides under these. */
const COVERS = '[role="dialog"], [role="menu"]'

/**
 * The browser page of a workflow, as the chat sees it (spec 007, flow 4). The page works in the
 * background and stays hidden. The strip says that it is open, and "Show browser" lets the user
 * look at it. While the user holds it (a take-control card waits), the page shows at once, larger,
 * and takes the keys and clicks of the user. The page is a native view above this screen, so the
 * strip only keeps an empty box for it and tells the app where the box is.
 */
export const BrowserStrip = (props: { workflowId: string }) => {
  const { t } = useApp()
  const [state, { refetch }] = createResource(
    () => props.workflowId,
    (workflowId) => call("browser.state", { workflowId }),
  )
  onCleanup(
    window.robot.on("browser.changed", (event) => {
      if (event.workflowId === props.workflowId) void refetch()
    }),
  )
  const [looking, setLooking] = createSignal(false)
  const present = () => Boolean(state()?.open || state()?.unloaded)
  const held = () => state()?.held === true
  const shown = () => (looking() || held()) && state()?.open === true
  let box: HTMLDivElement | undefined

  createEffect(() => {
    if (!shown()) return
    let last = ""
    const send = (bounds: { x: number; y: number; width: number; height: number } | null) => {
      const key = bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : "hidden"
      if (key === last) return
      last = key
      void call("browser.place", { workflowId: props.workflowId, bounds }).catch(() => {})
    }
    // The place can move without a resize of the box, so the box is measured on each frame.
    // Nothing is sent unless the numbers changed.
    let frame = requestAnimationFrame(function measure() {
      const rect = box?.getBoundingClientRect()
      const hidden =
        !rect || rect.width < 1 || rect.height < 1 || document.querySelector(COVERS) !== null
      const place = hidden
        ? null
        : {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          }
      send(place)
      guardNativePage(`workflow-${props.workflowId}`, place)
      frame = requestAnimationFrame(measure)
    })
    onCleanup(() => {
      cancelAnimationFrame(frame)
      guardNativePage(`workflow-${props.workflowId}`, null)
      void call("browser.place", { workflowId: props.workflowId, bounds: null }).catch(() => {})
    })
  })

  return (
    <Show when={present()}>
      <section class={styles.strip} aria-label={t("browser.title")} data-testid="browser-strip">
        <div class={styles.line}>
          <span class={styles.name}>{t("browser.title")}</span>
          <Show when={state()?.unloaded}>
            <span class={styles.muted} data-testid="browser-unloaded">
              {t("browser.unloaded")}
            </span>
          </Show>
          <Show when={held()}>
            <span class={styles.mark} data-testid="browser-held">
              {t("browser.held")}
            </span>
          </Show>
          <Show when={state()?.open && !held()}>
            <Button onClick={() => setLooking(!looking())} data-testid="browser-toggle">
              {looking() ? t("browser.hide") : t("browser.show")}
            </Button>
          </Show>
        </div>
        <Show when={shown()}>
          <div
            ref={box}
            class={held() ? styles.boxHeld : styles.box}
            data-testid="browser-box"
            role="img"
            aria-label={t("browser.page")}
          />
        </Show>
      </section>
    </Show>
  )
}
