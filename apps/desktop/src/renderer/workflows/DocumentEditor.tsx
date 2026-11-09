import { charLength, DOCUMENT_MAX, type DocumentVersion, type WorkflowDetail } from "@robot/shared"
import { createEffect, createResource, createSignal, onCleanup, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { formatDateTime } from "../lib/format.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import { Keyed } from "../ui/Keyed.tsx"
import { showToast } from "../ui/toast.ts"
import { documentSourceKey } from "./labels.ts"
import styles from "./workflows.module.css"

/** The history of the responsible document: the versions, newest first (spec 002). */
const History = (props: {
  workflow: WorkflowDetail
  versions: readonly DocumentVersion[]
  onRestored: () => void
}) => {
  const { t, locale } = useApp()
  const [open, setOpen] = createSignal<DocumentVersion>()
  const [problem, setProblem] = createSignal<ErrorText>()
  const restore = async (version: DocumentVersion) => {
    setProblem(undefined)
    try {
      await call("workflows.document.restore", { id: props.workflow.id, versionId: version.id })
      setOpen(undefined)
      showToast("success", "workflows.document.version.restored")
      props.onRestored()
    } catch (e) {
      setProblem(describeError(e))
    }
  }
  const sourceText = (v: DocumentVersion) =>
    v.device
      ? t("workflows.document.source.withDevice", {
          source: t(documentSourceKey(v.source)),
          device: t("workflows.document.source.device", { device: v.device }),
        })
      : t(documentSourceKey(v.source))
  return (
    <section class={styles.history} aria-label={t("workflows.document.history")}>
      <h3 class={styles.sectionTitle}>{t("workflows.document.history")}</h3>
      <Show
        when={props.versions.length > 0}
        fallback={
          <p class={styles.hint} data-testid="document-history-empty">
            {t("workflows.document.history.empty")}
          </p>
        }
      >
        <p class={styles.hint} data-testid="document-history-count">
          {t("workflows.document.history.count", { n: props.versions.length })}
        </p>
        <ul class={styles.versions}>
          <Keyed each={props.versions} by={(v) => v.id}>
            {(version) => (
              <li class={styles.version} data-testid="document-version">
                <span>
                  <span class={styles.versionTime}>
                    {formatDateTime(locale(), version().createdAt)}
                  </span>
                  <span class={styles.versionSource}>{sourceText(version())}</span>
                </span>
                <Button
                  onClick={() => setOpen(version())}
                  data-testid="document-version-open"
                  aria-pressed={open()?.id === version().id}
                >
                  {t("workflows.document.version.open")}
                </Button>
              </li>
            )}
          </Keyed>
        </ul>
      </Show>
      <Show when={open()}>
        {(version) => (
          <div class={styles.versionView} data-testid="document-version-view">
            <Show
              when={version().text !== ""}
              fallback={<p class={styles.hint}>{t("workflows.document.version.empty")}</p>}
            >
              <pre class={styles.document} data-testid="document-version-text">
                {version().text}
              </pre>
            </Show>
            <Show when={problem()}>
              {(p) => (
                <p class={styles.error} role="alert" data-testid="document-restore-error">
                  {t(p().key, p().params)}
                </p>
              )}
            </Show>
            <div class={styles.actions}>
              <Button onClick={() => setOpen(undefined)}>
                {t("workflows.document.version.close")}
              </Button>
              <Button
                variant="primary"
                disabled={props.workflow.running}
                onClick={() => void restore(version())}
                data-testid="document-version-restore"
              >
                {t("workflows.document.version.restore")}
              </Button>
            </div>
          </div>
        )}
      </Show>
    </section>
  )
}

/**
 * The editor of the responsible document (spec 002). It saves the text with a button; a save that
 * the app refuses (too long, looks like a secret, a run works) shows its reason and keeps the text
 * that the user typed. The document is read-only while a run works.
 */
export const DocumentEditor = (props: { workflow: WorkflowDetail }) => {
  const { t } = useApp()
  const [text, setText] = createSignal(props.workflow.document)
  const [saved, setSaved] = createSignal(props.workflow.document)
  const [problem, setProblem] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  const [versions, { refetch }] = createResource(
    () => props.workflow.id,
    (id): Promise<readonly DocumentVersion[]> =>
      call("workflows.document.history", { id }).catch(() => []),
  )
  onCleanup(window.robot.on("workflows.changed", () => void refetch()))
  const dirty = () => text() !== saved()
  // The text changed from outside (a restore, a linked device): follow it unless the user is typing.
  createEffect(() => {
    const stored = props.workflow.document
    if (stored === saved()) return
    if (!dirty()) setText(stored)
    setSaved(stored)
  })
  const size = () => charLength(text())
  const save = async () => {
    if (busy() || !dirty() || props.workflow.running) return
    setBusy(true)
    setProblem(undefined)
    try {
      const next = await call("workflows.document.save", {
        id: props.workflow.id,
        text: text(),
      })
      setSaved(next.document)
      showToast("success", "workflows.document.saved")
      void refetch()
    } catch (e) {
      setProblem(describeError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div class={styles.editor} data-testid="document-editor">
      <p class={styles.hint}>{t("workflows.document.hint")}</p>
      <Show when={props.workflow.running}>
        <p class={styles.notice} role="status" data-testid="document-readonly">
          {t("workflows.document.readonly")}
        </p>
      </Show>
      <textarea
        class={styles.textarea}
        value={text()}
        readOnly={props.workflow.running}
        aria-label={t("workflows.document.label")}
        aria-invalid={problem() ? "true" : undefined}
        data-testid="document-text"
        onInput={(e) => {
          setText(e.currentTarget.value)
          setProblem(undefined)
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault()
            void save()
          }
        }}
      />
      <div class={styles.editorBar}>
        <span
          class={styles.count}
          data-over={size() > DOCUMENT_MAX}
          data-testid="document-count"
          aria-live="polite"
        >
          {t("workflows.document.count", { n: size() })}
        </span>
        <span class={styles.headerSpacer} />
        <Button
          disabled={!dirty() || busy()}
          onClick={() => {
            setText(saved())
            setProblem(undefined)
          }}
          data-testid="document-discard"
        >
          {t("workflows.document.discard")}
        </Button>
        <Button
          variant="primary"
          disabled={!dirty() || busy() || props.workflow.running}
          onClick={() => void save()}
          data-testid="document-save"
        >
          {t("workflows.document.save")}
        </Button>
      </div>
      <Show when={text() === "" && !dirty()}>
        <p class={styles.hint} data-testid="document-empty-note">
          {t("workflows.document.emptyNote")}
        </p>
      </Show>
      <Show when={problem()}>
        {(p) => (
          <p class={styles.error} role="alert" data-testid="document-error">
            {t(p().key, p().params)}
          </p>
        )}
      </Show>
      <History
        workflow={props.workflow}
        versions={versions() ?? []}
        onRestored={() => void refetch()}
      />
    </div>
  )
}
