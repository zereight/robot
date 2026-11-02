import {
  AGENT_NAME_MAX,
  AGENT_ROLE_MAX,
  AGENT_TEMPLATES,
  type Agent,
  type AgentModel,
  type AgentTemplate,
  charLength,
  FACE_HUES,
  FACE_SHAPES,
  type Face as FaceValue,
  faceFromName,
  type MessageKey,
  nameKey,
  PERMISSION_LEVELS,
  type PermissionLevel,
  SUGGESTED_NAME_COUNT,
  suggestName,
} from "@robot/shared"
import { Dices } from "lucide-solid"
import { createSignal, createUniqueId, For, Index, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { squarePicture } from "../lib/image.ts"
import { call } from "../lib/rpc.ts"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import { useApp } from "../state/app.tsx"
import { useUi } from "../state/ui.tsx"
import { Button, IconButton, Segmented, Switch } from "../ui/controls.tsx"
import styles from "./agents.module.css"
import { Face, faceColour } from "./Face.tsx"
import { MemoryPanel } from "./MemoryPanel.tsx"

export interface AgentFormValues {
  name: string
  role: string
  instructions: string
  face: FaceValue
  model: AgentModel | null
  /** Only when an existing agent is edited. */
  permission?: PermissionLevel
  memoryEnabled?: boolean
}

export interface AgentFormProps {
  /** The agent to edit. Without it the form makes a new agent. */
  agent?: Agent
  onSubmit: (values: AgentFormValues) => Promise<void>
  onCancel: () => void
  /** Changes the picture of an existing agent. */
  onPicture?: (dataUrl: string | null) => Promise<void>
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
  const { t } = useApp()
  const ui = useUi()
  const nameId = createUniqueId()
  const [template, setTemplate] = createSignal<AgentTemplate | "blank">("blank")
  const [name, setName] = createSignal(props.agent?.name ?? "")
  const [role, setRole] = createSignal(props.agent?.role ?? "")
  const [instructions, setInstructions] = createSignal(props.agent?.instructions ?? "")
  /** The face the user picked. Until then a new agent's face follows its name. */
  const [pickedFace, setPickedFace] = createSignal<FaceValue | undefined>(props.agent?.face)
  const [model, setModel] = createSignal<AgentModel | null>(props.agent?.model ?? null)
  const [permission, setPermission] = createSignal<PermissionLevel>(
    props.agent?.permission ?? "ask_risky",
  )
  const [memoryEnabled, setMemoryEnabled] = createSignal(props.agent?.memoryEnabled ?? true)
  const [error, setError] = createSignal<ErrorText>()
  const [busy, setBusy] = createSignal(false)
  let fileInput: HTMLInputElement | undefined

  const face = () => pickedFace() ?? faceFromName(name().trim() || "?")
  const nameLength = () => charLength(name().trim())
  const valid = () =>
    nameLength() >= 1 && nameLength() <= AGENT_NAME_MAX && charLength(role()) <= AGENT_ROLE_MAX

  const pickTemplate = (next: AgentTemplate | "blank") => {
    setTemplate(next)
    if (next === "blank") {
      setName("")
      setRole("")
      setInstructions("")
    } else {
      setName(t(`template.${next}.name` as MessageKey))
      setRole(t(`template.${next}.role` as MessageKey))
      setInstructions(t(`template.${next}.instructions` as MessageKey))
    }
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
    const names = Array.from({ length: SUGGESTED_NAME_COUNT }, (_, i) =>
      t(`agents.suggest.name.${i + 1}` as MessageKey),
    )
    setName(suggestName(names, (candidate) => used.has(nameKey(candidate)), name()))
  }

  const submit = async (event: SubmitEvent) => {
    event.preventDefault()
    if (!valid() || busy()) return
    setBusy(true)
    setError(undefined)
    try {
      await props.onSubmit({
        name: name().trim(),
        role: role().trim(),
        instructions: instructions(),
        face: face(),
        model: model(),
        ...(props.agent ? { permission: permission(), memoryEnabled: memoryEnabled() } : {}),
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
        <div class={styles.field}>
          <span class={styles.label}>{t("agents.template")}</span>
          <div class={styles.templates}>
            <For each={["blank", ...AGENT_TEMPLATES] as const}>
              {(item) => (
                <button
                  type="button"
                  class={styles.chip}
                  aria-pressed={template() === item}
                  data-testid={`template-${item}`}
                  onClick={() => pickTemplate(item)}
                >
                  {t(`agents.template.${item}` as MessageKey)}
                </button>
              )}
            </For>
          </div>
        </div>
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
            class={`${styles.input} ${styles.grow}`}
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
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
      </div>

      <label class={styles.field}>
        <span class={styles.fieldTop}>
          <span class={styles.label}>{t("agents.field.role")}</span>
          <Counter used={charLength(role())} max={AGENT_ROLE_MAX} />
        </span>
        <input
          class={styles.input}
          value={role()}
          onInput={(e) => setRole(e.currentTarget.value)}
          data-testid="agent-role"
        />
        <span class={styles.hint}>{t("agents.field.role.hint")}</span>
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
        </div>
      </div>

      <div class={styles.field}>
        <span class={styles.label}>{t("agents.field.model")}</span>
        <ModelPicker value={model()} onChange={setModel} />
      </div>

      <Show when={props.agent}>
        {(agent) => (
          <>
            <div class={styles.field}>
              <span class={styles.label}>{t("agents.field.permission")}</span>
              <Segmented
                label={t("agents.field.permission")}
                value={permission()}
                options={PERMISSION_LEVELS.map((value) => ({
                  value,
                  label: t(`agents.permission.${value}` as MessageKey),
                }))}
                onChange={setPermission}
                testId="agent-permission"
              />
              <span class={styles.hint}>{t("agents.permission.hint")}</span>
            </div>
            <div class={styles.field}>
              <span class={styles.label}>{t("agents.field.memory")}</span>
              <Switch
                label={t("agents.field.memory")}
                checked={memoryEnabled()}
                onChange={setMemoryEnabled}
                testId="agent-memory-enabled"
              />
            </div>
            <MemoryPanel agentId={agent().id} />
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
        <Button
          variant="primary"
          type="submit"
          disabled={!valid() || busy()}
          data-testid="agent-submit"
        >
          {props.agent ? t("agents.save") : t("agents.create.submit")}
        </Button>
      </div>
    </form>
  )
}
