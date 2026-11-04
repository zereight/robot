import {
  type BaselineReason,
  botListWins,
  callMayStart,
  checkCall,
  checkTeamsLink,
  emptyTeamsFields,
  emptyTeamsView,
  holdsChatTitle,
  markAllRead,
  newReadSet,
  patchTouchesLocked,
  readGap,
  recentCalls,
  senderOfMessage,
  TEAMS_CONNECT_MAX_MS,
  TEAMS_INPUT_MAX,
  TEAMS_LOOK_AGAIN_MS,
  TEAMS_READ_MS,
  type TeamsChatMatch,
  type TeamsChatOpened,
  type TeamsFields,
  type TeamsLinkView,
  type TeamsLogEvent,
  type TeamsLook,
  type TeamsMessage,
  type TeamsPatch,
  type TeamsState,
  takeUnread,
  tidyTeamsFields,
} from "@robot/shared"
import { Cause, Context, Effect, Layer } from "effect"
import { BrowserProfiles } from "./BrowserProfiles.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { appendLog, pruneLog } from "./logs.ts"
import type { PageBounds } from "./Platform.ts"
import { Platform } from "./Platform.ts"
import { type Clock, realClock } from "./silence.ts"

interface Row {
  target_kind: string | null
  target_id: string | null
  chat_title: string
  chat_kind: string
  allow_list: string
  bot_list: string
  call_text: string
  marker: string
  enabled: number
  signed_in: number
  last_read_at: number | null
}

export interface TeamsLinkService {
  /** The link as the window sees it. */
  readonly view: Effect.Effect<TeamsLinkView>
  /** "Set up": makes the link, with an empty form and the switch off. Does nothing if it exists. */
  readonly setup: Effect.Effect<TeamsLinkView>
  /**
   * Changes fields of the form. The target, the chat title, the kind of chat and the marker change
   * only while the switch is off. The lists and the call text change at any time.
   */
  update(patch: TeamsPatch): Effect.Effect<TeamsLinkView, AppError>
  /**
   * The switch. Turning it on checks the form: when something is missing, the switch stays off and
   * the view lists the reasons. Turning it off stops the link and closes the Teams page.
   */
  setEnabled(enabled: boolean): Effect.Effect<TeamsLinkView, AppError>
  /** "Show the Teams page" and "Sign in to Teams": the page opens, hidden until it is placed. */
  readonly showPage: Effect.Effect<TeamsLinkView, AppError>
  /** "Hide the Teams page". With the switch off, the page closes. */
  readonly hidePage: Effect.Effect<TeamsLinkView>
  /** The window says where the page shows. Only a page that the user asked to see shows. */
  place(bounds: PageBounds | undefined): Effect.Effect<void>
  /** "Use this chat": reads the title of the open chat and puts it in the field "Chat title". */
  readonly useChat: Effect.Effect<TeamsLinkView, AppError>
  /** "Sign out of Teams": deletes the saved sign-in and turns the link off. */
  readonly signOut: Effect.Effect<TeamsLinkView, AppError>
  /** "Remove link": deletes the link and the sign-in profile. */
  readonly remove: Effect.Effect<TeamsLinkView, AppError>
}

/** Time of a save of the last read to the database, at most. The screen has the exact time. */
const SAVE_READ_MS = 30_000

/** The link log keeps 90 days (spec 014). */
const LOG_KEEP_MS = 90 * 24 * 3_600_000
const LOG_PRUNE_EVERY_MS = 24 * 3_600_000

/**
 * The Teams link (spec 028): the form, the sign-in, the switch and the states (S101), and the
 * calls (S102). While the switch is on, the loop reads the new messages of the chat every 3
 * seconds, applies "Who may call" to each one, and gives a call to the agent or the channel of the
 * link as work. The link writes nothing to Teams in these slices: the answers and the outbox come
 * with the next slice.
 *
 * The link belongs to this computer and this profile. Sync does not carry it, an export does not
 * hold it, and a linked device never sees it.
 */
export class TeamsLink extends Context.Service<TeamsLink, TeamsLinkService>()(
  "robot/main/TeamsLink",
) {
  static readonly layer = (options: { clock?: Clock } = {}) =>
    Layer.effect(
      TeamsLink,
      Effect.gen(function* () {
        const db = yield* Database
        const bus = yield* EventBus
        const platform = yield* Platform
        const profiles = yield* BrowserProfiles
        const chat = yield* Chat
        const channels = yield* Channels
        const clock = options.clock ?? realClock
        const surface = platform.teams()

        // ----------------------------------------------------------------- What is in memory
        const run = {
          state: "off" as TeamsState,
          chat: null as TeamsChatMatch | null,
          /** When Connecting began. */
          since: 0,
          /** The next time the loop looks at the page. */
          nextAt: 0,
          /** The next time the setup watch looks (switch off, page shown). */
          watchAt: 0,
          lastReadAt: null as number | null,
          lastSavedAt: 0,
          pageShown: false,
          /** Counts each start and each stop, so that a late answer of an old run is dropped. */
          generation: 0,
          busy: false,
          /** The messages that the app has read. A message is read once (spec 028). */
          readSet: newReadSet(),
          /** The next read marks every message as read and answers none (a baseline read). */
          baseline: "start" as BaselineReason | null,
          /** When the last read finished. Null before the first read of a run. */
          lastFinishedAt: null as number | null,
          /** When the calls of the last minute started work. */
          callStarts: [] as number[],
        }

        // ----------------------------------------------------------------- The link log
        let lastPrune = 0
        /**
         * One record in the link log (spec 014): the time, the event, the reason and the place. It
         * holds no text of a message and no name of a sender.
         */
        const record = (event: TeamsLogEvent, reason?: string) => {
          const now = clock.now()
          if (now - lastPrune >= LOG_PRUNE_EVERY_MS) {
            lastPrune = now
            pruneLog(platform.dataDir, "teams", LOG_KEEP_MS, now)
          }
          const r = row()
          appendLog(platform.dataDir, "teams", {
            time: new Date(now).toISOString(),
            event,
            ...(reason ? { reason } : {}),
            ...(r?.target_kind && r.target_id ? { place: `${r.target_kind}:${r.target_id}` } : {}),
          })
        }

        // ----------------------------------------------------------------- The row
        const row = () => db.get<Row>("SELECT * FROM teams_link WHERE id = 1")
        const names = (json: string): string[] => {
          try {
            const parsed: unknown = JSON.parse(json)
            return Array.isArray(parsed)
              ? parsed.filter((n): n is string => typeof n === "string")
              : []
          } catch {
            return []
          }
        }
        const fieldsOf = (r: Row): TeamsFields => ({
          targetKind:
            r.target_kind === "agent" || r.target_kind === "channel" ? r.target_kind : null,
          targetId: r.target_id,
          chatTitle: r.chat_title,
          chatKind: r.chat_kind === "group" ? "group" : "person",
          allow: names(r.allow_list),
          bots: names(r.bot_list),
          callText: r.call_text,
          marker: r.marker,
        })
        /** The agent or channel of the link exists, and an agent is not archived. */
        const targetFound = (fields: TeamsFields) => {
          if (fields.targetKind === null || fields.targetId === null) return false
          return fields.targetKind === "agent"
            ? db.get(
                "SELECT 1 AS x FROM agent WHERE id = ? AND archived_at IS NULL",
                fields.targetId,
              ) !== undefined
            : db.get("SELECT 1 AS x FROM channel WHERE id = ?", fields.targetId) !== undefined
        }
        const save = (patch: Record<string, string | number | null>) => {
          const keys = Object.keys(patch)
          if (keys.length === 0) return
          db.run(
            `UPDATE teams_link SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = 1`,
            ...keys.map((k) => patch[k] ?? null),
          )
        }

        const viewOf = (): TeamsLinkView => {
          const r = row()
          const signInProfileId = signInProfile()
          if (!r) return { ...emptyTeamsView, signInProfileId }
          const fields = fieldsOf(r)
          const enabled = r.enabled === 1
          return {
            exists: true,
            fields,
            enabled,
            state: enabled ? run.state : "off",
            chat: enabled && run.state === "chatNotFound" ? run.chat : null,
            signedIn: r.signed_in === 1,
            lastReadAt: run.lastReadAt,
            pageShown: run.pageShown,
            problems: checkTeamsLink(fields, {
              signedIn: r.signed_in === 1,
              targetFound: targetFound(fields),
            }),
            botListWins: botListWins(fields.allow, fields.bots),
            signInProfileId,
          }
        }
        const changed = () => bus.emit("teams.changed", {})
        /** The id of the sign-in profile, or null before the app made it. */
        const signInProfile = () =>
          db.get<{ id: string }>("SELECT id FROM browser_profile WHERE purpose = 'teams'")?.id ??
          null

        // ----------------------------------------------------------------- The state
        const setState = (state: TeamsState, chat: TeamsChatMatch | null = null) => {
          const same = run.state === state && run.chat === chat
          run.state = state
          run.chat = chat
          return !same
        }
        const setSignedIn = (signedIn: boolean) => {
          const r = row()
          if (r && (r.signed_in === 1) !== signedIn) save({ signed_in: signedIn ? 1 : 0 })
        }
        const noteRead = (now: number) => {
          run.lastReadAt = now
          if (now - run.lastSavedAt >= SAVE_READ_MS) {
            run.lastSavedAt = now
            save({ last_read_at: now })
          }
        }

        /** The link starts: Connecting, and the first look at once. */
        const start = () => {
          const now = clock.now()
          run.generation++
          run.readSet = newReadSet()
          run.baseline = "start"
          run.lastFinishedAt = null
          run.callStarts = []
          setState("connecting")
          run.since = now
          run.nextAt = now
          changed()
          void tick()
        }
        /** The link stops: the state is Off and the Teams page closes. */
        const stop = () => {
          run.generation++
          run.readSet = newReadSet()
          run.lastFinishedAt = null
          setState("off")
          run.pageShown = false
          surface.place(undefined)
          surface.allowUserInput(false)
          surface.close()
        }

        // ----------------------------------------------------------------- The loop
        type Seen =
          | Exclude<TeamsLook, { kind: "teams" }>
          | { kind: "chat"; opened: TeamsChatOpened }
          /** The user looks at another chat in the page; the link does not move it. */
          | { kind: "elsewhere" }

        const guarded = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
          try {
            return await work()
          } catch {
            return undefined
          }
        }

        /** Looks at the page, and opens the linked chat when the page shows Teams. */
        const observe = async (r: Row): Promise<Seen> => {
          const look = (await guarded(() => surface.look())) ?? ({ kind: "unreadable" } as const)
          if (look.kind !== "teams") return look
          const holds = look.openTitle !== null && holdsChatTitle(look.openTitle, r.chat_title)
          // The chat is open already: one look is enough while the link is on.
          if (run.state === "on" && look.openTitle !== null && holds)
            return { kind: "chat", opened: { kind: "opened", title: look.openTitle } }
          // The user shows the page and looks at another chat: the link does not take it away.
          if (run.state === "on" && run.pageShown) return { kind: "elsewhere" }
          const opened = await guarded(() => surface.openChat(r.chat_title))
          return opened ? { kind: "chat", opened } : { kind: "unreadable" }
        }

        /** Moves the state by what the page showed. */
        const apply = (seen: Seen, now: number) => {
          switch (seen.kind) {
            case "offline":
              setState("offline")
              // The first read after Offline is a baseline read (spec 028, "Starts and gaps").
              run.baseline ??= "offline"
              run.nextAt = now + TEAMS_LOOK_AGAIN_MS
              break
            case "signIn":
              setSignedIn(false)
              setState("signedOut")
              // So is the first read after a sign-in that follows Signed out.
              run.baseline ??= "signed_out"
              // The loop goes on at the pace of a read: it must see the sign-in at once.
              run.nextAt = now + TEAMS_READ_MS
              break
            case "unreadable":
              // A page that cannot be read leaves the state as it is. The next slice counts the
              // failed reads for the pause.
              run.nextAt =
                now +
                (run.state === "offline" || run.state === "chatNotFound"
                  ? TEAMS_LOOK_AGAIN_MS
                  : TEAMS_READ_MS)
              break
            case "elsewhere":
              setSignedIn(true)
              run.nextAt = now + TEAMS_READ_MS
              break
            case "chat":
              setSignedIn(true)
              if (seen.opened.kind === "opened") {
                setState("on")
                run.nextAt = now + TEAMS_READ_MS
              } else {
                setState("chatNotFound", seen.opened.kind)
                run.nextAt = now + TEAMS_LOOK_AGAIN_MS
              }
              break
          }
        }

        /** The target is archived or deleted: nothing runs, and the Teams page closes. */
        const targetGone = () => {
          if (!setState("targetMissing")) return
          surface.place(undefined)
          surface.close()
          run.pageShown = false
          changed()
        }

        const loopStep = async (r: Row) => {
          const now = clock.now()
          const fields = fieldsOf(r)
          if (!targetFound(fields)) return targetGone()
          if (run.state === "targetMissing") {
            // The agent came back (restored): the link starts again, with a baseline read.
            run.generation++
            run.baseline = "start"
            run.lastFinishedAt = null
            setState("connecting")
            run.since = now
            run.nextAt = now
            changed()
          }
          if (now < run.nextAt) return
          const generation = run.generation
          const seen = await observe(r)
          // The switch was turned off or on again while the page was read: the answer is old.
          if (generation !== run.generation) return
          const before = `${run.state}|${run.chat}|${run.lastReadAt}`
          apply(seen, clock.now())
          if (seen.kind === "chat" && seen.opened.kind === "opened") await readStep(generation)
          if (before !== `${run.state}|${run.chat}|${run.lastReadAt}`) changed()
        }

        // ----------------------------------------------------------------- The calls (S102)
        /** Gives a call to the agent or the channel of the link. Gives the failure code, or null. */
        const dispatch = async (fields: TeamsFields, text: string, sender: string) => {
          if (fields.targetId === null) return "target_missing"
          const teams = { kind: "teams" } as const
          const work: Effect.Effect<void, AppError> =
            fields.targetKind === "channel"
              ? Effect.asVoid(
                  channels.send(fields.targetId, text, null, {
                    outside: teams,
                    teamsSender: sender,
                  }),
                )
              : Effect.asVoid(
                  chat.send(
                    { agentId: fields.targetId, text, replyTo: null },
                    {
                      source: "teams",
                      sourceId: fields.targetId,
                      starter: "program",
                      outside: teams,
                      teamsSender: sender,
                    },
                  ),
                )
          const exit = await Effect.runPromiseExit(work)
          if (exit._tag === "Success") return null
          const failure = Cause.squash(exit.cause)
          return failure instanceof AppError ? failure.code : "error"
        }

        /** One new message: "Who may call", the limit of calls, and then the work. */
        const handle = async (message: TeamsMessage, fields: TeamsFields, generation: number) => {
          const call = checkCall(message, fields)
          if (!call.ok) return record("call_refused", call.reason)
          const now = clock.now()
          if (!callMayStart(run.callStarts, now)) return record("call_over_limit")
          if (generation !== run.generation) return
          const failed = await dispatch(fields, call.text, senderOfMessage(message.sender))
          if (failed === "tasks_full") return record("queue_full")
          if (failed) return record("target_failed", failed)
          run.callStarts = [...recentCalls(run.callStarts, now), now]
          record("call_started")
        }

        /**
         * Reads the new messages of the open chat and handles them in the order that the chat shows
         * them (spec 028, "Run"). A baseline read marks every message as read and answers none.
         */
        const readStep = async (generation: number) => {
          const read = await guarded(() => surface.readMessages())
          if (generation !== run.generation) return
          const r = row()
          if (!r) return
          if (r.enabled !== 1) return
          // The user looks at another chat, or the page cannot be read: this read did not finish.
          const fields = fieldsOf(r)
          if (!read || read.openTitle === null || !holdsChatTitle(read.openTitle, fields.chatTitle))
            return
          const now = clock.now()
          // More than 2 minutes since the last finished read: the computer slept, or the page could
          // not be read. The messages of that time get no answer.
          const gap = readGap(run.lastFinishedAt, now)
          if (gap) run.baseline ??= "gap"
          if (run.baseline !== null) {
            const reason = run.baseline
            run.baseline = null
            // After a gap the unread calls are counted, so the next slice can tell the chat about
            // them. Every message counts as read after this.
            let skipped: TeamsMessage[] = []
            if (gap) skipped = takeUnread(run.readSet, read.messages)
            else markAllRead(run.readSet, read.messages)
            record("baseline", reason)
            // The line for Teams about a call that the gap skipped comes with the next slice. The
            // link log records that there was one.
            if (gap && skipped.some((m) => checkCall(m, fields).ok)) record("gap_skipped_call")
          } else {
            for (const message of takeUnread(run.readSet, read.messages)) {
              // The switch was turned off, or the link started again, while a call was handled.
              if (generation !== run.generation) return
              await handle(message, fieldsOf(row() ?? r), generation)
            }
          }
          if (generation !== run.generation) return
          run.lastFinishedAt = clock.now()
          noteRead(run.lastFinishedAt)
        }

        /** With the switch off, a page that the user shows is watched for the sign-in only. */
        const watchStep = async () => {
          const now = clock.now()
          if (now < run.watchAt) return
          run.watchAt = now + TEAMS_READ_MS
          const look = await guarded(() => surface.look())
          if (!look || !row()) return
          if (look.kind === "signIn") setSignedIn(false)
          else if (look.kind === "teams") setSignedIn(true)
          else return
          changed()
        }

        /** The wait of Connecting ends after 60 seconds, also when a read is slow. */
        const connectTimeout = (now: number) => {
          if (run.state !== "connecting" || now - run.since < TEAMS_CONNECT_MAX_MS) return false
          // The page showed nothing that fits: Teams cannot be reached.
          setState("offline")
          run.nextAt = now + TEAMS_LOOK_AGAIN_MS
          changed()
          return true
        }

        const tick = async () => {
          const r = row()
          if (!r) return
          const enabled = r.enabled === 1
          if (enabled) connectTimeout(clock.now())
          if (run.busy) return
          if (!enabled && !run.pageShown) return
          run.busy = true
          try {
            if (enabled) await loopStep(r)
            else await watchStep()
          } catch {
            // A look that fails is not a state. The next look tries again.
          } finally {
            run.busy = false
          }
        }

        // ----------------------------------------------------------------- Start and stop
        const known = signInProfile()
        if (known) platform.setTeamsProfile(known)
        const first = row()
        run.lastReadAt = first?.last_read_at ?? null
        run.lastSavedAt = run.lastReadAt ?? 0
        // After a restart a link that is on starts again: Connecting, then the state that fits.
        if (first?.enabled === 1) {
          run.baseline = "start"
          run.state = "connecting"
          run.since = clock.now()
          run.nextAt = clock.now()
        }
        const stopClock = clock.every(1000, () => void tick())
        yield* Effect.addFinalizer(() => Effect.sync(stopClock))
        if (first?.enabled === 1) void tick()

        // An agent or a channel that goes, or comes back, changes the state at once. A deleted
        // channel only says that the list of places changed.
        bus.tap((event) => {
          if (
            event === "agents.changed" ||
            event === "channels.changed" ||
            event === "places.changed"
          )
            void tick()
        })

        // ----------------------------------------------------------------- The service
        const needRow = () => {
          const r = row()
          return r ? Effect.succeed(r) : Effect.fail(new AppError({ code: "teams_not_set_up" }))
        }

        const ensureProfile = Effect.gen(function* () {
          const profile = yield* profiles.teamsProfile
          platform.setTeamsProfile(profile.id)
          return profile
        })

        return TeamsLink.of({
          view: Effect.sync(viewOf),

          setup: Effect.sync(() => {
            if (!row()) {
              db.run(
                "INSERT INTO teams_link (id, chat_kind, marker) VALUES (1, ?, ?)",
                emptyTeamsFields.chatKind,
                emptyTeamsFields.marker,
              )
              changed()
            }
            return viewOf()
          }),

          update: Effect.fn("TeamsLink.update")(function* (patch: TeamsPatch) {
            const r = yield* needRow()
            const now = fieldsOf(r)
            if (r.enabled === 1 && patchTouchesLocked(patch, now))
              return yield* new AppError({ code: "teams_locked" })
            if ("targetId" in patch && patch.targetId !== null && patch.targetId !== undefined) {
              const kind = patch.targetKind ?? now.targetKind
              if (
                kind === null ||
                !targetFound({ ...now, targetKind: kind, targetId: patch.targetId })
              )
                return yield* new AppError({ code: "teams_target_not_found" })
            }
            const next = tidyTeamsFields({
              ...now,
              ...(patch.targetKind !== undefined ? { targetKind: patch.targetKind } : {}),
              ...(patch.targetId !== undefined ? { targetId: patch.targetId } : {}),
              ...(patch.chatTitle !== undefined ? { chatTitle: patch.chatTitle } : {}),
              ...(patch.chatKind !== undefined ? { chatKind: patch.chatKind } : {}),
              ...(patch.allow !== undefined ? { allow: patch.allow } : {}),
              ...(patch.bots !== undefined ? { bots: patch.bots } : {}),
              ...(patch.callText !== undefined ? { callText: patch.callText } : {}),
              ...(patch.marker !== undefined ? { marker: patch.marker } : {}),
            })
            // A new kind of target drops the old id: an agent id is not a channel id.
            const kindChanged =
              patch.targetKind !== undefined && patch.targetKind !== now.targetKind
            const targetId = kindChanged && patch.targetId === undefined ? null : next.targetId
            save({
              target_kind: next.targetKind,
              target_id: targetId,
              chat_title: next.chatTitle,
              chat_kind: next.chatKind,
              allow_list: JSON.stringify(next.allow),
              bot_list: JSON.stringify(next.bots),
              call_text: next.callText,
              marker: next.marker,
            })
            changed()
            return viewOf()
          }),

          setEnabled: Effect.fn("TeamsLink.setEnabled")(function* (enabled: boolean) {
            const r = yield* needRow()
            if (!enabled) {
              if (r.enabled === 1 || run.pageShown) {
                save({ enabled: 0 })
                stop()
                changed()
              }
              return viewOf()
            }
            if (r.enabled === 1) return viewOf()
            const view = viewOf()
            // The switch refuses with the reasons. It stays off.
            if (view.problems.length > 0) return view
            save({ enabled: 1 })
            start()
            return viewOf()
          }),

          showPage: Effect.fn("TeamsLink.showPage")(function* () {
            yield* needRow()
            yield* ensureProfile
            run.pageShown = true
            run.watchAt = 0
            changed()
            // The page opens now, so the window can place it at once. A page that cannot load
            // is a state, not a failure of this call.
            const look = yield* Effect.promise(() => guarded(() => surface.look()))
            if (look?.kind === "signIn") setSignedIn(false)
            else if (look?.kind === "teams") setSignedIn(true)
            surface.allowUserInput(true)
            changed()
            return viewOf()
          })(),

          hidePage: Effect.sync(() => {
            if (run.pageShown) {
              run.pageShown = false
              surface.place(undefined)
              surface.allowUserInput(false)
              // With the switch off, no Teams page runs.
              if (row()?.enabled !== 1) surface.close()
              changed()
            }
            return viewOf()
          }),

          place: (bounds) =>
            Effect.sync(() => {
              if (run.pageShown) surface.place(bounds)
              else surface.place(undefined)
            }),

          useChat: Effect.fn("TeamsLink.useChat")(function* () {
            const r = yield* needRow()
            if (!surface.isOpen()) return yield* new AppError({ code: "teams_page_closed" })
            const look = yield* Effect.promise(() => guarded(() => surface.look()))
            if (look?.kind === "signIn") {
              setSignedIn(false)
              changed()
              return yield* new AppError({ code: "teams_signed_out" })
            }
            if (look?.kind === "offline") return yield* new AppError({ code: "teams_offline" })
            if (look?.kind !== "teams") return yield* new AppError({ code: "teams_unreadable" })
            setSignedIn(true)
            if (look.openTitle === null) return yield* new AppError({ code: "teams_no_chat_open" })
            if (r.enabled === 1) return yield* new AppError({ code: "teams_locked" })
            save({ chat_title: look.openTitle.slice(0, TEAMS_INPUT_MAX) })
            changed()
            return viewOf()
          })(),

          signOut: Effect.fn("TeamsLink.signOut")(function* () {
            yield* needRow()
            // The page closes first, so that nothing holds the saved data while it is deleted.
            save({ enabled: 0, signed_in: 0 })
            stop()
            yield* profiles.clearTeamsSignIn
            changed()
            return viewOf()
          })(),

          remove: Effect.fn("TeamsLink.remove")(function* () {
            stop()
            db.run("DELETE FROM teams_link WHERE id = 1")
            run.lastReadAt = null
            run.lastSavedAt = 0
            yield* profiles.removeTeamsProfile
            platform.setTeamsProfile(undefined)
            changed()
            return viewOf()
          })(),
        })
      }),
    )
}
