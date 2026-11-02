import { REDACTED, redactSecrets } from "./redact.ts"
import { TEACH_KEYS, type TeachEvent } from "./teachPage.ts"

export * from "./teachPage.ts"

/** "Teach a task" (spec 017): the user does a task once in the browser of an agent. */

export const TEACH_RESULT_MAX = 500
/** A recording stops by itself at this many steps. */
export const TEACH_STEPS_MAX = 300
/** A recording stops by itself after this much recorded time. Paused time does not count. */
export const TEACH_TIME_MAX_MS = 30 * 60 * 1000
/** Labels, titles and visible texts are cut to this length. */
export const TEACH_TEXT_MAX = 120
/** Typed text is cut to this length. */
export const TEACH_TYPED_MAX = 500
/** Addresses are cut to this length. */
export const TEACH_URL_MAX = 500

/** One recorded step, after the rules for secrets. This is what the model gets. */
export type TeachStep =
  | { readonly kind: "page"; readonly url: string; readonly title: string }
  | { readonly kind: "click"; readonly role: string; readonly label: string }
  | { readonly kind: "type"; readonly label: string; readonly text: string }
  | { readonly kind: "secret"; readonly label: string }
  | { readonly kind: "choose"; readonly label: string; readonly choice: string }
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "scroll"; readonly down: boolean }

/**
 * A label that names a password, a code, a token, a key or a card number. The text typed into
 * such a field is never recorded.
 */
const SECRET_LABEL =
  /\b(pass(word|code|phrase)?|pwd|pin|otp|code|token|key|secret|cvc|cvv|ssn)\b|card\s*(no|num|number)|비밀\s*번호|암호|코드|토큰|키|카드\s*번호|인증\s*번호/i

/** Autocomplete hints of fields that hold secrets. */
const SECRET_AUTOCOMPLETE =
  /(^|\s)(current-password|new-password|one-time-code|cc-number|cc-csc)\b/i

export const isSecretLabel = (label: string) => SECRET_LABEL.test(label)

export const isSecretField = (event: Extract<TeachEvent, { kind: "type" }>) =>
  event.password || isSecretLabel(event.label) || SECRET_AUTOCOMPLETE.test(event.autocomplete)

/** Names of address parameters whose values are secrets. */
const SECRET_PARAM =
  /^(.*[_-])?(token|key|apikey|api_key|secret|password|pass|pwd|code|auth|sig|signature|session|sid|access_token|id_token)$/i

const clean = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** A label or a visible text: one line, short, with secret-like text hidden. */
export const redactLabel = (text: string) => clean(redactSecrets(text), TEACH_TEXT_MAX)

/**
 * An address with its secrets hidden: secret-like text anywhere, the values of parameters whose
 * name says secret, and the user name and password of the address.
 */
export const redactAddress = (address: string): string => {
  let out = address
  try {
    const url = new URL(address)
    if (url.username || url.password) {
      url.username = ""
      url.password = ""
    }
    for (const name of [...url.searchParams.keys()])
      if (SECRET_PARAM.test(name)) url.searchParams.set(name, REDACTED)
    out = url.toString().replaceAll(encodeURIComponent(REDACTED), REDACTED)
  } catch {
    // Not a full address: only the shapes of secrets are hidden.
  }
  return clean(redactSecrets(out), TEACH_URL_MAX)
}

/** The step to keep for an event, after the rules for secrets. */
export const toStep = (event: TeachEvent): TeachStep => {
  switch (event.kind) {
    case "page":
      return { kind: "page", url: redactAddress(event.url), title: redactLabel(event.title) }
    case "click":
      return { kind: "click", role: clean(event.role, 40), label: redactLabel(event.label) }
    case "type":
      return isSecretField(event)
        ? { kind: "secret", label: redactLabel(event.label) }
        : {
            kind: "type",
            label: redactLabel(event.label),
            text: clean(redactSecrets(event.text), TEACH_TYPED_MAX),
          }
    case "choose":
      return { kind: "choose", label: redactLabel(event.label), choice: redactLabel(event.choice) }
    case "key":
      return { kind: "key", key: clean(event.key, 20) }
    case "scroll":
      return { kind: "scroll", down: event.down }
  }
}

/**
 * Adds a step to the list. Scrolls that follow each other are one step. The same page twice in a
 * row is one step too. Returns the new list; the old one is not changed.
 */
export const addStep = (steps: readonly TeachStep[], step: TeachStep): readonly TeachStep[] => {
  const last = steps.at(-1)
  if (step.kind === "scroll" && last?.kind === "scroll") return [...steps.slice(0, -1), step]
  if (step.kind === "page" && last?.kind === "page" && last.url === step.url)
    return [...steps.slice(0, -1), step]
  return [...steps, step]
}

const quote = (text: string) => `"${text}"`

/** One step in plain words, for the request to the model. */
export const stepLine = (step: TeachStep): string => {
  switch (step.kind) {
    case "page":
      return step.title
        ? `Opened the page ${quote(step.title)} at ${step.url}`
        : `Opened the page at ${step.url}`
    case "click": {
      const what = step.label ? quote(step.label) : "an element with no label"
      return step.role ? `Clicked the ${step.role} ${what}` : `Clicked ${what}`
    }
    case "type":
      return `Typed ${quote(step.text)} into ${step.label || "a field with no label"}`
    case "secret":
      return `Typed a secret into ${step.label || "a field with no label"}`
    case "choose":
      return `Chose ${quote(step.choice)} in ${step.label || "a list with no label"}`
    case "key":
      return `Pressed ${step.key}`
    case "scroll":
      return step.down ? "Scrolled down" : "Scrolled up"
  }
}

/** What the model is told to do with a recording. */
export const TEACH_SYSTEM = [
  "You write a reusable skill from a task that a user did once in a web browser.",
  "A skill is a set of instructions that an AI agent with a browser follows later to do the same task.",
  "Reply with one JSON object and nothing else, with these string fields:",
  '"name": a short name for the skill, at most 40 characters.',
  '"description": when to use the skill, at most 140 characters.',
  '"instructions": the steps in plain words, numbered; what to check at the end; and when to ask the user first, for example before a payment, a deletion, or a message to other people.',
  "Never write a secret into the skill. Where the user typed a secret, tell the agent to ask the user for it or to use a saved secret.",
].join("\n")

/** The last line is fixed, so a model reads it as the form of the answer. */
export const TEACH_REPLY_LINE = "Reply with the JSON object only."

/** The message to the model: the result that the user wants and the numbered steps. */
export const teachPrompt = (result: string, steps: readonly TeachStep[]) =>
  [
    `The result of the task: ${result}`,
    "",
    `The steps that the user did (${steps.length}):`,
    ...steps.map((step, i) => `${i + 1}. ${stepLine(step)}`),
    "",
    TEACH_REPLY_LINE,
  ].join("\n")

export interface TeachDraft {
  readonly name: string
  readonly description: string
  readonly instructions: string
}

const field = (value: unknown) => (typeof value === "string" ? value.trim() : "")

/**
 * The draft in the answer of the model. A model can wrap the object in a code fence or text. An
 * answer with no object gives `undefined`.
 */
export const parseDraft = (answer: string): TeachDraft | undefined => {
  const start = answer.indexOf("{")
  const end = answer.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  try {
    const value = JSON.parse(answer.slice(start, end + 1)) as Record<string, unknown>
    const draft = {
      name: field(value.name).replace(/^\/+/, "").slice(0, 40).trim(),
      description: field(value.description).slice(0, 140).trim(),
      instructions: field(value.instructions).slice(0, 20_000),
    }
    return draft.instructions ? draft : undefined
  } catch {
    return undefined
  }
}

/** Why a recording stopped by itself. */
export type TeachLimit = "steps" | "time"

/** The state of "Teach a task" on this computer. At most one recording runs at a time. */
export type TeachState =
  | { readonly phase: "idle" }
  | {
      readonly phase: "recording"
      readonly agentId: string
      readonly agentName: string
      readonly result: string
      readonly steps: number
      readonly paused: boolean
      /** Recorded time up to `at`, in ms. Paused time does not count. */
      readonly elapsedMs: number
      /** When `elapsedMs` was measured. While not paused, the time goes on from here. */
      readonly at: number
    }
  | {
      readonly phase: "drafting" | "draft" | "failed" | "saved"
      readonly agentId: string
      readonly agentName: string
      readonly result: string
      readonly steps: number
      /** Set when the recording stopped by itself. */
      readonly limit: TeachLimit | null
      /** Set in the phase "draft". */
      readonly draft: TeachDraft | null
      /** Set in the phase "failed": the error code. */
      readonly error: string | null
      /** Set in the phase "saved". */
      readonly skill: { readonly id: string; readonly name: string } | null
    }

const isText = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max

/**
 * A step that the recorder in a page reported, checked. The page is not trusted: anything else
 * than the known shapes gives `undefined`.
 */
export const teachEventOf = (value: unknown): TeachEvent | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const v = value as Record<string, unknown>
  const long = 10_000
  switch (v.kind) {
    case "click":
      return isText(v.role, 100) && isText(v.label, long)
        ? { kind: "click", role: v.role, label: v.label }
        : undefined
    case "type":
      return isText(v.label, long) &&
        isText(v.text, 100_000) &&
        typeof v.password === "boolean" &&
        isText(v.autocomplete, 200)
        ? {
            kind: "type",
            label: v.label,
            text: v.text,
            password: v.password,
            autocomplete: v.autocomplete,
          }
        : undefined
    case "choose":
      return isText(v.label, long) && isText(v.choice, long)
        ? { kind: "choose", label: v.label, choice: v.choice }
        : undefined
    case "key":
      return typeof v.key === "string" && TEACH_KEYS.includes(v.key)
        ? { kind: "key", key: v.key }
        : undefined
    case "scroll":
      return typeof v.down === "boolean" ? { kind: "scroll", down: v.down } : undefined
    default:
      return undefined
  }
}
