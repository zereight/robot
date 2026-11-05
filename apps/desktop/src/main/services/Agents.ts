import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type Agent,
  type AgentCreate,
  type AgentModel,
  type AgentPatch,
  copyName,
  DEFAULT_PERMISSION,
  faceFromName,
  type InstructionSource,
  isSensitiveLabel,
  nameKey,
  type PermissionLevel,
  parsePlaceOutside,
  sameModelChoice,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Activity } from "./Activity.ts"
import { CurrentActor } from "./actor.ts"
import { releaseSkills } from "./agentSkills.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { recordVersion } from "./instructionHistory.ts"
import { ModelHolds } from "./ModelHolds.ts"
import { Platform } from "./Platform.ts"
import { Providers } from "./Providers.ts"
import { Sections } from "./Sections.ts"
import { SettingsStore } from "./Settings.ts"

interface AgentRow {
  id: string
  server_id: string
  name: string
  role: string
  instructions: string
  face_shape: number
  face_hue: number
  face_image: string | null
  model_account_id: string | null
  model_name: string | null
  model_effort: string | null
  backup_account_id: string | null
  backup_model: string | null
  backup_effort: string | null
  workspace: string
  permission: PermissionLevel
  memory_enabled: number
  knowledge_enabled: number
  read_handbook: number
  is_main: number
  place_section_id: string | null
  archived_at: number | null
  created_at: number
  changed_by: string | null
  changed_at: number | null
  sensitive_mark: string | null
  outside_mark: string | null
}

export interface AgentsService {
  list(serverId: string, archived: boolean): Effect.Effect<readonly Agent[]>
  get(id: string): Effect.Effect<Agent, AppError>
  create(input: AgentCreate): Effect.Effect<Agent, AppError>
  /**
   * Changes the fields of an agent. A change of the instructions is kept in the history; `source`
   * says where it came from. By default it is the profile, or a linked device when one asks.
   */
  update(
    id: string,
    patch: AgentPatch,
    options?: { readonly source?: InstructionSource },
  ): Effect.Effect<Agent, AppError>
  duplicate(id: string, suffix: string): Effect.Effect<Agent, AppError>
  archive(id: string): Effect.Effect<Agent, AppError>
  restore(id: string): Effect.Effect<Agent, AppError>
  /**
   * "Use the main model now" (spec 006): ends the hold of the main model of the agent. The next
   * turn tries the main model. Nothing changes when no hold lasts.
   */
  useMain(id: string): Effect.Effect<Agent, AppError>
  remove(id: string): Effect.Effect<void, AppError>
  setFaceImage(id: string, dataUrl: string | null): Effect.Effect<Agent, AppError>
}

const MAX_FACE_IMAGE_BYTES = 1024 * 1024
const faceImagePattern = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/

/** A folder name made from the agent name, with a short unique tail. */
export const workspaceFolderName = (name: string, id: string) => {
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
  return `${slug || "agent"}-${id.slice(0, 6)}`
}

export class Agents extends Context.Service<Agents, AgentsService>()("robot/main/Agents") {
  static readonly layer = Layer.effect(
    Agents,
    Effect.gen(function* () {
      const db = yield* Database
      const platform = yield* Platform
      const settings = yield* SettingsStore
      const bus = yield* EventBus
      const activity = yield* Activity
      const providers = yield* Providers
      const sections = yield* Sections
      const holds = yield* ModelHolds
      const facesDir = join(platform.dataDir, "faces")

      const backupOf = (row: AgentRow): AgentModel | null =>
        row.backup_account_id && row.backup_model
          ? { accountId: row.backup_account_id, model: row.backup_model, effort: row.backup_effort }
          : null

      const toAgent = (row: AgentRow): Agent => {
        const backup = backupOf(row)
        const hold = backup ? holds.active(row.id) : null
        const imagePath = row.face_image ? join(facesDir, row.face_image) : null
        const faceImage =
          imagePath && existsSync(imagePath)
            ? `data:image/png;base64,${readFileSync(imagePath).toString("base64")}`
            : null
        return {
          id: row.id,
          serverId: row.server_id,
          name: row.name,
          role: row.role,
          instructions: row.instructions,
          face: { shape: row.face_shape, hue: row.face_hue },
          faceImage,
          model:
            row.model_account_id && row.model_name
              ? { accountId: row.model_account_id, model: row.model_name, effort: row.model_effort }
              : null,
          // The backup model, and whether it is ready here. The hold of the main model, while the
          // backup takes the turns (spec 006). The hold is a state of this computer (spec 019).
          backupModel: backup,
          ...(backup ? { backupReady: providers.isConnected(backup.accountId) } : {}),
          hold: hold && backup ? { until: hold.until, model: backup } : null,
          workspace: row.workspace,
          section: "agents",
          sectionId: row.place_section_id,
          archived: row.archived_at !== null,
          state: activity.isWorking(row.id)
            ? "working"
            : row.model_account_id && providers.isConnected(row.model_account_id)
              ? "idle"
              : "offline",
          // Why the agent is offline, when its program needs repair or is not installed (006).
          runtimeProblem: row.model_account_id
            ? providers.runtimeProblem(row.model_account_id)
            : null,
          createdAt: row.created_at,
          permission: row.permission,
          memoryEnabled: row.memory_enabled === 1,
          readHandbook: row.read_handbook === 1,
          isMain: row.is_main === 1,
          changedBy:
            row.changed_by !== null && row.changed_at !== null
              ? { by: row.changed_by, at: row.changed_at }
              : null,
          knowledgeEnabled: row.knowledge_enabled === 1,
          sensitive: isSensitiveLabel(row.sensitive_mark) ? row.sensitive_mark : null,
          outside: parsePlaceOutside(row.outside_mark),
        }
      }

      /**
       * The record of the last change: the linked device that asks now, or nothing when the user
       * of this computer changes the agent (spec 012, "Create and change agents").
       */
      const stamp = Effect.gen(function* () {
        const actor = yield* CurrentActor
        return actor
          ? { by: actor.name as string | null, at: Date.now() as number | null }
          : { by: null as string | null, at: null as number | null }
      })

      const findRow = (id: string) =>
        Effect.suspend(() => {
          const row = db.get<AgentRow>("SELECT * FROM agent WHERE id = ?", id)
          return row ? Effect.succeed(row) : Effect.fail(new AppError({ code: "agent_not_found" }))
        })

      const nameTaken = (serverId: string, name: string, exceptId?: string) =>
        db.get(
          "SELECT 1 FROM agent WHERE server_id = ? AND name_key = ? AND id != ?",
          serverId,
          nameKey(name),
          exceptId ?? "",
        ) !== undefined

      const changed = (serverId: string) => {
        bus.emit("agents.changed", { serverId })
        bus.emit("places.changed", { serverId })
      }

      const makeWorkspace = Effect.fn("Agents.makeWorkspace")(function* (name: string, id: string) {
        const current = yield* settings.get
        const root = current.workspaceRoot || platform.defaultWorkspaceRoot
        const dir = join(root, workspaceFolderName(name, id))
        yield* Effect.try({
          try: () => mkdirSync(dir, { recursive: true }),
          catch: (e) => new AppError({ code: "workspace_failed", detail: String(e) }),
        })
        return dir
      })

      /** True when an agent on this account may pick "Ask when unsure" now (spec 007). */
      const unsureAllowed = (accountId: string | null) =>
        Effect.gen(function* () {
          if (!(yield* settings.get).permissionChecks) return false
          return accountId === null || !providers.isRuntime(accountId)
        })

      const insert = Effect.fn("Agents.insert")(function* (input: AgentCreate) {
        const name = input.name.trim()
        if (nameTaken(input.serverId, name))
          return yield* new AppError({ code: "agent_name_taken" })
        const sectionId = yield* sections.check(input.serverId, "agent", input.sectionId ?? null)
        const level = input.permission ?? DEFAULT_PERMISSION
        // "Ask when unsure" needs the switch "Permission checks" and a model of an API provider.
        if (level === "ask_unsure" && !(yield* unsureAllowed(input.model?.accountId ?? null)))
          return yield* new AppError({ code: "unsure_unavailable" })
        // "Read only" needs a mode that the program has itself (spec 007).
        if (
          level === "read_only" &&
          input.model &&
          !(yield* providers.readOnlySupported(input.model.accountId))
        )
          return yield* new AppError({ code: "read_only_unsupported" })
        // The form refuses a backup that is the same as the main choice, and says why (spec 006).
        if (sameModelChoice(input.model ?? null, input.backupModel ?? null))
          return yield* new AppError({ code: "backup_same" })
        const id = randomUUID()
        const workspace = yield* makeWorkspace(name, id)
        const face = input.face ?? faceFromName(name)
        const now = Date.now()
        const by = yield* stamp
        db.run(
          `INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
            model_account_id, model_name, model_effort, backup_account_id, backup_model, backup_effort,
            workspace, section, place_section_id, created_at, updated_at, changed_by, changed_at, permission,
            read_handbook)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agents', ?, ?, ?, ?, ?, ?, ?)`,
          id,
          input.serverId,
          name,
          nameKey(name),
          input.role.trim(),
          input.instructions,
          face.shape,
          face.hue,
          input.model?.accountId ?? null,
          input.model?.model ?? null,
          input.model?.effort ?? null,
          input.backupModel?.accountId ?? null,
          input.backupModel?.model ?? null,
          input.backupModel?.effort ?? null,
          workspace,
          sectionId,
          now,
          now,
          by.by,
          by.at,
          level,
          // The switch "Read the handbook" is on at the start (spec 002).
          input.readHandbook === false ? 0 : 1,
        )
        changed(input.serverId)
        return toAgent(yield* findRow(id))
      })

      const update = Effect.fn("Agents.update")(function* (
        id: string,
        patch: AgentPatch,
        options?: { readonly source?: InstructionSource },
      ) {
        const row = yield* findRow(id)
        const name = patch.name?.trim()
        if (name !== undefined && nameTaken(row.server_id, name, id)) {
          return yield* new AppError({ code: "agent_name_taken" })
        }
        // The level "Read only" needs a mode that the program has itself (spec 007). It is checked
        // when the level is set and when the model changes, whoever asks: this computer or a client.
        const level = patch.permission ?? row.permission
        const accountId =
          patch.model !== undefined ? (patch.model?.accountId ?? null) : row.model_account_id
        // "Ask when unsure" can be picked only with the switch on, for an agent of an API provider
        // (spec 007). An agent that has it already keeps it when its model changes, and when its
        // profile is saved again with the same level: it then works as "Ask for risky steps".
        if (
          patch.permission === "ask_unsure" &&
          row.permission !== "ask_unsure" &&
          !(yield* unsureAllowed(accountId))
        )
          return yield* new AppError({ code: "unsure_unavailable" })
        if (
          level === "read_only" &&
          (patch.permission !== undefined || patch.model !== undefined) &&
          accountId &&
          !(yield* providers.readOnlySupported(accountId))
        )
          return yield* new AppError({ code: "read_only_unsupported" })
        // The backup must differ from the main choice. It is checked when either one changes,
        // whoever asks: this computer, a client, or the settings tool of the agent (spec 006).
        const main: AgentModel | null =
          patch.model !== undefined
            ? patch.model
            : row.model_account_id && row.model_name
              ? { accountId: row.model_account_id, model: row.model_name, effort: row.model_effort }
              : null
        const backup: AgentModel | null =
          patch.backupModel !== undefined ? patch.backupModel : backupOf(row)
        if (
          (patch.model !== undefined || patch.backupModel !== undefined) &&
          sameModelChoice(main, backup)
        )
          return yield* new AppError({ code: "backup_same" })
        // An archived agent is not on the chart, and the root would turn to "You" (spec 029).
        if (patch.isMain === true && row.archived_at !== null)
          return yield* new AppError({ code: "main_agent_archived" })
        const sets: string[] = []
        const values: (string | number | null)[] = []
        const set = (column: string, value: string | number | null) => {
          sets.push(`${column} = ?`)
          values.push(value)
        }
        if (name !== undefined) {
          set("name", name)
          set("name_key", nameKey(name))
        }
        if (patch.role !== undefined) set("role", patch.role.trim())
        if (patch.instructions !== undefined) set("instructions", patch.instructions)
        if (patch.face !== undefined) {
          set("face_shape", patch.face.shape)
          set("face_hue", patch.face.hue)
        }
        if (patch.model !== undefined) {
          set("model_account_id", patch.model?.accountId ?? null)
          set("model_name", patch.model?.model ?? null)
          set("model_effort", patch.model?.effort ?? null)
        }
        if (patch.backupModel !== undefined) {
          set("backup_account_id", patch.backupModel?.accountId ?? null)
          set("backup_model", patch.backupModel?.model ?? null)
          set("backup_effort", patch.backupModel?.effort ?? null)
        }
        if (patch.sectionId !== undefined) {
          set("place_section_id", yield* sections.check(row.server_id, "agent", patch.sectionId))
        }
        if (patch.permission !== undefined) set("permission", patch.permission)
        if (patch.memoryEnabled !== undefined) set("memory_enabled", patch.memoryEnabled ? 1 : 0)
        if (patch.readHandbook !== undefined) set("read_handbook", patch.readHandbook ? 1 : 0)
        if (patch.isMain !== undefined) set("is_main", patch.isMain ? 1 : 0)
        const by = yield* stamp
        set("changed_by", by.by)
        set("changed_at", by.at)
        if (patch.knowledgeEnabled !== undefined)
          set("knowledge_enabled", patch.knowledgeEnabled ? 1 : 0)
        set("updated_at", Date.now())
        // The switch "Main agent" (spec 002, flow 7): at most one agent on a server has it, so the
        // old main agent loses it in the same step as the new one gets it.
        db.transaction(() => {
          if (patch.isMain === true)
            db.run(
              "UPDATE agent SET is_main = 0, updated_at = ? WHERE server_id = ? AND is_main = 1 AND id != ?",
              Date.now(),
              row.server_id,
              id,
            )
          db.run(`UPDATE agent SET ${sets.join(", ")} WHERE id = ?`, ...values, id)
        })
        // The hold is about the main model and the backup of this agent. A new main model is not
        // the one that is held, and with no backup nothing takes the turns (spec 006).
        const mainMoved =
          patch.model !== undefined &&
          (patch.model?.accountId !== row.model_account_id || patch.model?.model !== row.model_name)
        if (mainMoved || (patch.backupModel !== undefined && patch.backupModel === null))
          holds.clear(id)
        if (patch.instructions !== undefined)
          recordVersion(
            db,
            id,
            row.instructions,
            patch.instructions,
            options?.source ?? (by.by !== null ? "device" : "profile"),
          )
        changed(row.server_id)
        return toAgent(yield* findRow(id))
      })

      const setArchived = (archived: boolean) =>
        Effect.fn("Agents.setArchived")(function* (id: string) {
          const row = yield* findRow(id)
          const by = yield* stamp
          db.run(
            "UPDATE agent SET archived_at = ?, updated_at = ?, changed_by = ?, changed_at = ? WHERE id = ?",
            archived ? Date.now() : null,
            Date.now(),
            by.by,
            by.at,
            id,
          )
          changed(row.server_id)
          return toAgent(yield* findRow(id))
        })

      const remove = Effect.fn("Agents.remove")(function* (id: string) {
        const row = yield* findRow(id)
        if (row.archived_at === null) return yield* new AppError({ code: "agent_not_archived" })
        if (activity.isWorking(id)) return yield* new AppError({ code: "agent_working" })
        yield* Effect.tryPromise({
          try: () => platform.trash(row.workspace),
          catch: (e) => new AppError({ code: "trash_failed", detail: String(e) }),
        })
        if (row.face_image) rmSync(join(facesDir, row.face_image), { force: true })
        // The agent leaves the list of every skill, and a skill that was only for it goes too
        // (spec 017). Both happen in one step with the delete of the agent.
        const skills = db.transaction(() => {
          const released = releaseSkills(db, id)
          db.run("DELETE FROM agent WHERE id = ?", id)
          return released
        })
        if (skills.deleted + skills.shortened > 0)
          bus.emit("skills.changed", { serverId: row.server_id })
        changed(row.server_id)
      })

      const setFaceImage = Effect.fn("Agents.setFaceImage")(function* (
        id: string,
        dataUrl: string | null,
      ) {
        const row = yield* findRow(id)
        if (row.face_image) rmSync(join(facesDir, row.face_image), { force: true })
        let file: string | null = null
        if (dataUrl !== null) {
          const match = faceImagePattern.exec(dataUrl)
          const bytes = match?.[2] ? Buffer.from(match[2], "base64") : undefined
          if (!bytes || bytes.length === 0)
            return yield* new AppError({ code: "face_image_invalid" })
          if (bytes.length > MAX_FACE_IMAGE_BYTES) {
            return yield* new AppError({ code: "face_image_too_large" })
          }
          mkdirSync(facesDir, { recursive: true })
          file = `${id}-${Date.now()}.png`
          writeFileSync(join(facesDir, file), bytes)
        }
        const by = yield* stamp
        db.run(
          "UPDATE agent SET face_image = ?, updated_at = ?, changed_by = ?, changed_at = ? WHERE id = ?",
          file,
          Date.now(),
          by.by,
          by.at,
          id,
        )
        changed(row.server_id)
        return toAgent(yield* findRow(id))
      })

      return Agents.of({
        list: (serverId, archived) =>
          Effect.sync(() =>
            db
              .all<AgentRow>(
                `SELECT * FROM agent WHERE server_id = ? AND archived_at IS ${archived ? "NOT NULL" : "NULL"}
                 ORDER BY name_key`,
                serverId,
              )
              .map(toAgent),
          ),
        get: (id) => findRow(id).pipe(Effect.map(toAgent)),
        create: insert,
        update,
        duplicate: Effect.fn("Agents.duplicate")(function* (id: string, suffix: string) {
          const row = yield* findRow(id)
          const name = copyName(row.name, suffix, (candidate) =>
            nameTaken(row.server_id, candidate),
          )
          const copy = yield* insert({
            serverId: row.server_id,
            name,
            role: row.role,
            instructions: row.instructions,
            readHandbook: row.read_handbook === 1,
            face: { shape: row.face_shape, hue: row.face_hue },
            model:
              row.model_account_id && row.model_name
                ? {
                    accountId: row.model_account_id,
                    model: row.model_name,
                    effort: row.model_effort,
                  }
                : null,
            backupModel: backupOf(row),
            // The copy joins the section of the original.
            sectionId: row.place_section_id,
          })
          // The copy uses the browser profile of the original: it has the same sign-ins (spec 002).
          const profile = db.get<{ profile_id: string }>(
            "SELECT profile_id FROM agent_browser WHERE agent_id = ?",
            id,
          )?.profile_id
          if (profile) {
            db.run(
              "INSERT INTO agent_browser (agent_id, profile_id) VALUES (?, ?)",
              copy.id,
              profile,
            )
            platform.setBrowserProfile(copy.id, profile)
            bus.emit("browserProfiles.changed", {})
          }
          return copy
        }),
        archive: setArchived(true),
        restore: setArchived(false),
        useMain: Effect.fn("Agents.useMain")(function* (id: string) {
          const row = yield* findRow(id)
          // The hold tells the windows and the linked devices by itself.
          holds.release(id)
          return toAgent(row)
        }),
        remove,
        setFaceImage,
      })
    }),
  )
}
