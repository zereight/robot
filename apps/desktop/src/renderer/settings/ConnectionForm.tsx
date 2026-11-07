import {
  CONNECTION_NAME_MAX,
  CONNECTIONS_MAX,
  type ConnectionEntryInput,
  type ConnectionFailure,
  type ConnectionFormProblem,
  type ConnectionScope,
  type ConnectionTestResult,
  charLength,
  checkConnection,
  checkConnectionAddress,
  checkConnectionName,
  commandLine,
  type MessageKey,
  type ToolConnection,
  type ToolConnectionInput,
  type ToolConnectionKind,
} from "@robot/shared"
import { X } from "lucide-solid"
import { createEffect, createSignal, For, Index, on, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { call, RpcFailure } from "../lib/rpc.ts"
import { useApp } from "../state/app.tsx"
import { Button, IconButton, Segmented, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { useWorkflowList } from "../workflows/names.ts"
import styles from "./connections.module.css"

/** The parts of the form that can show a problem under them. */
const FIELDS = [
  "name",
  "command",
  "arguments",
  "folder",
  "env",
  "address",
  "headers",
  "confirm",
] as const
type Field = (typeof FIELDS)[number]

/** The part of the form that a problem of the form check is about. */
const fieldOf = (problem: ConnectionFormProblem): Field => {
  if (problem.startsWith("name")) return "name"
  if (problem.startsWith("command")) return "command"
  if (problem.startsWith("address")) return "address"
  if (problem.startsWith("env")) return "env"
  if (problem.startsWith("header")) return "headers"
  return problem as Field
}

/** One line of the list of environment values or of headers, as the form holds it. */
interface Entry {
  readonly key: number
  name: string
  value: string
  secret: boolean
  /** A value of this secret is in the keychain already. The page never gets the value. */
  saved: boolean
}

let entryCount = 0
const blankEntry = (): Entry => ({
  key: ++entryCount,
  name: "",
  value: "",
  secret: false,
  saved: false,
})

export const ConnectionFormDialog = (props: {
  /** The connection to change, or none for a new one. */
  connection?: ToolConnection | undefined
  /** The names of the other connections, for the check of the name. */
  others: readonly string[]
  /** How many connections the server holds now. */
  count: number
  onClose: () => void
}) => {
  const { t } = useApp()
  const was = props.connection
  const fromView = (list: ToolConnection["env"]): Entry[] =>
    list.map((e) => ({
      key: ++entryCount,
      name: e.name,
      value: e.value ?? "",
      secret: e.secret,
      saved: e.secret && e.saved,
    }))

  const [name, setName] = createSignal(was?.name ?? "")
  const [kind, setKind] = createSignal<ToolConnectionKind>(was?.kind ?? "program")
  const [command, setCommand] = createSignal(was?.command ?? "")
  const [argsText, setArgsText] = createSignal((was?.args ?? []).join("\n"))
  const [folder, setFolder] = createSignal(was?.folder ?? "")
  const [env, setEnv] = createSignal<Entry[]>(fromView(was?.env ?? []))
  const [address, setAddress] = createSignal(was?.address ?? "")
  const [headers, setHeaders] = createSignal<Entry[]>(fromView(was?.headers ?? []))
  const [confirmed, setConfirmed] = createSignal(false)
  // The workflows that may use the connection (spec 018): all of them, or a list. A new connection
  // is for all workflows.
  const workflows = useWorkflowList()
  const [scopeKind, setScopeKind] = createSignal<ConnectionScope["kind"]>(was?.scope.kind ?? "all")
  const [chosen, setChosen] = createSignal<ReadonlySet<string>>(
    new Set(was?.scope.kind === "workflows" ? was.scope.workflowIds : []),
  )
  const toggleWorkflow = (id: string, on: boolean) => {
    const next = new Set(chosen())
    if (on) next.add(id)
    else next.delete(id)
    setChosen(next)
  }
  const scope = (): ConnectionScope =>
    scopeKind() === "all"
      ? { kind: "all" }
      : {
          kind: "workflows",
          // The service keeps only the workflows that exist, so a workflow that is gone leaves
          // the list when the user saves.
          workflowIds: [...chosen()],
        }
  const [touched, setTouched] = createSignal<ReadonlySet<Field>>(new Set())
  const [problem, setProblem] = createSignal<{ field: Field | null; text: ErrorText }>()
  const [busy, setBusy] = createSignal(false)
  const [testing, setTesting] = createSignal(false)
  const [result, setResult] = createSignal<ConnectionTestResult>()

  const touch = (field: Field) => setTouched(new Set([...touched(), field]))
  const argList = () =>
    argsText()
      .split("\n")
      .filter((line) => line !== "")

  /** The lines of a list as the service takes them. A line with no name and no value is left out. */
  const entriesOf = (list: readonly Entry[]): ConnectionEntryInput[] =>
    list
      .filter((e) => e.name.trim() !== "" || e.value !== "")
      .map((e) => ({
        name: e.name.trim(),
        secret: e.secret,
        // A secret with no new text keeps the saved value.
        ...(e.value !== "" || !e.secret ? { value: e.value } : {}),
      }))

  const input = (): ToolConnectionInput => ({
    name: name().trim(),
    kind: kind(),
    command: command(),
    args: argList(),
    folder: folder(),
    env: kind() === "program" ? entriesOf(env()) : [],
    address: address(),
    headers: kind() === "web" ? entriesOf(headers()) : [],
  })

  // A Test shows the form as it was. A change makes it old, so it goes.
  createEffect(
    on(
      () => JSON.stringify(input()),
      () => {
        setResult(undefined)
        // A reason that Save gave is about the form as it was: a change takes it away.
        setProblem(undefined)
      },
      { defer: true },
    ),
  )

  const text = (key: string): ErrorText => ({ key: `error.${key}` as MessageKey })

  /** What the form says about a field while the user types: the name and the address. */
  const live = (field: Field): ErrorText | undefined => {
    if (!touched().has(field)) return undefined
    if (field === "name") {
      const found = checkConnectionName(name(), props.others)
      return found ? text(`connection_name_${found}`) : undefined
    }
    if (field === "address" && kind() === "web" && address().trim() !== "") {
      const found = checkConnectionAddress(address())
      return found ? text(`connection_address_${found}`) : undefined
    }
    return undefined
  }
  const shown = (field: Field): ErrorText | undefined => {
    const p = problem()
    return p?.field === field ? p.text : live(field)
  }
  const under = (field: Field) => (
    <Show when={shown(field)}>
      {(error) => (
        <span class={styles.fieldError} role="alert" data-testid={`connection-error-${field}`}>
          {t(error().key, error().params)}
        </span>
      )}
    </Show>
  )

  /** The first problem the page can see before it asks the service. */
  const check = (): { field: Field | null; text: ErrorText } | undefined => {
    const found = checkConnection(input(), props.others)
    if (found) return { field: fieldOf(found), text: text(`connection_${found}`) }
    const lines = kind() === "program" ? env() : headers()
    if (lines.some((e) => e.secret && e.value === "" && !e.saved && e.name.trim() !== ""))
      return {
        field: kind() === "program" ? "env" : "headers",
        text: text(
          kind() === "program" ? "connection_env_value_missing" : "connection_header_value_missing",
        ),
      }
    return undefined
  }

  const fail = (e: unknown) => {
    const detail = e instanceof RpcFailure ? e.error.message : ""
    const field = (FIELDS as readonly string[]).includes(detail) ? (detail as Field) : null
    return { field, text: describeError(e) }
  }

  const save = async (event?: SubmitEvent) => {
    event?.preventDefault()
    if (busy()) return
    setProblem(undefined)
    setTouched(new Set(FIELDS))
    const found = check()
    if (found) return setProblem(found)
    if (kind() === "program" && !confirmed())
      return setProblem({ field: "confirm", text: text("connection_confirm") })
    // The 21st connection is refused (spec 018, "Rules").
    if (!was && props.count >= CONNECTIONS_MAX)
      return setProblem({ field: null, text: text("connections_full") })
    setBusy(true)
    try {
      await call("connections.save", {
        ...(was ? { id: was.id } : {}),
        connection: input(),
        confirmed: confirmed(),
        scope: scope(),
      })
      props.onClose()
    } catch (e) {
      setProblem(fail(e))
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    if (testing()) return
    setTesting(true)
    setResult(undefined)
    setProblem(undefined)
    setTouched(new Set(FIELDS))
    try {
      const found = check()
      if (found) return setProblem(found)
      // The result belongs to the form as it is when the Test starts.
      const answer = await call("connections.test", {
        ...(was ? { id: was.id } : {}),
        connection: input(),
      })
      setResult(answer)
    } catch (e) {
      setProblem(fail(e))
    } finally {
      setTesting(false)
    }
  }

  const reason = (failure: ConnectionFailure) => t(`connections.failure.${failure}` as MessageKey)

  /** The lines of environment values or of headers. */
  const lines = (
    label: MessageKey,
    add: MessageKey,
    list: () => Entry[],
    set: (next: Entry[]) => void,
    field: Field,
    id: string,
  ) => (
    <div class={styles.field} data-testid={`connection-${id}`}>
      <span class={styles.label}>{t(label)}</span>
      {/* Index keeps the box of a line while the user types in it: a keystroke makes a new object for the line, and For would draw the box again and drop the focus. */}
      <Index each={list()}>
        {(line) => {
          const change = (patch: Partial<Entry>) =>
            set(list().map((e) => (e.key === line().key ? { ...e, ...patch } : e)))
          return (
            <div
              class={styles.entryBox}
              data-testid={`connection-${id}-line`}
              data-saved={line().saved}
            >
              <div class={styles.entry}>
                <input
                  class={`${styles.input} ${styles.entryName}`}
                  value={line().name}
                  placeholder={t("connections.form.entry.name")}
                  aria-label={t("connections.form.entry.name")}
                  aria-invalid={problem()?.field === field}
                  spellcheck={false}
                  autocomplete="off"
                  onInput={(e) => change({ name: e.currentTarget.value })}
                  data-testid={`connection-${id}-name`}
                />
                <input
                  class={`${styles.input} ${styles.entryValue}`}
                  type={line().secret ? "password" : "text"}
                  value={line().value}
                  placeholder={
                    line().saved && line().value === ""
                      ? t("connections.form.entry.savedTag")
                      : t("connections.form.entry.value")
                  }
                  aria-label={t("connections.form.entry.value")}
                  aria-invalid={problem()?.field === field}
                  spellcheck={false}
                  autocomplete="off"
                  onInput={(e) => change({ value: e.currentTarget.value })}
                  data-testid={`connection-${id}-value`}
                />
                <span class={styles.secretSwitch}>
                  <Switch
                    label={`${t("connections.form.entry.secret")}: ${line().name}`}
                    checked={line().secret}
                    // A secret that is turned off has no saved value any more.
                    onChange={(secret) =>
                      change({
                        secret,
                        saved: secret ? line().saved : false,
                        value: secret ? line().value : "",
                      })
                    }
                    testId={`connection-${id}-secret`}
                  />
                  {t("connections.form.entry.secret")}
                </span>
                <IconButton
                  class={styles.entryRemove}
                  label={t("connections.form.entry.remove")}
                  onClick={() => set(list().filter((e) => e.key !== line().key))}
                  data-testid={`connection-${id}-remove`}
                >
                  <X size={14} />
                </IconButton>
              </div>
              <Show when={line().saved && line().value === ""}>
                <span class={styles.savedHint} data-testid={`connection-${id}-saved`}>
                  {t("connections.form.entry.saved")}
                </span>
              </Show>
            </div>
          )
        }}
      </Index>
      <div>
        <Button onClick={() => set([...list(), blankEntry()])} data-testid={`connection-${id}-add`}>
          {t(add)}
        </Button>
      </div>
      {under(field)}
    </div>
  )

  const textField = (
    label: MessageKey,
    value: () => string,
    set: (v: string) => void,
    field: Field,
    testId: string,
    options: { max?: number; autofocus?: boolean } = {},
  ) => (
    <label class={styles.field}>
      <span class={styles.fieldTop}>
        <span class={styles.label}>{t(label)}</span>
        <Show when={options.max}>
          {(max) => (
            <span class={styles.counter} data-over={charLength(value().trim()) > max()}>
              {charLength(value().trim())}/{max()}
            </span>
          )}
        </Show>
      </span>
      <input
        class={styles.input}
        value={value()}
        aria-invalid={shown(field) !== undefined}
        spellcheck={false}
        autocomplete="off"
        autofocus={options.autofocus}
        onInput={(e) => {
          set(e.currentTarget.value)
          touch(field)
        }}
        data-testid={testId}
      />
      {under(field)}
    </label>
  )

  return (
    <Dialog
      label={was ? t("connections.form.edit") : t("connections.form.new")}
      onClose={props.onClose}
      testId="connection-form-dialog"
    >
      <form class={styles.form} onSubmit={save} data-testid="connection-form" data-kind={kind()}>
        <h2 class={styles.label}>{was ? t("connections.form.edit") : t("connections.form.new")}</h2>
        {textField("connections.form.name", name, setName, "name", "connection-name", {
          max: CONNECTION_NAME_MAX,
          autofocus: true,
        })}
        <div class={styles.field}>
          <span class={styles.label}>{t("connections.form.kind")}</span>
          <Segmented
            label={t("connections.form.kind")}
            testId="connection-kind"
            value={kind()}
            onChange={setKind}
            options={[
              { value: "program", label: t("connections.kind.program") },
              { value: "web", label: t("connections.kind.web") },
            ]}
          />
        </div>
        <div class={styles.field} data-testid="connection-scope">
          <span class={styles.label}>{t("connections.form.scope")}</span>
          <Segmented
            label={t("connections.form.scope")}
            testId="connection-scope-kind"
            value={scopeKind()}
            onChange={setScopeKind}
            options={[
              { value: "all", label: t("connections.scope.all") },
              { value: "workflows", label: t("connections.scope.chosen") },
            ]}
          />
          <Show when={scopeKind() === "workflows"}>
            <Show
              when={workflows.list().length > 0}
              fallback={
                <span class={styles.hint} data-testid="connection-scope-none">
                  {t("connections.scope.noWorkflows")}
                </span>
              }
            >
              <ul class={styles.agentList} data-testid="connection-scope-list">
                <For each={workflows.list()}>
                  {(w) => (
                    <li>
                      <label class={styles.agentRow}>
                        <input
                          type="checkbox"
                          checked={chosen().has(w.id)}
                          onChange={(e) => toggleWorkflow(w.id, e.currentTarget.checked)}
                          data-testid="connection-scope-workflow"
                          data-workflow={w.name}
                        />
                        <span>{w.name}</span>
                      </label>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>
          <span class={styles.hint}>{t("connections.scope.hint")}</span>
        </div>
        <Show
          when={kind() === "program"}
          fallback={
            <>
              {textField(
                "connections.form.address",
                address,
                setAddress,
                "address",
                "connection-address",
              )}
              {lines(
                "connections.form.headers",
                "connections.form.headers.add",
                headers,
                setHeaders,
                "headers",
                "header",
              )}
            </>
          }
        >
          {textField(
            "connections.form.command",
            command,
            setCommand,
            "command",
            "connection-command",
          )}
          <label class={styles.field}>
            <span class={styles.label}>{t("connections.form.args")}</span>
            <textarea
              class={styles.textarea}
              value={argsText()}
              spellcheck={false}
              rows={2}
              aria-invalid={problem()?.field === "arguments"}
              onInput={(e) => setArgsText(e.currentTarget.value)}
              data-testid="connection-args"
            />
            {under("arguments")}
          </label>
          {textField("connections.form.folder", folder, setFolder, "folder", "connection-folder")}
          {lines("connections.form.env", "connections.form.env.add", env, setEnv, "env", "env")}
        </Show>
        <Show when={kind() === "program"}>
          <div class={styles.field} data-testid="connection-program-warning">
            <span class={styles.label}>{t("connections.form.line")}</span>
            <code class={styles.code} data-testid="connection-line">
              {commandLine(command(), argList())}
            </code>
            <span class={styles.hint}>{t("connections.form.warn")}</span>
            <label class={styles.agentRow}>
              <input
                type="checkbox"
                checked={confirmed()}
                onChange={(e) => {
                  setConfirmed(e.currentTarget.checked)
                  if (e.currentTarget.checked && problem()?.field === "confirm")
                    setProblem(undefined)
                }}
                data-testid="connection-confirm"
              />
              <span>{t("connections.form.confirm")}</span>
            </label>
            {under("confirm")}
          </div>
        </Show>
        <Show when={result()}>
          {(answer) => (
            <div class={styles.field} data-testid="connection-test-result" data-ok={answer().ok}>
              <Show
                when={
                  answer().ok
                    ? (answer() as Extract<ConnectionTestResult, { ok: true }>)
                    : undefined
                }
                fallback={
                  <p
                    class={styles.result}
                    data-ok="false"
                    role="alert"
                    data-testid="connection-test-failed"
                  >
                    {t("connections.form.testFailed", {
                      reason: reason(
                        (answer() as Extract<ConnectionTestResult, { ok: false }>).failure,
                      ),
                    })}
                  </p>
                }
              >
                {(good) => (
                  <>
                    <p class={styles.result} data-ok="true" role="status">
                      {t("connections.form.tested", { n: good().tools.length })}
                    </p>
                    <Show when={good().tooMany}>
                      <p class={styles.hint} data-testid="connection-test-more">
                        {t("connections.form.testedMore")}
                      </p>
                    </Show>
                    <ul class={styles.toolList} data-testid="connection-test-tools">
                      <For each={good().tools}>
                        {(tool) => (
                          <li
                            class={styles.tool}
                            data-testid="connection-test-tool"
                            data-tool={tool.name}
                          >
                            <span class={styles.toolText}>
                              <span class={styles.toolNameLine}>
                                <span class={styles.toolName}>{tool.name}</span>
                                {/* The Test list shows the read-only mark beside the tool (spec 018). */}
                                <Show when={tool.readOnly}>
                                  <span
                                    class={styles.markTag}
                                    title={t("connections.tool.readOnly.title")}
                                    data-testid="connection-test-tool-read-only"
                                  >
                                    {t("connections.tool.readOnly")}
                                  </span>
                                </Show>
                              </span>
                              <span class={styles.meta}>{tool.description}</span>
                            </span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </>
                )}
              </Show>
            </div>
          )}
        </Show>
        <Show when={problem()?.field === null ? problem() : undefined}>
          {(p) => (
            <p class={styles.fieldError} role="alert" data-testid="connection-error">
              {t(p().text.key, p().text.params)}
            </p>
          )}
        </Show>
        <div class={styles.actions}>
          <Button onClick={() => void test()} disabled={testing()} data-testid="connection-test">
            {testing() ? t("connections.testing") : t("connections.test")}
          </Button>
          <div class={styles.actionsEnd}>
            <Button onClick={props.onClose} data-testid="connection-cancel">
              {t("connections.form.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={busy()} data-testid="connection-save">
              {t("connections.form.save")}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  )
}
