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
} from "@robot/shared"
import { createSignal, For, Index, Show } from "solid-js"
import { describeError, type ErrorText } from "../lib/errors.ts"
import { squarePicture } from "../lib/image.ts"
import { ModelPicker } from "../providers/ModelPicker.tsx"
import { useApp } from "../state/app.tsx"
import { Button } from "../ui/controls.tsx"
import styles from "./agents.module.css"
import { Face, faceColour } from "./Face.tsx"

export interface AgentFormValues {
  name: string
  role: string
  instructions: string
  face: FaceValue
  model: AgentModel | null
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
  const [template, setTemplate] = createSignal<AgentTemplate | "blank">("blank")
  const [name, setName] = createSignal(props.agent?.name ?? "")
  const [role, setRole] = createSignal(props.agent?.role ?? "")
  const [instructions, setInstructions] = createSignal(props.agent?.instructions ?? "")
  /** The face the user picked. Until then a new agent's face follows its name. */
  const [pickedFace, setPickedFace] = createSignal<FaceValue | undefined>(props.agent?.face)
  const [model, setModel] = createSignal<AgentModel | null>(props.agent?.model ?? null)
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

      <label class={styles.field}>
        <span class={styles.fieldTop}>
          <span class={styles.label}>{t("agents.field.name")}</span>
          <Counter used={nameLength()} max={AGENT_NAME_MAX} />
        </span>
        <input
          class={styles.input}
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          data-testid="agent-name"
          autofocus
        />
      </label>

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
          <Face face={face()} image={props.agent?.faceImage ?? null} size={64} />
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
