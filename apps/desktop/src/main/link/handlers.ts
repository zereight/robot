import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs"
import { join, sep } from "node:path"
import type { DownloadChunk, DownloadRequest, ServerSummary, UploadChunk } from "@robot/shared"
import { FILE_CHUNK, LINK_PROTOCOL, UPLOAD_PREFIX } from "@robot/shared"
import type { Effect } from "effect"
import { Effect as E } from "effect"
import type { AppServices } from "../layers.ts"
import { Agents } from "../services/Agents.ts"
import { CurrentActor } from "../services/actor.ts"
import { Devices } from "../services/Devices.ts"
import { AppError } from "../services/errors.ts"
import { Platform } from "../services/Platform.ts"
import { Servers } from "../services/Servers.ts"
import { UploadError } from "./uploads.ts"

type LinkHandler = (input: unknown) => Effect.Effect<unknown, AppError, AppServices>

const fromUpload = (error: unknown) =>
  error instanceof UploadError
    ? new AppError({ code: error.code })
    : new AppError({ code: "invalid_input" })

const actorOrFail = E.gen(function* () {
  const actor = yield* CurrentActor
  if (!actor) return yield* new AppError({ code: "not_allowed" })
  return actor
})

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

/**
 * A file of a message that a client asks for. Only a file in the `attachments` folder of the
 * agent counts, and a link that leaves the folder does not.
 */
const readAttachment = (workspace: string, path: string, offset: number): DownloadChunk => {
  const match = /^attachments\/([^/\\]+)$/.exec(path)
  if (!match || match[1] === "." || match[1] === ".." || !Number.isInteger(offset) || offset < 0) {
    throw new AppError({ code: "invalid_input" })
  }
  const dir = join(workspace, "attachments")
  let real: string
  try {
    real = realpathSync(join(dir, match[1] as string))
    if (!real.startsWith(realpathSync(dir) + sep)) throw new Error("outside")
    if (!statSync(real).isFile()) throw new Error("not a file")
  } catch {
    throw new AppError({ code: "file_unreadable" })
  }
  const size = statSync(real).size
  const length = Math.max(0, Math.min(FILE_CHUNK, size - offset))
  const buffer = Buffer.alloc(length)
  const fd = openSync(real, "r")
  try {
    if (length > 0) readSync(fd, buffer, 0, length, offset)
  } finally {
    closeSync(fd)
  }
  return { size, offset, data: buffer.toString("base64"), done: offset + length >= size }
}

/**
 * Requests that exist only on the link between devices. A request that the window also makes is
 * in `rpc.ts`; the server runs those with the device as the actor.
 */
export const linkHandlers: Record<string, LinkHandler> = {
  "server.summary": () =>
    E.gen(function* () {
      const devices = yield* Devices
      const platform = yield* Platform
      const server = yield* Servers.use((s) => s.local)
      return {
        serverId: server.id,
        deviceId: devices.selfId,
        name: devices.deviceName(),
        app: platform.appVersion,
        protocol: LINK_PROTOCOL,
      } satisfies ServerSummary
    }),

  "attachment.upload": (input) =>
    E.gen(function* () {
      const actor = yield* actorOrFail
      const devices = yield* Devices
      if (!isObject(input)) return yield* new AppError({ code: "invalid_input" })
      return yield* E.try({
        try: () => devices.uploads.put(actor.id, input as unknown as UploadChunk),
        catch: fromUpload,
      })
    }),

  "attachment.download": (input) =>
    E.gen(function* () {
      yield* actorOrFail
      if (!isObject(input) || typeof input.agentId !== "string" || typeof input.path !== "string") {
        return yield* new AppError({ code: "invalid_input" })
      }
      const request = input as unknown as DownloadRequest
      const agent = yield* Agents.use((a) => a.get(request.agentId))
      return yield* E.try({
        try: () => readAttachment(agent.workspace, request.path, Number(request.offset)),
        catch: (error) =>
          error instanceof AppError ? error : new AppError({ code: "file_unreadable" }),
      })
    }),
}

/**
 * Runs "send message" for a linked device. A client names its files by the tokens of its uploads;
 * a path is not accepted, so a client cannot make the server copy a file that it did not upload.
 */
export const withUploads = <A, E2, R>(
  actor: { readonly id: string },
  input: unknown,
  run: (input: unknown) => Effect.Effect<A, E2, R>,
): Effect.Effect<A, E2 | AppError, R | Devices> =>
  E.gen(function* () {
    const devices = yield* Devices
    if (!isObject(input) || !Array.isArray(input.files) || input.files.length === 0) {
      return yield* run(input)
    }
    const tokens = input.files as unknown[]
    const paths: string[] = []
    for (const token of tokens) {
      const path =
        typeof token === "string" && token.startsWith(UPLOAD_PREFIX)
          ? devices.uploads.resolve(actor.id, token)
          : undefined
      if (!path) return yield* new AppError({ code: "upload_gone" })
      paths.push(path)
    }
    const result = yield* E.exit(run({ ...input, files: paths }))
    for (const token of tokens) devices.uploads.discard(String(token))
    return yield* result
  })
