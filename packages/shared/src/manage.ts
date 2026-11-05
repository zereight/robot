import {
  type AgentSettingField,
  listModels,
  planSettings,
  type SettingChange,
  type SettingsAccount,
  type SettingsCurrent,
} from "./agentSettings.ts"
import { type AgentModel, type Face, faceFromName } from "./agents.ts"
import { NEW_AGENT_EFFORT, settledEffort } from "./providers.ts"
import { defaultSettings } from "./settings.ts"

/**
 * The manage tools (spec 036): a caller makes and changes agents, channels and routines, and the
 * user allows each change. This file holds the pure part of them: it checks a call as the form of
 * the user does and gives back the change in full, or the reason that nothing was made.
 */

/** The fields of "Make an agent". The permission level and every other field are not here. */
export const MAKE_AGENT_ARGS = [
  "name",
  "role",
  "instructions",
  "face_shape",
  "face_hue",
  "account",
  "model",
  "effort",
] as const

/** A new agent as a request holds it. The rest is the default of the form of a new agent. */
export interface MakeAgentRequest {
  readonly name: string
  readonly role: string
  readonly instructions: string
  readonly face: Face
  readonly model: AgentModel
}

export type MakeAgentPlan =
  | { readonly kind: "refused"; readonly reason: string }
  /** `detail` is the whole change in words, for the card. It cuts no value. */
  | { readonly kind: "request"; readonly create: MakeAgentRequest; readonly detail: string }

const accountName = (accounts: readonly SettingsAccount[], id: string) =>
  accounts.find((a) => a.id === id)?.name ?? "not connected"

/** The whole new agent in words. The card shows it, so the user reads every value. */
export const describeMakeAgent = (
  create: MakeAgentRequest,
  accounts: readonly SettingsAccount[],
): string =>
  [
    `Make the agent "${create.name}".`,
    `Role line: ${create.role || "(none)"}`,
    `Model: ${create.model.model} on the account "${accountName(accounts, create.model.accountId)}", effort: ${create.model.effort ?? "default"}`,
    `Face: shape ${create.face.shape + 1}, hue ${create.face.hue + 1}`,
    "Instructions:",
    create.instructions || "(none)",
  ].join("\n")

/** What "Read an agent" gives (spec 036): the fields a manage tool may change, in full. */
export const describeAgent = (
  agent: {
    readonly name: string
    readonly role: string
    readonly instructions: string
    readonly face: Face
    readonly model: AgentModel | null
  },
  accounts: readonly SettingsAccount[],
): string =>
  [
    `Agent "${agent.name}"`,
    `- role: ${agent.role || "(none)"}`,
    agent.model
      ? `- model: ${agent.model.model} on the account "${accountName(accounts, agent.model.accountId)}", effort: ${agent.model.effort ?? "default"}`
      : "- model: none",
    `- face: shape ${agent.face.shape + 1}, hue ${agent.face.hue + 1}`,
    "- instructions:",
    agent.instructions || "(none)",
  ].join("\n")

/**
 * Plans a call of "Make an agent" (spec 036). It reuses the checks of the settings tool, so a name,
 * a role line, a face and a model in loose words follow the same rules as a change of the agent
 * itself (spec 002). A call that fails a check makes no request. `nameTaken` tells whether an
 * agent on the server has the name. `effortsOf` gives the effort levels of a model of an account.
 */
export const planMakeAgent = (
  args: Readonly<Record<string, unknown>>,
  accounts: readonly SettingsAccount[],
  nameTaken: (name: string) => boolean,
  effortsOf: (accountId: string, model: string) => readonly string[],
): MakeAgentPlan => {
  const refuse = (reason: string): MakeAgentPlan => ({
    kind: "refused",
    reason: `Nothing made. ${reason}`,
  })
  const extra = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key]) => key)
    .filter((key) => !(MAKE_AGENT_ARGS as readonly string[]).includes(key))
  if (extra.length > 0)
    return refuse(
      `A new agent has no field ${extra.join(", ")}. It takes: ${MAKE_AGENT_ARGS.join(", ")}. The user sets the permission level, the workspace and every other field in the profile.`,
    )
  const name = typeof args.name === "string" ? args.name.trim() : ""
  if (!name) return refuse("Give a name for the new agent.")

  // A blank agent: every value that the call gives is a change from nothing.
  const blank: SettingsCurrent = {
    name: "",
    role: "",
    instructions: "",
    face: faceFromName(name),
    model: null,
    app: defaultSettings,
  }
  const plan = planSettings(args, blank, accounts, nameTaken, effortsOf)
  if (plan.kind === "refused") return refuse(plan.reason.replace(/^Nothing changed\.\s*/, ""))
  if (plan.kind !== "changes") return refuse("Give a name for the new agent.")

  const change = <F extends AgentSettingField>(field: F) =>
    plan.changes.find((c): c is SettingChange & { field: F } => c.field === field)?.after
  const picked = change("model") as AgentModel | undefined
  if (!picked)
    return refuse(
      [
        "Name a model for the new agent. The connected models:",
        ...listModels(
          accounts.flatMap((a) =>
            a.models.map((model) => ({ accountId: a.id, accountName: a.name, model })),
          ),
        ),
      ].join("\n"),
    )
  // The effort starts at the middle level, as in the form of a new agent, unless the call gives one.
  const effort =
    typeof args.effort === "string"
      ? picked.effort
      : settledEffort(null, effortsOf(picked.accountId, picked.model), NEW_AGENT_EFFORT)
  const create: MakeAgentRequest = {
    name,
    role: (change("role") as string | undefined) ?? "",
    instructions: (change("instructions") as string | undefined) ?? "",
    face: (change("face") as Face | undefined) ?? blank.face,
    model: { ...picked, effort },
  }
  return { kind: "request", create, detail: describeMakeAgent(create, accounts) }
}
