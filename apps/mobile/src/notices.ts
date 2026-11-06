import type { WireNotice } from "@robot/link"
import type { MessageKey, MessageParams } from "./i18n/index.ts"
import { type Prefs, shouldNotify } from "./prefs.ts"

/** What a local notification carries, so a tap opens the chat and the card (spec 011). */
export interface NoticeData {
  readonly linkId: string
  readonly kind: "agent"
  readonly id: string
  readonly call?: string
}

/** A notice that points to the chat of an agent. */
type AgentNotice = WireNotice & { readonly target: { readonly kind: "agent"; readonly id: string } }
const toAgent = (n: WireNotice): n is AgentNotice => n.target?.kind === "agent"

/**
 * The cards of "Needs you" (spec 011): the approvals and questions of agents that wait. An older
 * server can also send notices of a channel; the phone shows none of them.
 */
export const waitingCards = (attention: readonly WireNotice[]): readonly AgentNotice[] =>
  attention.filter(
    (n): n is AgentNotice => (n.kind === "approval" || n.kind === "question") && toAgent(n),
  )

/** The place that shows on the screen now, set by the conversation screen. */
let shown: { linkId: string; kind: string; id: string } | null = null
export const setShownPlace = (place: typeof shown) => {
  shown = place
}
export const shownPlace = () => shown

/**
 * The notification for a notice, or null when the phone shows none: the user turned the kind
 * off, Phone 1 has no screen for it, it is not for the chat of an agent, or that chat is on the
 * screen now.
 */
export const noticeContent = (input: {
  readonly t: (key: MessageKey, params?: MessageParams) => string
  readonly prefs: Prefs
  readonly linkId: string
  readonly serverName: string
  readonly notice: WireNotice
  readonly active: boolean
}): { title: string; body: string; data: NoticeData } | null => {
  const { t, notice } = input
  if (!shouldNotify(input.prefs, notice) || !toAgent(notice)) return null
  const target = notice.target
  const here = shownPlace()
  if (
    input.active &&
    here?.linkId === input.linkId &&
    here.kind === target.kind &&
    here.id === target.id
  ) {
    return null
  }
  const body =
    notice.kind === "approval"
      ? t("notify.approval", { body: notice.body })
      : notice.kind === "question"
        ? t("notify.question", { body: notice.body })
        : notice.body
  return {
    title: t("notify.title", { title: notice.title, server: input.serverName }),
    body,
    data: {
      linkId: input.linkId,
      kind: target.kind,
      id: target.id,
      ...(notice.callId ? { call: notice.callId } : {}),
    },
  }
}

/** The data of a tapped notification, checked, or null when it is not one of ours. */
export const readNoticeData = (data: unknown): NoticeData | null => {
  const d = (data ?? {}) as Record<string, unknown>
  if (typeof d.linkId !== "string" || typeof d.id !== "string") return null
  if (d.kind !== "agent") return null
  return {
    linkId: d.linkId,
    kind: d.kind,
    id: d.id,
    ...(typeof d.call === "string" ? { call: d.call } : {}),
  }
}
