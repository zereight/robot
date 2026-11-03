import {
  AGENT_NAME_MAX,
  AGENT_NAMES,
  AGENT_ROLE_MAX,
  type Agent,
  type AgentModel,
  charLength,
  FACE_HUES,
  FACE_SHAPES,
  type Face as FaceValue,
  faceFromName,
  isLooser,
  isRuntimeKind,
  type Locale,
  levelNeedsConfirm,
  type MessageKey,
  nameKey,
  PERMISSION_LEVELS,
  type PermissionLevel,
  type ProviderKind,
  type RuntimeKind,
  STARTER_PLANS,
  STARTER_ROUTINE_SCHEDULE,
  STARTERS,
  type StarterId,
  type StarterSetup,
  starterExtras,
  starterSetup,
  starterText,
  suggestName,
} from "@robot/shared"
import { Dices } from "lucide-solid"
import {
  createEffect,
  createResource,
  createSignal,
  createUniqueId,
  For,
  Index,
  type JSX,
  Show,
} from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { squarePicture } from "../lib/image.ts"
import { call } from "../lib/rpc.ts"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import { useScheduleWords } from "../routines/RoutinesPage.tsx"
import { useApp } from "../state/app.tsx"
import { useProviders } from "../state/providers.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, IconButton, Segmented, Switch } from "../ui/controls.tsx"
import { Dialog } from "../ui/Dialog.tsx"
import { Presence } from "../ui/Presence.tsx"
import { SectionSelect } from "../ui/SectionSelect.tsx"
import styles from "./agents.module.css"
import { Face, faceColour } from "./Face.tsx"
import { InstructionHistory } from "./InstructionHistory.tsx"
import { MemoryPanel } from "./MemoryPanel.tsx"

export interface AgentFormValues {
  name: string
  role: string
  instructions: string
  face: FaceValue
  model: AgentModel | null
  /** The user section of the Agents list, or null for "No section". A client sends none. */
  sectionId?: string | null
  /** The level of the agent. A form on a linked server sends it only for an agent that exists. */
  permission?: PermissionLevel
  /** Only when an existing agent is edited. */
  memoryEnabled?: boolean
  /**
   * Set when the user picked a starter on this computer that makes more than the three fields: the
   * strings of its routine and its skill, in the language of the pick. The app makes them on
   * Create (spec 002). A linked server gets the three fields only, so a form there sends none.
   */
  starter?: StarterSetup
}

export interface AgentFormProps {
  /** The agent to edit. Without it the form makes a new agent. */
  agent?: Agent
  onSubmit: (values: AgentFormValues) => Promise<void>
  onCancel: () => void
  /** Changes the picture of an existing agent. */
  onPicture?: (dataUrl: string | null) => Promise<void>
  /** A field that applies at once, not with Save. It shows after the fields, above the buttons. */
  immediate?: JSX.Element
}

const Counter = (props: { used: number; max: number }) => {
  const { t } = useApp()
  return (
    <span class={styles.counter} data-over={props.used > props.max}>
      {t("agents.counter", { used: props.used, max: props.max })}
    </span>
  )
}

export const AgentForm = (props: AgentFormProps) => {
  const app = useApp()
  const { t } = app
  const ui = useUi()
  const scheduleWords = useScheduleWords()
  // On a linked server the same screen works with fewer fields (spec 012): no picture, no memory
  // switch, no section, and a level that can only get stricter.
  const remote = () => ui.linked()
  const levels = () =>
    remote() && props.agent
      ? PERMISSION_LEVELS.filter((level) => !isLooser(level, (props.agent as Agent).permission))
      : PERMISSION_LEVELS
  const nameId = createUniqueId()
  const nameErrorId = createUniqueId()
  const roleErrorId = createUniqueId()
  const [starter, setStarter] = createSignal<StarterId | "blank">("blank")
  /** The language of the interface when the user picked the starter (spec 002). */
  const [starterLocale, setStarterLocale] = createSignal<Locale>(app.locale())
  const [name, setName] = createSignal(props.agent?.name ?? "")
  const [role, setRole] = createSignal(props.agent?.role ?? "")
  const [instructions, setInstructions] = createSignal(props.agent?.instructions ?? "")
  /** The face the user picked. Until then a new agent's face follows its name. */
  const [pickedFace, setPickedFace] = createSignal<FaceValue | undefined>(props.agent?.face)
  const [model, setModel] = createSignal<AgentModel | null>(props.agent?.model ?? null)
  const [sectionId, setSectionId] = createSignal<string | null>(props.agent?.sectionId ?? null)
  const [permission, setPermission] = createSignal<PermissionLevel>(
    props.agent?.permission ?? "ask_risky",
  )
  const [memoryEnabled, setMemoryEnabled] = createSignal(props.agent?.memoryEnabled ?? true)

  // What the model is: an API provider, or a vendor program. It decides which line shows under the
  // level, and whether "Read only" can be picked (spec 007).
  const providers = useProviders()
  const [offered] = createResource(
    () => (remote() ? "server" : null),
    () => call("models.available").catch(() => []),
  )
  const modelKind = (): ProviderKind | null => {
    const picked = model()
    if (!picked) return null
    if (remote()) return offered()?.find((c) => c.accountId === picked.accountId)?.kind ?? null
    return providers.byId(picked.accountId)?.kind ?? null
  }
  const programKind = (): RuntimeKind | null => {
    const kind = modelKind()
    return kind && isRuntimeKind(kind) ? kind : null
  }
  const [programReadOnly] = createResource(
    () => (remote() ? null : programKind()),
    async (kind) => (await call("runtimes.readOnly", { kind })).supported,
  )
  /** True when the program of the model has no read-only mode: the option is off. */
  const readOnlyOff = () => {
    if (programKind() === null) return false
    if (remote()) {
      const picked = model()
      return offered()?.find((c) => c.accountId === picked?.accountId)?.readOnly === false
    }
    return programReadOnly() === false
  }
  // A level that is off cannot stay picked. The next strictest level takes its place.
  createEffect(() => {
    if (readOnlyOff() && permission() === "read_only") setPermission("ask_all")
  })

  // "Full access" asks the user to confirm. "Back" keeps the old level. No other level asks.
  const [confirmFull, setConfirmFull] = createSignal(false)
  const [levelBefore, setLevelBefore] = createSignal<PermissionLevel>(permission())
  const pickLevel = (value: PermissionLevel) => {
    if (levelNeedsConfirm(value) && permission() !== value) {
      setLevelBefore(permission())
      setPermission(value)
      setConfirmFull(true)
      return
    }
    setPermission(value)
  }
  const backFromFull = () => {
    setPermission(levelBefore())
    setConfirmFull(false)
  }
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  let fileInput: HTMLInputElement | undefined
  let nameInput: HTMLInputElement | undefined
  let roleInput: HTMLInputElement | undefined

  const face = () => pickedFace() ?? faceFromName(name().trim() || "?")
  const nameLength = () => charLength(name().trim())
  const nameProblem = (): ErrorText | undefined => {
    if (nameLength() < 1) return { key: "agents.error.name_empty" }
    if (nameLength() > AGENT_NAME_MAX)
      return { key: "agents.error.name_long", params: { max: AGENT_NAME_MAX } }
  }
  const roleProblem = (): ErrorText | undefined =>
    charLength(role()) > AGENT_ROLE_MAX
      ? { key: "agents.error.role_long", params: { max: AGENT_ROLE_MAX } }
      : undefined
  const valid = () => !nameProblem() && !roleProblem()
  /**
   * Save stays on when a field is wrong, so that pressing it can say what is wrong. The reasons
   * show after the first press, and they follow the fields from then on: a field that is fixed
   * loses its reason at once.
   */
  const [tried, setTried] = createSignal(false)
  const shownNameProblem = () => (tried() ? nameProblem() : undefined)
  const shownRoleProblem = () => (tried() ? roleProblem() : undefined)

  /** A starter fills the name, the role line and the instructions. Blank clears them. */
  const pickStarter = (next: StarterId | "blank") => {
    setStarter(next)
    if (next === "blank") {
      setName("")
      setRole("")
      setInstructions("")
      return
    }
    const locale = app.locale()
    setStarterLocale(locale)
    const text = starterText(locale, next)
    setName(text.name)
    setRole(text.role)
    setInstructions(text.instructions)
  }

  /**
   * What the picked starter also makes on Create, in the language of the pick. A linked server
   * makes none of it, so the form says nothing about it there.
   */
  const makes = () => {
    const picked = starter()
    if (picked === "blank" || remote()) return undefined
    const plan = STARTER_PLANS[picked]
    return plan.routine || plan.skill ? starterText(starterLocale(), picked) : undefined
  }

  /**
   * The strings that go with the request on Create: the text of the starter in the language of
   * the pick, not the language of the interface now. None for Blank, for a starter that makes
   * nothing else, for an agent that exists, and on a linked server (spec 002, 012).
   */
  const setup = (): StarterSetup | null => {
    const picked = starter()
    if (props.agent || remote() || picked === "blank") return null
    return starterSetup(starterText(starterLocale(), picked))
  }

  /**
   * Puts a random name in the field. Names of active and archived agents on the server are
   * skipped, because both count for the rule that names are unique (002).
   */
  const suggest = async () => {
    const serverId = ui.server()?.id
    const used = new Set<string>()
    if (serverId) {
      try {
        const lists = await Promise.all([
          call("agents.list", { serverId, archived: false }),
          call("agents.list", { serverId, archived: true }),
        ])
        for (const agent of lists.flat()) used.add(nameKey(agent.name))
      } catch {
        // The server still checks the name when the agent is made.
      }
    }
    setName(suggestName(AGENT_NAMES, (candidate) => used.has(nameKey(candidate)), name()))
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (busy()) return
    if (!valid()) {
      setTried(true)
      // The focus goes to the first field that blocks Save. The field shows in the middle, so
      // that its label and its reason stay in view.
      const first = nameProblem() ? nameInput : roleInput
      first?.focus({ preventScroll: true })
      first?.scrollIntoView({ block: "center" })
      return
    }
    setBusy(true)
    setError(undefined)
    const extra = setup()
    try {
      await props.onSubmit({
        name: name().trim(),
        role: role().trim(),
        instructions: instructions(),
        face: face(),
        model: model(),
        // A linked server gets the three fields only: it has no routine or skill to make (012).
        ...(extra ? { starter: extra } : {}),
        // A client has no sections (012). A section that was deleted while the form was open
        // shows as "No section".
        ...(remote()
          ? {}
          : { sectionId: ui.hasSection("agent", sectionId()) ? sectionId() : null }),
        ...(props.agent && !remote()
          ? { permission: permission(), memoryEnabled: memoryEnabled() }
          : props.agent || !remote()
            ? { permission: permission() }
            : {}),
      })
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const upload = async (file: File | undefined) => {
    if (!file || !props.onPicture) return
    setError(undefined)
    try {
      await props.onPicture(await squarePicture(file))
    } catch (e) {
      const described = describeError(e)
      setError(described.key === "error.unknown" ? { key: "error.face_image_invalid" } : described)
    }
  }

  return (
    <form class={styles.form} onSubmit={submit} data-testid="agent-form">
      <h2 class={styles.title}>
        {props.agent ? t("agents.edit.title") : t("agents.create.title")}
      </h2>

      <Show when={!props.agent}>
        <fieldset class={`${styles.field} ${styles.group}`}>
          <legend class={styles.label}>{t("agents.template")}</legend>
          <div class={styles.starters}>
            <button
              type="button"
              class={styles.starter}
              aria-pressed={starter() === "blank"}
              data-testid="starter-blank"
              onClick={() => pickStarter("blank")}
            >
              <span class={styles.starterName}>{t("agents.template.blank")}</span>
            </button>
            <For each={STARTERS}>
              {(id) => (
                <button
                  type="button"
                  class={styles.starter}
                  aria-pressed={starter() === id}
                  data-testid={`starter-${id}`}
                  onClick={() => pickStarter(id)}
                >
                  <span class={styles.starterName}>{starterText(app.locale(), id).name}</span>
                  <span class={styles.starterJob}>{starterText(app.locale(), id).job}</span>
                  <Show when={!remote()}>
                    <span class={styles.starterExtras} data-testid={`starter-${id}-extras`}>
                      {starterExtras(app.locale(), id)}
                    </span>
                  </Show>
                </button>
              )}
            </For>
          </div>
          <Show when={makes()}>
            {(text) => (
              <>
                <span class={styles.hint}>{t("starters.makes")}</span>
                <ul class={styles.makes} data-testid="starter-makes">
                  <Show when={text().routine}>
                    {(routine) => (
                      <li data-testid="starter-makes-routine">
                        {t("starters.makes.routine", {
                          name: routine().name,
                          schedule: scheduleWords(STARTER_ROUTINE_SCHEDULE),
                        })}
                      </li>
                    )}
                  </Show>
                  <Show when={text().skill}>
                    {(skill) => (
                      <li data-testid="starter-makes-skill">
                        {t("starters.makes.skill", { name: skill().name })}
                      </li>
                    )}
                  </Show>
                </ul>
              </>
            )}
          </Show>
        </fieldset>
        <hr class={styles.divider} />
      </Show>

      <div class={styles.field}>
        <span class={styles.fieldTop}>
          <label class={styles.label} for={nameId}>
            {t("agents.field.name")}
          </label>
          <Counter used={nameLength()} max={AGENT_NAME_MAX} />
        </span>
        <div class={styles.nameRow}>
          <input
            id={nameId}
            ref={nameInput}
            class={`${styles.input} ${styles.grow}`}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            aria-invalid={shownNameProblem() !== undefined}
            aria-describedby={shownNameProblem() ? nameErrorId : undefined}
            data-testid="agent-name"
            autofocus
          />
          <Show when={!props.agent}>
            <IconButton
              label={t("agents.suggestName")}
              onClick={suggest}
              data-testid="agent-name-suggest"
            >
              <Dices size={18} aria-hidden="true" />
            </IconButton>
          </Show>
        </div>
        <Show when={shownNameProblem()}>
          {(problem) => (
            <span
              id={nameErrorId}
              class={styles.fieldError}
              role="alert"
              data-testid="agent-name-error"
            >
              {t(problem().key, problem().params)}
            </span>
          )}
        </Show>
      </div>

      <label class={styles.field}>
        <span class={styles.fieldTop}>
          <span class={styles.label}>{t("agents.field.role")}</span>
          <Counter used={charLength(role())} max={AGENT_ROLE_MAX} />
        </span>
        <input
          ref={roleInput}
          class={styles.input}
          value={role()}
          onInput={(e) => setRole(e.currentTarget.value)}
          aria-invalid={shownRoleProblem() !== undefined}
          aria-describedby={shownRoleProblem() ? roleErrorId : undefined}
          data-testid="agent-role"
        />
        <span class={styles.hint}>{t("agents.field.role.hint")}</span>
        <Show when={shownRoleProblem()}>
          {(problem) => (
            <span
              id={roleErrorId}
              class={styles.fieldError}
              role="alert"
              data-testid="agent-role-error"
            >
              {t(problem().key, problem().params)}
            </span>
          )}
        </Show>
      </label>

      <label class={styles.field}>
        <span class={styles.label}>{t("agents.field.instructions")}</span>
        <textarea
          class={styles.textarea}
          value={instructions()}
          onInput={(e) => setInstructions(e.currentTarget.value)}
          data-testid="agent-instructions"
        />
        <span class={styles.hint}>{t("agents.field.instructions.hint")}</span>
      </label>
      {/* The history stays on the computer of the agent and its sync peer (spec 002, 012). */}
      <Show when={!remote() ? props.agent : undefined}>
        {(agent) => <InstructionHistory agentId={agent().id} onRestored={setInstructions} />}
      </Show>

      <hr class={styles.divider} />

      <div class={styles.field}>
        <span class={styles.label}>{t("agents.field.face")}</span>
        <div class={styles.faceRow}>
          <Face face={face()} image={props.agent?.faceImage ?? null} size={64} swap />
          <div class={styles.facePicker}>
            <div class={styles.options}>
              <Index each={Array.from({ length: FACE_SHAPES })}>
                {(_, shape) => (
                  <button
                    type="button"
                    class={styles.option}
                    aria-label={t("agents.face.shape", { n: shape + 1 })}
                    aria-pressed={face().shape === shape}
                    data-testid={`face-shape-${shape}`}
                    onClick={() => setPickedFace({ ...face(), shape })}
                  >
                    <Face face={{ shape, hue: face().hue }} size={28} />
                  </button>
                )}
              </Index>
            </div>
            <div class={styles.options}>
              <Index each={Array.from({ length: FACE_HUES })}>
                {(_, hue) => (
                  <button
                    type="button"
                    class={styles.option}
                    aria-label={t("agents.face.hue", { n: hue + 1 })}
                    aria-pressed={face().hue === hue}
                    data-testid={`face-hue-${hue}`}
                    onClick={() => setPickedFace({ ...face(), hue })}
                  >
                    <span class={styles.swatch} style={{ background: faceColour(hue) }} />
                  </button>
                )}
              </Index>
            </div>
          </div>
        </div>
        <Show when={props.onPicture}>
          <div class={styles.options}>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              data-testid="face-file"
              onChange={(e) => upload(e.currentTarget.files?.[0])}
            />
            <Button onClick={() => fileInput?.click()}>{t("agents.face.upload")}</Button>
            <Show when={props.agent?.faceImage}>
              <Button onClick={() => props.onPicture?.(null)} data-testid="face-remove">
                {t("agents.face.remove")}
              </Button>
            </Show>
          </div>
        </Show>
      </div>

      <hr class={styles.divider} />

      <div class={styles.field}>
        <span class={styles.label}>{t("agents.field.model")}</span>
        <ModelPicker value={model()} onChange={setModel} />
      </div>

      <Show when={!remote()}>
        <div class={styles.field}>
          <span class={styles.label}>{t("sections.field")}</span>
          <SectionSelect
            kind="agent"
            value={sectionId()}
            onChange={setSectionId}
            class={styles.input}
            testId="agent-section"
          />
        </div>
      </Show>

      {/* The level: in the profile of an agent, and in the form of a new agent on this computer. */}
      <Show when={props.agent || !remote()}>
        <hr class={styles.divider} />
        <div class={styles.field}>
          <span class={styles.label}>{t("agents.field.permission")}</span>
          <Segmented
            label={t("agents.field.permission")}
            value={permission()}
            options={levels().map((value) => ({
              value,
              label: t(`agents.permission.${value}` as MessageKey),
              disabled: value === "read_only" && readOnlyOff(),
            }))}
            onChange={pickLevel}
            testId="agent-permission"
          />
          {/* One line says how the level applies to the runtime of this agent. */}
          <span class={styles.hint} data-testid="agent-permission-line">
            {t(`agents.permission.line.${programKind() ?? "app"}.${permission()}` as MessageKey)}
          </span>
          <Show when={readOnlyOff()}>
            <span class={styles.hint} data-testid="agent-permission-off">
              {t("agents.permission.readOnlyOff", {
                program: t(`providers.kind.${programKind() ?? "claude_code"}` as MessageKey),
              })}
            </span>
          </Show>
          <Show when={remote()}>
            <span class={styles.hint} data-testid="agent-permission-stricter">
              {t("agents.permission.stricter")}
            </span>
          </Show>
        </div>
        <Presence when={confirmFull()}>
          {() => (
            <Dialog
              label={t("agents.permission.confirm.title")}
              onClose={backFromFull}
              testId="full-access-confirm"
            >
              <div class={styles.form}>
                <h2 class={styles.title}>{t("agents.permission.confirm.title")}</h2>
                <p>{t("agents.permission.confirm.body")}</p>
                <div class={styles.actions}>
                  <Button onClick={backFromFull} data-testid="full-access-back">
                    {t("agents.permission.confirm.back")}
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => setConfirmFull(false)}
                    data-testid="full-access-use"
                  >
                    {t("agents.permission.confirm.use")}
                  </Button>
                </div>
              </div>
            </Dialog>
          )}
        </Presence>
      </Show>

      <Show when={props.agent}>
        {(agent) => (
          <>
            <hr class={styles.divider} />
            <Show when={!remote()}>
              <div class={styles.switchRow}>
                <span class={styles.label}>{t("agents.field.memory")}</span>
                <Switch
                  label={t("agents.field.memory")}
                  checked={memoryEnabled()}
                  onChange={setMemoryEnabled}
                  testId="agent-memory-enabled"
                />
              </div>
            </Show>
            <MemoryPanel agentId={agent().id} />
          </>
        )}
      </Show>

      <Show when={props.immediate}>
        {(field) => (
          <>
            <hr class={styles.divider} />
            {field()}
          </>
        )}
      </Show>

      <Show when={error()}>
        {(err) => (
          <div class={styles.error} role="alert" data-testid="agent-error">
            {t(err().key, err().params)}
          </div>
        )}
      </Show>

      <div class={styles.actions}>
        <Button onClick={props.onCancel}>{t("agents.cancel")}</Button>
        <Button variant="primary" type="submit" disabled={busy()} data-testid="agent-submit">
          {props.agent ? t("agents.save") : t("agents.create.submit")}
        </Button>
      </div>
    </form>
  )
}
