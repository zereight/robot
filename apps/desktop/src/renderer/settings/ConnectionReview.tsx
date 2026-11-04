import { changeOf, type HeldToolView, type MessageKey, type ReviewedParam } from "@robot/shared"
import { createResource, createSignal, For, type JSX, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import styles from "./connections.module.css"

/**
 * The dialog "Review" (spec 018, "Flows", "Tool review"): the tools of a connection that are new or
 * changed. A changed tool shows the old and the new text of what changed. Each tool has "Accept";
 * the dialog also has "Accept all" and "Close". "Close" keeps the tools held. A tool is accepted
 * with the text that is on the screen: a tool that the connection changed since stays held.
 */
export const ConnectionReviewDialog = (props: {
  connection: { readonly id: string; readonly name: string }
  onClose: () => void
}) => {
  const { t } = useApp()
  const id = props.connection.id
  const [held, { refetch }] = createResource(() => call("connections.held", { id }))
  onCleanup(window.robot.on("connections.changed", () => void refetch()))
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<ErrorText>()

  const list = (): readonly HeldToolView[] => held.latest ?? []

  const accept = async (tools: readonly HeldToolView[]) => {
    if (busy() || tools.length === 0) return
    setBusy(true)
    setError(undefined)
    try {
      await call("connections.accept", {
        id,
        tools: tools.map((tool) => ({ name: tool.name, key: tool.key })),
      })
      const next = await refetch()
      // Nothing waits any more: the row has lost its line, and the dialog has done its work.
      if (next && next.length === 0) props.onClose()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const text = (value: string, empty: MessageKey) =>
    value === "" ? (
      <span class={styles.diffEmpty}>{t(empty)}</span>
    ) : (
      <span class={styles.diffText}>{value}</span>
    )

  const params = (value: readonly ReviewedParam[]) =>
    value.length === 0 ? (
      <span class={styles.diffEmpty}>{t("connections.review.noParams")}</span>
    ) : (
      <ul class={styles.diffParams}>
        <For each={value}>
          {(param) => (
            <li>
              <code class={styles.toolName}>{param.name}</code>
              <Show when={param.description !== ""}>
                <span class={styles.diffText}>{param.description}</span>
              </Show>
            </li>
          )}
        </For>
      </ul>
    )

  const mark = (on: boolean) => t(on ? "connections.review.mark.on" : "connections.review.mark.off")

  /**
   * One part of a tool. A changed tool shows the old and the new text of a part that changed, and
   * "Not changed" for the rest. A new tool has no old text: it shows the new text, plain.
   */
  const part = (
    label: MessageKey,
    testId: string,
    changed: boolean,
    was: (() => JSX.Element) | undefined,
    now: () => JSX.Element,
  ) => (
    <div class={styles.diffPart} data-testid={`held-${testId}`} data-changed={changed}>
      <span class={styles.diffLabel}>{t(label)}</span>
      <Show
        when={was}
        fallback={
          <div class={styles.diffPlain} data-testid={`held-${testId}-now`}>
            {now()}
          </div>
        }
      >
        {(old) => (
          <Show
            when={changed}
            fallback={<span class={styles.diffEmpty}>{t("connections.review.same")}</span>}
          >
            <div class={styles.diffSides}>
              <div class={styles.diffSide} data-side="was" data-testid={`held-${testId}-was`}>
                <span class={styles.diffSideLabel}>{t("connections.review.was")}</span>
                {old()()}
              </div>
              <div class={styles.diffSide} data-side="now" data-testid={`held-${testId}-now`}>
                <span class={styles.diffSideLabel}>{t("connections.review.now")}</span>
                {now()}
              </div>
            </div>
          </Show>
        )}
      </Show>
    </div>
  )

  const item = (tool: HeldToolView) => {
    const change = tool.was ? changeOf(tool.was, tool.now) : undefined
    const was = tool.was
    return (
      <li class={styles.heldItem} data-testid="held-tool" data-tool={tool.name} data-tag={tool.tag}>
        <div class={styles.heldHead}>
          <span class={styles.toolName}>{tool.name}</span>
          <span class={styles.tag} data-tag={tool.tag} data-testid="held-tag">
            {t(`connections.review.tag.${tool.tag}` as MessageKey)}
          </span>
          <Button
            class={styles.heldAccept}
            disabled={busy()}
            aria-label={t("connections.review.accept.tool", { tool: tool.name })}
            onClick={() => void accept([tool])}
            data-testid="held-accept"
          >
            {t("connections.review.accept")}
          </Button>
        </div>
        {part(
          "connections.review.description",
          "description",
          change?.description ?? true,
          was ? () => text(was.description, "connections.review.noDescription") : undefined,
          () => text(tool.now.description, "connections.review.noDescription"),
        )}
        {part(
          "connections.review.params",
          "params",
          change?.params ?? true,
          was ? () => params(was.params) : undefined,
          () => params(tool.now.params),
        )}
        {/* A new tool shows its mark when it has one. A changed tool shows it only when it changed. */}
        <Show when={was ? change?.readOnly : tool.now.readOnly}>
          {part(
            "connections.review.mark",
            "mark",
            true,
            was ? () => <span class={styles.diffText}>{mark(was.readOnly)}</span> : undefined,
            () => (
              <span class={styles.diffText}>{mark(tool.now.readOnly)}</span>
            ),
          )}
        </Show>
      </li>
    )
  }

  return (
    <Dialog
      label={t("connections.review.title", { name: props.connection.name })}
      onClose={props.onClose}
      testId="connection-review-dialog"
      wide
    >
      <div class={styles.reviewBox} data-testid="connection-review">
        <h2 class={styles.label}>
          {t("connections.review.title", { name: props.connection.name })}
        </h2>
        <p class={styles.hint}>{t("connections.review.intro")}</p>
        <Show when={error()}>
          {(err) => (
            <p class={styles.fieldError} role="alert" data-testid="connection-review-error">
              {t(err().key, err().params)}
            </p>
          )}
        </Show>
        <Show
          when={list().length > 0}
          fallback={
            <p class={styles.meta} data-testid="connection-review-none">
              {held.loading ? "" : t("connections.review.none")}
            </p>
          }
        >
          <ul class={styles.heldList} data-testid="held-list">
            <For each={list()}>{item}</For>
          </ul>
        </Show>
        <div class={styles.reviewActions}>
          <Button onClick={props.onClose} data-testid="connection-review-close">
            {t("connections.review.close")}
          </Button>
          <Button
            variant="primary"
            disabled={busy() || list().length === 0}
            onClick={() => void accept(list())}
            data-testid="connection-review-accept-all"
          >
            {t("connections.review.acceptAll")}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
