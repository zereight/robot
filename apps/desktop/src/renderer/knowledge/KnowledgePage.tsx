import {
  type Agent,
  charLength,
  checkMessage,
  KNOWLEDGE_BODY_MAX,
  KNOWLEDGE_SUMMARY_MAX,
  KNOWLEDGE_TITLE_MAX,
  type MessageKey,
} from "@robot/shared"
import { createResource, createSignal, For, onCleanup, Show } from "solid-js"
import { formatDateTime } from "../chat/format.ts"
import { Markdown } from "../chat/Markdown.tsx"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, Switch } from "../ui/controls.tsx"
import styles from "./knowledge.module.css"

interface Draft {
  /** The file of the article that is edited. Null for a new article. */
  file: string | null
  title: string
  summary: string
  body: string
}

const Counter = (props: { used: number; max: number }) => {
  const { t } = useApp()
  return (
    <span class={styles.muted} data-over={props.used > props.max}>
      {t("agents.counter", { used: props.used, max: props.max })}
    </span>
  )
}

/** The articles of one agent: a list with search, a reading pane, sources and the change list. */
export const KnowledgePage = (props: { agent: Agent; onClose: () => void }) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const agentId = () => props.agent.id
  const [query, setQuery] = createSignal("")
  const [selected, setSelected] = createSignal<string | null>(null)
  const [draft, setDraft] = createSignal<Draft>()
  const [error, setError] = createSignal<ErrorText>()
  const [tick, setTick] = createSignal(0)
  onCleanup(
    window.robot.on("knowledge.changed", (e) => {
      if (e.agentId === agentId()) setTick((n) => n + 1)
    }),
  )

  const [view] = createResource(
    () => ({ agentId: agentId(), query: query(), tick: tick() }),
    ({ agentId, query }) => call("knowledge.list", { agentId, query }),
  )
  const [article] = createResource(
    () => {
      const file = selected()
      return file ? { agentId: agentId(), file, tick: tick() } : undefined
    },
    ({ agentId, file }) =>
      call("knowledge.get", { agentId, file }).catch(() => {
        // The article went away: the pane clears.
        setSelected(null)
        return undefined
      }),
  )
  const [changes] = createResource(
    () => ({ agentId: agentId(), tick: tick() }),
    ({ agentId }) => call("knowledge.changes", { agentId }),
  )

  const act = async (run: () => Promise<void>) => {
    setError(undefined)
    try {
      await run()
    } catch (e) {
      setError(describeError(e))
    }
  }

  const startNew = () => {
    setError(undefined)
    setDraft({ file: null, title: "", summary: "", body: "" })
  }
  const startEdit = () => {
    const a = article()
    if (!a) return
    setError(undefined)
    setDraft({ file: a.file, title: a.title, summary: a.summary, body: a.body })
  }
  const save = () =>
    act(async () => {
      const d = draft()
      if (!d) return
      const saved = await call("knowledge.save", { agentId: agentId(), ...d })
      setDraft(undefined)
      setSelected(saved.file)
    })
  const remove = () =>
    act(async () => {
      const file = selected()
      if (!file) return
      await call("knowledge.delete", { agentId: agentId(), file })
      setSelected(null)
    })

  const check = () =>
    act(async () => {
      const found = await call("knowledge.findings", { agentId: agentId() })
      await call("chat.send", {
        agentId: agentId(),
        text: checkMessage(t, found),
        replyTo: null,
      })
      props.onClose()
      ui.selectPlace({ kind: "agent", id: agentId() })
    })

  const canCheck = () => (view()?.enabled ?? false) && (view()?.total ?? 0) > 0
  const full = () => (view()?.total ?? 0) >= (view()?.limit ?? Number.POSITIVE_INFINITY)
  const time = (at: number) => formatDateTime(app.locale(), at)

  return (
    <div class={styles.page} data-testid="knowledge-page">
      <div class={styles.top}>
        <h2 class={styles.topTitle}>{t("knowledge.title")}</h2>
        <span class={styles.switchRow}>
          <span>{t("knowledge.enabled")}</span>
          <Switch
            label={t("knowledge.enabled")}
            checked={view()?.enabled ?? props.agent.knowledgeEnabled}
            onChange={(on) =>
              act(async () => {
                await call("agents.update", { id: agentId(), patch: { knowledgeEnabled: on } })
                setTick((n) => n + 1)
              })
            }
            testId="knowledge-enabled"
          />
        </span>
        <Button
          onClick={check}
          disabled={!canCheck()}
          title={t("knowledge.check.hint")}
          data-testid="knowledge-check"
        >
          {t("knowledge.check")}
        </Button>
        <Button
          onClick={() => act(() => call("knowledge.openFolder", { agentId: agentId() }))}
          disabled={!view()?.canOpenFolder}
          data-testid="knowledge-open-folder"
        >
          {t("knowledge.folder.open")}
        </Button>
      </div>
      <span class={styles.muted}>{t("knowledge.hint")}</span>
      <Show when={view() && !view()?.enabled}>
        <span class={styles.muted} data-testid="knowledge-off">
          {t("knowledge.off")}
        </span>
      </Show>
      <Show when={error()}>
        {(err) => (
          <div class={styles.error} role="alert" data-testid="knowledge-error">
            {t(err().key, err().params)}
          </div>
        )}
      </Show>

      <div class={styles.panes}>
        <div class={styles.side}>
          <input
            class={styles.search}
            value={query()}
            placeholder={t("knowledge.search")}
            aria-label={t("knowledge.search")}
            onInput={(e) => setQuery(e.currentTarget.value)}
            data-testid="knowledge-search"
          />
          <div class={styles.sideActions}>
            <Button onClick={startNew} disabled={full()} data-testid="knowledge-add">
              {t("knowledge.add")}
            </Button>
            <span class={styles.muted} data-testid="knowledge-count">
              {t("knowledge.count", { count: view()?.total ?? 0, max: view()?.limit ?? 0 })}
            </span>
          </div>
          <Show when={full()}>
            <span class={styles.muted} data-testid="knowledge-full">
              {t("knowledge.full", { max: view()?.limit ?? 0 })}
            </span>
          </Show>
          <Show when={(view()?.skipped ?? 0) > 0}>
            <span class={styles.muted} data-testid="knowledge-skipped">
              {t("knowledge.skipped", { count: view()?.skipped ?? 0 })}
            </span>
          </Show>
          <Show
            when={(view()?.articles.length ?? 0) > 0}
            fallback={
              <Show
                when={(view()?.total ?? 0) === 0}
                fallback={
                  <span class={styles.muted} data-testid="knowledge-no-match">
                    {t("knowledge.noMatch")}
                  </span>
                }
              >
                <div data-testid="knowledge-empty">
                  <div>{t("knowledge.empty")}</div>
                  <span class={styles.muted}>{t("knowledge.empty.hint")}</span>
                </div>
              </Show>
            }
          >
            <ul class={styles.list} data-testid="knowledge-list">
              <For each={view()?.articles ?? []}>
                {(item) => (
                  <li>
                    <button
                      type="button"
                      class={styles.item}
                      aria-current={selected() === item.file}
                      data-testid="knowledge-item"
                      data-file={item.file}
                      onClick={() => {
                        setDraft(undefined)
                        setSelected(item.file)
                      }}
                    >
                      <span class={styles.itemTitle}>{item.title}</span>
                      <span class={styles.itemSummary}>{item.summary}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <details class={styles.fold} data-testid="knowledge-sources-fold">
            <summary>{t("knowledge.sources.all")}</summary>
            <div class={styles.foldBody}>
              <Show
                when={(view()?.sources.length ?? 0) > 0}
                fallback={<span class={styles.muted}>{t("knowledge.sources.empty")}</span>}
              >
                <For each={view()?.sources ?? []}>
                  {(source) => (
                    <div class={styles.sourceRow} data-testid="knowledge-source-item">
                      <span class={styles.sourceName}>{source.name}</span>
                      <Button
                        onClick={() =>
                          act(() =>
                            call("knowledge.openSource", { agentId: agentId(), name: source.name }),
                          )
                        }
                        data-testid="knowledge-source-open"
                      >
                        {t("knowledge.source.open")}
                      </Button>
                      <Button
                        onClick={() =>
                          act(() =>
                            call("knowledge.deleteSource", {
                              agentId: agentId(),
                              name: source.name,
                            }),
                          )
                        }
                        data-testid="knowledge-source-delete"
                      >
                        {t("knowledge.source.delete")}
                      </Button>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </details>
          <details class={styles.fold} data-testid="knowledge-changes-fold">
            <summary>{t("knowledge.changes")}</summary>
            <div class={styles.foldBody}>
              <Show
                when={(changes()?.length ?? 0) > 0}
                fallback={<span class={styles.muted}>{t("knowledge.changes.empty")}</span>}
              >
                <For each={changes() ?? []}>
                  {(change) => (
                    <div
                      class={styles.change}
                      data-testid="knowledge-change"
                      data-undone={change.undone}
                    >
                      <span>
                        {t(`knowledge.change.${change.kind}` as MessageKey)}: {change.title}
                      </span>
                      <span class={styles.muted}>
                        {t(`knowledge.change.by.${change.actor}` as MessageKey)} · {time(change.at)}
                      </span>
                      <div class={styles.row}>
                        <Show
                          when={!change.undone}
                          fallback={
                            <span class={styles.muted}>{t("knowledge.change.undone")}</span>
                          }
                        >
                          <Button
                            onClick={() =>
                              act(() =>
                                call("knowledge.undo", { agentId: agentId(), changeId: change.id }),
                              )
                            }
                            data-testid="knowledge-change-undo"
                          >
                            {t("knowledge.change.undo")}
                          </Button>
                        </Show>
                      </div>
                      <Show when={change.before !== null}>
                        <details>
                          <summary class={styles.muted}>{t("knowledge.change.earlier")}</summary>
                          <pre>{change.before}</pre>
                        </details>
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </details>
        </div>

        <div class={styles.main}>
          <Show
            when={draft()}
            fallback={
              <Show
                when={article()}
                fallback={<span class={styles.muted}>{t("knowledge.pick")}</span>}
              >
                {(a) => (
                  <div data-testid="knowledge-article" data-file={a().file}>
                    <div class={styles.articleHead}>
                      <h3 class={styles.articleTitle} data-testid="knowledge-article-title">
                        {a().title}
                      </h3>
                      <Button onClick={startEdit} data-testid="knowledge-edit">
                        {t("knowledge.edit")}
                      </Button>
                      <Button onClick={remove} data-testid="knowledge-delete">
                        {t("knowledge.delete")}
                      </Button>
                    </div>
                    <p class={styles.summary}>{a().summary}</p>
                    <span class={styles.muted} data-testid="knowledge-updated">
                      {t("knowledge.updated", { time: time(a().updatedAt) })} ·{" "}
                      {t(`knowledge.editor.${a().editor}` as MessageKey)}
                    </span>
                    <Markdown text={a().body} />
                    <div class={styles.section}>
                      <span class={styles.sectionTitle}>{t("knowledge.links")}</span>
                      <Show
                        when={a().links.length > 0}
                        fallback={<span class={styles.muted}>{t("knowledge.links.none")}</span>}
                      >
                        <ul class={styles.chips}>
                          <For each={a().links}>
                            {(link) => (
                              <li>
                                <Show
                                  when={link.file}
                                  fallback={
                                    <span
                                      class={styles.link}
                                      data-missing="true"
                                      title={t("knowledge.links.missing")}
                                      data-testid="knowledge-link"
                                    >
                                      {link.title} · {t("knowledge.links.missing")}
                                    </span>
                                  }
                                >
                                  {(file) => (
                                    <button
                                      type="button"
                                      class={styles.link}
                                      data-missing="false"
                                      data-testid="knowledge-link"
                                      onClick={() => setSelected(file())}
                                    >
                                      {link.title}
                                    </button>
                                  )}
                                </Show>
                              </li>
                            )}
                          </For>
                        </ul>
                      </Show>
                    </div>
                    <div class={styles.section}>
                      <span class={styles.sectionTitle}>{t("knowledge.sources")}</span>
                      <Show
                        when={a().sources.length > 0}
                        fallback={<span class={styles.muted}>{t("knowledge.sources.none")}</span>}
                      >
                        <For each={a().sources}>
                          {(source) => (
                            <div class={styles.sourceRow} data-testid="knowledge-source">
                              <span class={styles.sourceName} data-missing={!source.exists}>
                                {source.name}
                                <Show when={!source.exists}>
                                  {" "}
                                  ({t("knowledge.source.deleted")})
                                </Show>
                              </span>
                              <Show when={source.exists}>
                                <Button
                                  onClick={() =>
                                    act(() =>
                                      call("knowledge.openSource", {
                                        agentId: agentId(),
                                        name: source.name,
                                      }),
                                    )
                                  }
                                >
                                  {t("knowledge.source.open")}
                                </Button>
                              </Show>
                            </div>
                          )}
                        </For>
                      </Show>
                    </div>
                  </div>
                )}
              </Show>
            }
          >
            {(d) => (
              <form
                class={styles.editor}
                data-testid="knowledge-editor"
                onSubmit={(e) => {
                  e.preventDefault()
                  void save()
                }}
              >
                <label class={styles.editor}>
                  <span class={styles.row}>
                    {t("knowledge.field.title")}
                    <Counter used={charLength(d().title.trim())} max={KNOWLEDGE_TITLE_MAX} />
                  </span>
                  <input
                    class={styles.search}
                    value={d().title}
                    onInput={(e) => setDraft({ ...d(), title: e.currentTarget.value })}
                    data-testid="knowledge-title-input"
                  />
                </label>
                <label class={styles.editor}>
                  <span class={styles.row}>
                    {t("knowledge.field.summary")}
                    <Counter used={charLength(d().summary)} max={KNOWLEDGE_SUMMARY_MAX} />
                  </span>
                  <input
                    class={styles.search}
                    value={d().summary}
                    onInput={(e) => setDraft({ ...d(), summary: e.currentTarget.value })}
                    data-testid="knowledge-summary-input"
                  />
                </label>
                <label class={styles.editor}>
                  <span class={styles.row}>
                    {t("knowledge.field.body")}
                    <Counter used={charLength(d().body)} max={KNOWLEDGE_BODY_MAX} />
                  </span>
                  <textarea
                    class={`${styles.search} ${styles.editorBody}`}
                    value={d().body}
                    onInput={(e) => setDraft({ ...d(), body: e.currentTarget.value })}
                    data-testid="knowledge-body-input"
                  />
                </label>
                <div class={styles.row}>
                  <Button variant="primary" type="submit" data-testid="knowledge-save">
                    {t("knowledge.save")}
                  </Button>
                  <Button onClick={() => setDraft(undefined)} data-testid="knowledge-cancel">
                    {t("knowledge.cancel")}
                  </Button>
                </div>
              </form>
            )}
          </Show>
        </div>
      </div>
    </div>
  )
}
