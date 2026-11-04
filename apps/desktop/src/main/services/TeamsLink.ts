import {
  afterOffline,
  type BaselineReason,
  botListWins,
  callMayStart,
  checkCall,
  checkTeamsLink,
  countRead,
  countSend,
  cutLineText,
  emptyTeamsFields,
  emptyTeamsView,
  failureReason,
  holdsChatTitle,
  isTeamsPauseReason,
  isTeamsRecordReason,
  type Locale,
  lineText,
  lineWord,
  type MessagePart,
  markAllRead,
  messageFiles,
  messageText,
  newReadSet,
  noFailures,
  type OutboxTiming,
  patchTouchesLocked,
  pickNext,
  readGap,
  recentCalls,
  recentSends,
  recordReasonWord,
  redactSecrets,
  resolveLocale,
  retryDelayMs,
  senderOfMessage,
  sendMayGo,
  sendTooOld,
  splitAnswer,
  type Task,
  TEAMS_CONNECT_MAX_MS,
  TEAMS_HOLD_TRIES,
  TEAMS_INPUT_MAX,
  TEAMS_LOOK_AGAIN_MS,
  TEAMS_OUTBOX_MAX,
  TEAMS_READ_MS,
  TEAMS_RECORDS_MAX,
  type TeamsAttempt,
  type TeamsAttention,
  type TeamsChatMatch,
  type TeamsChatOpened,
  type TeamsFailCounts,
  type TeamsFields,
  type TeamsLine,
  type TeamsLinkView,
  type TeamsLogEvent,
  type TeamsLook,
  type TeamsMessage,
  type TeamsNeed,
  type TeamsPatch,
  type TeamsPauseReason,
  type TeamsRecord,
  type TeamsRecordReason,
  type TeamsState,
  type TeamsTargetKind,
  takeUnread,
  teamsNeed,
  teamsNoticeStep,
  teamsNoticeTitleKey,
  teamsPauseReasonKey,
  tidyTeamsFields,
  tooManyLineMayGo,
  translate,
} from "@robot/shared"
import { Cause, Context, Effect, Layer } from "effect"
import { BrowserProfiles } from "./BrowserProfiles.ts"
import { Channels } from "./Channels.ts"
import { Chat } from "./Chat.ts"
import { Database } from "./Database.ts"
import { DECISION_KEY } from "./Decision.ts"
import { EventBus } from "./EventBus.ts"
import { AppError } from "./errors.ts"
import { appendLog, pruneLog } from "./logs.ts"
import { Notifier } from "./Notifier.ts"
import type { PageBounds } from "./Platform.ts"
import { Platform } from "./Platform.ts"
import { Providers, secretKey } from "./Providers.ts"
import { SavedSecrets } from "./SavedSecrets.ts"
import { Secrets } from "./Secrets.ts"
import { SettingsStore } from "./Settings.ts"
import { type Clock, realClock } from "./silence.ts"
import { Tasks } from "./Tasks.ts"

/** One message in the outbox: a part of an answer that waits to go to Teams (spec 028). */
interface OutboxMessage extends OutboxTiming {
  readonly id: number
  /** The answer that the message belongs to. A wrong chat drops the whole answer. */
  readonly answer: number
  /** The text, with the marker. The secrets are replaced already. */
  readonly text: string
  /** The task whose result this is, or null for a line (a waiting line has none). */
  readonly taskId: string | null
  readonly placeKind: TeamsTargetKind | null
  readonly placeId: string | null
  tries: number
  nextTryAt: number
  /** When the first try failed, or null. A message that failed is dropped one hour later. */
  firstFailedAt: number | null
}

interface RecordRow {
  id: number
  at: number
  reason: string
  place_kind: string | null
  place_id: string | null
  task_id: string | null
}

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
  paused: string | null
  paused_at: number | null
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
  /** "Resume": a paused link starts again with a baseline read (spec 028). */
  readonly resume: Effect.Effect<TeamsLinkView, AppError>
  /**
   * The state that needs the user, for the Today page (spec 021, 028): Signed out or Paused, with
   * the reason of a pause and the time the state began. Null when the link is fine or off.
   */
  readonly attention: Effect.Effect<TeamsAttention | null>
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
 * The Teams link (spec 028): the form, the sign-in, the switch and the states (S101), the calls
 * (S102), the answers and the outbox (S103), and the pause and the notices (S105). While the switch is on, the loop reads the new
 * messages of the chat every 3 seconds, applies "Who may call" to each one, and gives a call to the
 * agent or the channel of the link as work. When work that a message started ends or waits for the
 * user, the link makes an answer, and the outbox sends it in order to the linked chat.
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
        const tasks = yield* Tasks
        const notifier = yield* Notifier
        const settings = yield* SettingsStore
        const providers = yield* Providers
        const secrets = yield* Secrets
        const savedSecrets = yield* SavedSecrets
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
          /** The answers that wait to go to Teams, in the order in which they were made. */
          outbox: [] as OutboxMessage[],
          /** When the messages of the last minute went out. */
          sentAt: [] as number[],
          /** The last time the line "Too many messages" was made, or null. */
          tooManyAt: null as number | null,
          /** The cards (agent and call) that got their waiting line. One line for each card. */
          announced: new Set<string>(),
          nextMessage: 1,
          nextAnswer: 1,
          /** The window was hidden: the loop looks at the page before the next send. */
          loopFirst: false,
          /** The failed reads and the failed tries to send, each in a row (spec 028, S105). */
          fails: noFailures as TeamsFailCounts,
          /** Why the link is paused, or null. The database keeps it too, for a restart. */
          pause: null as TeamsPauseReason | null,
          /** The need (Signed out or Paused) that the last notification was for, or null. */
          noticed: null as TeamsNeed | null,
          /** When the state that needs the user began. */
          needSince: 0,
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
            pauseReason: enabled && run.state === "paused" ? run.pause : null,
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
            records: recordsOf(),
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
          const before = run.state
          run.state = state
          run.chat = chat
          if (run.state !== before) noteNeed(before)
          return !same
        }
        /** The id of this computer as a server. Mutes of a server work for the notice (spec 015). */
        const localServerId = () =>
          db.get<{ id: string }>("SELECT id FROM server WHERE kind = 'local'")?.id ?? ""
        /**
         * The notification "Teams link needs you" (spec 015, 028). It goes out when the state
         * becomes Signed out or Paused, once for each change (`teamsNoticeStep`). It holds the
         * state and, for a pause, the reason. It holds no name and no text of a message, not even
         * the title of the chat. It goes to this computer only.
         */
        const noteNeed = (before: TeamsState) => {
          const step = teamsNoticeStep(run.noticed, run.state)
          run.noticed = step.memory
          if (teamsNeed(run.state) !== null && teamsNeed(before) !== teamsNeed(run.state))
            run.needSince = clock.now()
          if (step.notify === null) return
          const locale = localeNow()
          const reason = run.pause ?? "read"
          notifier.notify({
            kind: "teams_link",
            serverId: localServerId(),
            title: translate(locale, teamsNoticeTitleKey),
            body:
              step.notify === "paused"
                ? translate(locale, "teams.notice.paused", {
                    reason: translate(locale, teamsPauseReasonKey(reason)),
                  })
                : translate(locale, "teams.notice.signedOut"),
            page: "teams",
          })
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

        /**
         * The link starts: Connecting, and the first look at once. The first read is a baseline
         * read: after a switch on it has the reason "start", after "Resume" the reason "resume".
         */
        const start = (baseline: BaselineReason = "start") => {
          const now = clock.now()
          run.generation++
          run.readSet = newReadSet()
          run.baseline = baseline
          run.lastFinishedAt = null
          run.callStarts = []
          run.fails = noFailures
          setState("connecting")
          run.since = now
          run.nextAt = now
          changed()
          void tick()
        }
        /**
         * The link stops: the state is Off and the Teams page closes. The outbox is emptied, and
         * each message in it gets a record with this reason (spec 028).
         */
        const stop = (why: TeamsRecordReason = "linkOff") => {
          run.generation++
          run.readSet = newReadSet()
          run.lastFinishedAt = null
          run.fails = noFailures
          // A switch off ends a pause: the next switch on starts clean.
          run.pause = null
          if (row()?.paused != null) save({ paused: null, paused_at: null })
          emptyOutbox(why)
          setState("off")
          run.pageShown = false
          surface.place(undefined)
          surface.allowUserInput(false)
          surface.close()
        }

        /**
         * The repeated failure (spec 028): the link pauses itself. It reads nothing and sends
         * nothing until the user presses "Resume". The outbox is emptied, and each message in it
         * gets the record "Link paused". The Teams page closes, unless the user looks at it. The
         * pause stays in the database, so a restart keeps it. Notification and Today row come from
         * the state (`noteNeed`).
         */
        const pauseLink = (reason: TeamsPauseReason) => {
          const now = clock.now()
          run.generation++
          run.readSet = newReadSet()
          run.lastFinishedAt = null
          run.fails = noFailures
          run.pause = reason
          emptyOutbox("linkPaused")
          save({ paused: reason, paused_at: now })
          setState("paused")
          record("link_paused", reason)
          if (!run.pageShown) {
            surface.place(undefined)
            surface.close()
          }
          changed()
        }
        /** Counts one read. Gives true when the 20th failed read in a row paused the link. */
        const countReadAttempt = (attempt: TeamsAttempt): boolean => {
          const counted = countRead(run.fails, attempt)
          run.fails = counted.counts
          if (counted.pause === null) return false
          pauseLink(counted.pause)
          return true
        }
        /** Counts one try to send. Gives true when the 6th failed try in a row paused the link. */
        const countSendAttempt = (attempt: TeamsAttempt): boolean => {
          const counted = countSend(run.fails, attempt)
          run.fails = counted.counts
          if (counted.pause === null) return false
          pauseLink(counted.pause)
          return true
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
              // A try to send that fails with no network says nothing about the page.
              run.fails = afterOffline(run.fails)
              // The first read after Offline is a baseline read (spec 028, "Starts and gaps").
              run.baseline ??= "offline"
              run.nextAt = now + TEAMS_LOOK_AGAIN_MS
              break
            case "signIn":
              setSignedIn(false)
              setState("signedOut")
              // The state Signed out empties the outbox, and each message gets a record.
              emptyOutbox("signedOut")
              // So is the first read after a sign-in that follows Signed out.
              run.baseline ??= "signed_out"
              // The loop goes on at the pace of a read: it must see the sign-in at once.
              run.nextAt = now + TEAMS_READ_MS
              break
            case "unreadable":
              // A page that cannot be read leaves the state as it is. The loop counts it as a
              // failed read, and 20 in a row pause the link.
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
          // A paused link reads nothing. Only "Resume" starts it (spec 028).
          if (run.state === "paused") return
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
          // A page that cannot be read is a failed read. The states Signed out, Chat not found and
          // Offline are not failures.
          if (seen.kind === "unreadable" && countReadAttempt("failed")) return
          if (seen.kind === "chat" && seen.opened.kind === "opened") await readStep(generation)
          if (before !== `${run.state}|${run.chat}|${run.lastReadAt}`) changed()
        }

        // ----------------------------------------------------------------- Answers (S103)
        /** The name of an agent or a channel, or null when it is gone. */
        const placeNameOf = (kind: string | null, id: string | null): string | null => {
          if (kind === null || id === null) return null
          const found =
            kind === "agent"
              ? db.get<{ name: string }>("SELECT name FROM agent WHERE id = ?", id)
              : db.get<{ name: string }>("SELECT name FROM channel WHERE id = ?", id)
          return found?.name ?? null
        }
        /** The records of Settings, Teams: the newest 50. They hold no text of a message. */
        const recordsOf = (): TeamsRecord[] =>
          db
            .all<RecordRow>(
              "SELECT * FROM teams_record ORDER BY id DESC LIMIT ?",
              TEAMS_RECORDS_MAX,
            )
            .flatMap((r) => {
              if (!isTeamsRecordReason(r.reason)) return []
              const placeKind =
                r.place_kind === "agent" || r.place_kind === "channel" ? r.place_kind : null
              return [
                {
                  id: r.id,
                  at: r.at,
                  reason: r.reason,
                  placeKind,
                  placeId: r.place_id,
                  placeName: placeNameOf(placeKind, r.place_id),
                  taskId: r.task_id,
                },
              ]
            })
        /**
         * A record in Settings, Teams, and one line in the link log: an answer, or a part of it,
         * did not go out. Neither holds a text. `quiet` leaves the "changed" event to the caller.
         */
        const addRecord = (
          reason: TeamsRecordReason,
          subject: Pick<OutboxMessage, "taskId" | "placeKind" | "placeId">,
          quiet = false,
        ) => {
          db.run(
            "INSERT INTO teams_record (at, reason, place_kind, place_id, task_id) VALUES (?, ?, ?, ?, ?)",
            clock.now(),
            reason,
            subject.placeKind,
            subject.placeId,
            subject.taskId,
          )
          db.run(
            "DELETE FROM teams_record WHERE id NOT IN (SELECT id FROM teams_record ORDER BY id DESC LIMIT ?)",
            TEAMS_RECORDS_MAX,
          )
          record("message_dropped", recordReasonWord(reason))
          if (!quiet) changed()
        }
        /** Empties the outbox. Each message in it gets a record with the reason. */
        const emptyOutbox = (why: TeamsRecordReason) => {
          const dropped = run.outbox.splice(0)
          for (const item of dropped) addRecord(why, item, true)
          if (dropped.length > 0) changed()
        }
        /**
         * Why no answer is made now, or null when the link takes an answer. A link that is off, or
         * signed out, makes none, and the work that ends then gets a record (spec 028). The spec
         * names no reason for the state "Target missing": it takes "Link off".
         */
        const unavailable = (r: Row): TeamsRecordReason | null =>
          r.enabled !== 1
            ? "linkOff"
            : run.state === "signedOut"
              ? "signedOut"
              : run.state === "paused"
                ? "linkPaused"
                : run.state === "targetMissing"
                  ? "linkOff"
                  : null

        /** The keys and values that a text must not hold (spec 014), as the export hides them. */
        const knownSecrets = (): string[] => [
          ...Effect.runSync(providers.accounts)
            .map((a) => secrets.get(secretKey(a.id)))
            .filter((k): k is string => k !== null),
          ...[secrets.get(DECISION_KEY)].filter((k): k is string => k !== null),
          ...savedSecrets.knownValues(),
        ]
        const localeNow = (): Locale =>
          resolveLocale(Effect.runSync(settings.get).language, platform.systemLocale())

        /**
         * Makes an answer from a text: the secrets go first (the existing redaction of the app), on
         * the whole text, so that a key never breaks over two messages. Then the text is split, and
         * the messages go to the outbox. An answer that does not fit in the outbox as a whole is
         * dropped with the record "Outbox full". `word` is the kind of answer, for the link log.
         */
        const makeAnswer = (text: string, taskId: string | null, word: string) => {
          const r = row()
          if (!r) return
          const fields = fieldsOf(r)
          const subject = { taskId, placeKind: fields.targetKind, placeId: fields.targetId }
          const safe = redactSecrets(text, knownSecrets())
          const { messages } = splitAnswer(fields.marker, safe, cutLineText(localeNow()))
          if (messages.length === 0) return
          record("answer_made", word)
          if (run.outbox.length + messages.length > TEAMS_OUTBOX_MAX)
            return addRecord("outboxFull", subject)
          const now = clock.now()
          const answer = run.nextAnswer++
          for (const body of messages)
            run.outbox.push({
              id: run.nextMessage++,
              answer,
              text: body,
              ...subject,
              tries: 0,
              nextTryAt: now,
              firstFailedAt: null,
            })
        }
        /** One of the lines that the app writes in Teams (spec 028), in the language of the app. */
        const makeLine = (line: TeamsLine, taskId: string | null = null) =>
          makeAnswer(lineText(localeNow(), line), taskId, lineWord(line))

        /** The reply text of a task and the number of files in its reply. */
        const replyOf = (task: Task): { text: string; files: number } => {
          const none = { text: "", files: 0 }
          if (!task.messageId) return none
          const found = db.get<{ parts: string }>(
            "SELECT parts FROM message WHERE id = ?",
            task.messageId,
          )
          if (!found) return none
          try {
            const message = { parts: JSON.parse(found.parts) as MessagePart[] }
            return { text: messageText(message), files: messageFiles(message).length }
          } catch {
            return none
          }
        }

        /**
         * A task that a message from Teams started has ended (spec 028, "Answers"): done, failed,
         * blocked or stopped. Only such a task makes an answer. The answer goes to the chat of the
         * link, when the agent of the task is its target. A link that cannot take an answer makes
         * a record instead.
         */
        const answerTask = (task: Task) => {
          const r = row()
          if (!r) return
          const fields = fieldsOf(r)
          if (fields.targetKind !== "agent" || fields.targetId !== task.agentId) return
          // A task that a restart stopped shows "The app stopped" in the app. Teams gets nothing.
          if (task.error?.code === "app_stopped") return
          const why = unavailable(r)
          if (why)
            return addRecord(why, { taskId: task.id, placeKind: "agent", placeId: task.agentId })
          const name = task.agentName
          switch (task.state) {
            case "done": {
              const reply = replyOf(task)
              if (reply.text.trim() !== "") makeAnswer(reply.text, task.id, "reply")
              else makeLine({ kind: "noReply" }, task.id)
              if (reply.files > 0) makeLine({ kind: "files", count: reply.files }, task.id)
              return
            }
            case "failed":
            case "blocked":
              return makeLine(
                { kind: "failed", name, reason: failureReason(localeNow(), task.error) },
                task.id,
              )
            case "cancelled":
              return makeLine({ kind: "stopped", name }, task.id)
            default:
              return
          }
        }
        tasks.onEnd((task) => {
          if (task.source === "teams") answerTask(task)
        })

        /**
         * An approval or a question waits (spec 028, "Answers"). When it holds back work that a
         * message from Teams started, or holds back a new message from Teams, Teams gets one line
         * for the card. The line holds no text of the step or of the question.
         */
        const scanWaiting = (r: Row) => {
          const fields = fieldsOf(r)
          if (fields.targetKind !== "agent" || fields.targetId === null) return
          const waiting = notifier
            .waitingRequests()
            .filter((w) => w.agentId === fields.targetId && w.from === null)
          const live = new Set(waiting.map((w) => `${w.agentId}:${w.callId}`))
          for (const key of run.announced) if (!live.has(key)) run.announced.delete(key)
          if (waiting.length === 0 || unavailable(r) || !targetFound(fields)) return
          for (const w of waiting) {
            const key = `${w.agentId}:${w.callId}`
            if (run.announced.has(key)) continue
            const messageId = w.target.messageId
            const started = messageId
              ? db.get<{ source: string }>(
                  "SELECT source FROM task WHERE message_id = ? ORDER BY created_at DESC LIMIT 1",
                  messageId,
                )?.source
              : undefined
            if (started !== "teams" && chat.teamsWaiting(w.agentId) === 0) continue
            run.announced.add(key)
            const name = placeNameOf("agent", w.agentId)
            if (name !== null) makeLine({ kind: "waiting", name })
          }
        }

        // ----------------------------------------------------------------- The outbox (S103)
        /** A message that failed for one hour is dropped with the record "Not sent". */
        const dropOld = (now: number) => {
          const old = run.outbox.filter((m) => sendTooOld(m.firstFailedAt, now))
          if (old.length === 0) return
          run.outbox = run.outbox.filter((m) => !old.includes(m))
          for (const m of old) addRecord("notSent", m, true)
          changed()
        }

        /**
         * Sends the messages of the outbox that may go now, in order (spec 028, "The outbox"). The
         * link must be On and the Teams page hidden: while the user looks at the page, the answers
         * wait. Each try reads the title of the open chat in the script that types: a chat with
         * another title gets no text, and the whole answer is dropped. A failed try waits 5
         * seconds, then twice as long up to 5 minutes. A message holds the later ones back until
         * it has failed 3 tries in a row. At most 20 messages go out in one minute.
         */
        const sendStep = async (generation: number) => {
          for (;;) {
            if (generation !== run.generation) return
            const r = row()
            if (!r) return
            if (r.enabled !== 1 || run.state !== "on" || run.pageShown) return
            const fields = fieldsOf(r)
            if (!targetFound(fields)) return
            const now = clock.now()
            const index = pickNext(run.outbox, now)
            if (index === null || !sendMayGo(run.sentAt, now)) return
            const message = run.outbox[index] as OutboxMessage
            const result = await surface
              .send(message.text, fields.chatTitle)
              .catch(() => ({ kind: "failed" }) as const)
            // The link stopped while the page took the text: the outbox was emptied already.
            if (generation !== run.generation) return
            const at = clock.now()
            if (result.kind === "sent") {
              run.outbox = run.outbox.filter((m) => m !== message)
              run.sentAt = [...recentSends(run.sentAt, at), at]
              countSendAttempt("good")
              continue
            }
            if (result.kind === "wrongChat") {
              // The chat that is open has another title. Nothing was typed, and nothing is tried
              // again: the whole answer is dropped.
              const answer = run.outbox.filter((m) => m.answer === message.answer)
              run.outbox = run.outbox.filter((m) => m.answer !== message.answer)
              for (const m of answer) addRecord("wrongChat", m, true)
              changed()
              continue
            }
            message.tries++
            message.firstFailedAt ??= at
            message.nextTryAt = at + retryDelayMs(message.tries)
            record("send_failed", `try_${message.tries}`)
            if (message.tries === TEAMS_HOLD_TRIES) record("send_problem")
            // The 6th failed try in a row pauses the link and empties the outbox (spec 028).
            if (countSendAttempt("failed")) return
          }
        }

        // ----------------------------------------------------------------- The calls (S102)
        /**
         * Gives a call to the agent or the channel of the link. Gives the failure (its code and its
         * detail), or null.
         */
        const dispatch = async (
          fields: TeamsFields,
          text: string,
          sender: string,
        ): Promise<{ code: string; detail: string } | null> => {
          if (fields.targetId === null) return { code: "target_missing", detail: "" }
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
          return failure instanceof AppError
            ? { code: failure.code, detail: failure.detail ?? "" }
            : { code: "error", detail: "" }
        }

        /** One new message: "Who may call", the limit of calls, and then the work. */
        const handle = async (message: TeamsMessage, fields: TeamsFields, generation: number) => {
          const call = checkCall(message, fields)
          if (!call.ok) return record("call_refused", call.reason)
          const now = clock.now()
          if (!callMayStart(run.callStarts, now)) {
            record("call_over_limit")
            // Teams gets one line, and at most one such line each minute (spec 028).
            if (tooManyLineMayGo(run.tooManyAt, now)) {
              run.tooManyAt = now
              makeLine({ kind: "tooMany" })
            }
            return
          }
          if (generation !== run.generation) return
          const failed = await dispatch(fields, call.text, senderOfMessage(message.sender))
          if (failed?.code === "tasks_full") {
            record("queue_full")
            const name = failed.detail || placeNameOf(fields.targetKind, fields.targetId) || ""
            return makeLine({ kind: "queueFull", name })
          }
          if (failed) return record("target_failed", failed.code)
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
          const fields = fieldsOf(r)
          // A page that cannot be read, or that shows no chat, is a failed read (spec 028).
          if (!read || read.openTitle === null) {
            countReadAttempt("failed")
            return
          }
          // The user looks at another chat: this read did not finish. It is no failure.
          if (!holdsChatTitle(read.openTitle, fields.chatTitle)) return
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
            // Teams gets one line about a call that the gap skipped. A start gets none.
            if (gap && skipped.some((m) => checkCall(m, fields).ok)) {
              record("gap_skipped_call")
              makeLine({ kind: "gap" })
            }
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
          // A finished read sets the count of failed reads to 0.
          countReadAttempt("good")
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
          if (enabled) {
            connectTimeout(clock.now())
            scanWaiting(r)
            dropOld(clock.now())
          }
          if (run.busy) return
          if (!enabled && !run.pageShown) return
          run.busy = true
          try {
            if (enabled) {
              // The user hid the Teams page: the link opens its chat again before it sends.
              if (run.loopFirst) {
                run.loopFirst = false
                run.nextAt = 0
                await loopStep(r)
              }
              // The send comes before the read: it reads the title of the open chat as it is, and
              // does not find a chat that the read moved back just before.
              await sendStep(run.generation)
              await loopStep(r)
            } else await watchStep()
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
        // A link that was paused stays paused until the user presses "Resume" (spec 028).
        const keptPause = first?.enabled === 1 ? first.paused : null
        if (first?.enabled === 1 && isTeamsPauseReason(keptPause)) {
          run.state = "paused"
          run.pause = keptPause
          run.needSince = first.paused_at ?? clock.now()
          // The user knows of this pause already: a start makes no second notification.
          run.noticed = "paused"
        } else if (first?.enabled === 1) {
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
              run.loopFirst = true
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

          resume: Effect.fn("TeamsLink.resume")(function* () {
            const r = yield* needRow()
            if (r.enabled !== 1 || run.state !== "paused") return viewOf()
            save({ paused: null, paused_at: null })
            run.pause = null
            // The user answered the pause: a new pause is a new change, so it notifies again.
            run.noticed = null
            // The first read after "Resume" is a baseline read: nothing from the time of the
            // pause gets an answer.
            start("resume")
            record("link_resumed")
            return viewOf()
          })(),

          attention: Effect.sync((): TeamsAttention | null => {
            const r = row()
            const need = teamsNeed(run.state)
            if (r?.enabled !== 1 || need === null) return null
            return {
              state: need,
              reason: need === "paused" ? run.pause : null,
              since: run.needSince,
            }
          }),

          signOut: Effect.fn("TeamsLink.signOut")(function* () {
            yield* needRow()
            // The page closes first, so that nothing holds the saved data while it is deleted.
            save({ enabled: 0, signed_in: 0 })
            stop("signedOut")
            yield* profiles.clearTeamsSignIn
            changed()
            return viewOf()
          })(),

          remove: Effect.fn("TeamsLink.remove")(function* () {
            stop()
            db.run("DELETE FROM teams_link WHERE id = 1")
            // The records belong to the link: they go with it.
            db.run("DELETE FROM teams_record")
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
