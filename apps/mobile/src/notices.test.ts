import { afterEach, describe, expect, test } from "bun:test"
import type { WireNotice } from "@robot/link"
import { translate } from "./i18n/index.ts"
import { noticeContent, readNoticeData, setShownPlace } from "./notices.ts"
import { defaultPrefs } from "./prefs.ts"

const t = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params)
const approval: WireNotice = {
  kind: "approval",
  channelId: null,
  title: "Ada",
  body: "rm old.txt",
  target: { kind: "agent", id: "a1" },
  callId: "c1",
  agentId: "a1",
}
const base = {
  t,
  prefs: defaultPrefs,
  linkId: "L1",
  serverName: "MacBook",
  notice: approval,
  active: true,
}

afterEach(() => setShownPlace(null))

describe("notifications of the phone", () => {
  test("an approval names the server and opens its card", () => {
    expect(noticeContent(base)).toEqual({
      title: "Ada · MacBook",
      body: "Approval: rm old.txt",
      data: { linkId: "L1", kind: "agent", id: "a1", call: "c1" },
    })
  })

  test("a kind that is off, or a kind with no screen in Phone 1, shows nothing", () => {
    const off = { ...defaultPrefs, notify: { ...defaultPrefs.notify, approval: false } }
    expect(noticeContent({ ...base, prefs: off })).toBeNull()
    expect(
      noticeContent({
        ...base,
        notice: {
          channelId: null,
          title: "Flow",
          body: "done",
          kind: "workflow_notice",
          page: "workflows",
        },
      }),
    ).toBeNull()
  })

  test("nothing shows for the place on the screen while the app is open", () => {
    setShownPlace({ linkId: "L1", kind: "agent", id: "a1" })
    expect(noticeContent(base)).toBeNull()
    // In the background the same notice shows.
    expect(noticeContent({ ...base, active: false })).not.toBeNull()
    // Another server with the same place id is another place.
    expect(noticeContent({ ...base, linkId: "L2" })).not.toBeNull()
  })

  test("a tap reads only data of the right shape", () => {
    expect(readNoticeData({ linkId: "L1", kind: "channel", id: "c", call: 3 })).toEqual({
      linkId: "L1",
      kind: "channel",
      id: "c",
    })
    expect(readNoticeData({ linkId: "L1", kind: "page", id: "x" })).toBeNull()
    expect(readNoticeData(null)).toBeNull()
  })
})
