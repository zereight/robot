import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  type Agent,
  type AgentCreate,
  type AgentPatch,
  copyName,
  faceFromName,
  type InstructionSource,
  nameKey,
  type PermissionLevel,
} from "@robot/shared"
import { Context, Effect, Layer } from "effect"
import { Activity } from "./Activity.ts"
import { CurrentActor } from "./actor.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { recordVersion } from "./instructionHistory.ts"
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
  workspace: string
  permission: PermissionLevel
  memory_enabled: number
  knowledge_enabled: number
  place_section_id: string | null
  archived_at: number | null
  created_at: number
  changed_by: string | null
  changed_at: number | null
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
      const facesDir = join(platform.dataDir, "faces")

      const toAgent = (row: AgentRow): Agent => {
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
          workspace: row.workspace,
          section: "agents",
          sectionId: row.place_section_id,
          archived: row.archived_at !== null,
          state: activity.isWorking(row.id)
            ? "working"
            : row.model_account_id && providers.isConnected(row.model_account_id)
              ? "idle"
              : "offline",
          createdAt: row.created_at,
          permission: row.permission,
          memoryEnabled: row.memory_enabled === 1,
          changedBy:
            row.changed_by !== null && row.changed_at !== null
              ? { by: row.changed_by, at: row.changed_at }
              : null,
          knowledgeEnabled: row.knowledge_enabled === 1,
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

      const insert = Effect.fn("Agents.insert")(function* (input: AgentCreate) {
        const name = input.name.trim()
        if (nameTaken(input.serverId, name))
          return yield* new AppError({ code: "agent_name_taken" })
        const sectionId = yield* sections.check(input.serverId, "agent", input.sectionId ?? null)
        const id = randomUUID()
        const workspace = yield* makeWorkspace(name, id)
        const face = input.face ?? faceFromName(name)
        const now = Date.now()
        const by = yield* stamp
        db.run(
          `INSERT INTO agent (id, server_id, name, name_key, role, instructions, face_shape, face_hue,
            model_account_id, model_name, model_effort, workspace, section, place_section_id,
            created_at, updated_at, changed_by, changed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'agents', ?, ?, ?, ?, ?)`,
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
          workspace,
          sectionId,
          now,
          now,
          by.by,
          by.at,
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
        if (patch.sectionId !== undefined) {
          set("place_section_id", yield* sections.check(row.server_id, "agent", patch.sectionId))
        }
        if (patch.permission !== undefined) set("permission", patch.permission)
        if (patch.memoryEnabled !== undefined) set("memory_enabled", patch.memoryEnabled ? 1 : 0)
        const by = yield* stamp
        set("changed_by", by.by)
        set("changed_at", by.at)
        if (patch.knowledgeEnabled !== undefined)
          set("knowledge_enabled", patch.knowledgeEnabled ? 1 : 0)
        set("updated_at", Date.now())
        db.run(`UPDATE agent SET ${sets.join(", ")} WHERE id = ?`, ...values, id)
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
        db.run("DELETE FROM agent WHERE id = ?", id)
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
          return yield* insert({
            serverId: row.server_id,
            name,
            role: row.role,
            instructions: row.instructions,
            face: { shape: row.face_shape, hue: row.face_hue },
            model:
              row.model_account_id && row.model_name
                ? {
                    accountId: row.model_account_id,
                    model: row.model_name,
                    effort: row.model_effort,
                  }
                : null,
            // The copy joins the section of the original.
            sectionId: row.place_section_id,
          })
        }),
        archive: setArchived(true),
        restore: setArchived(false),
        remove,
        setFaceImage,
      })
    }),
  )
}
