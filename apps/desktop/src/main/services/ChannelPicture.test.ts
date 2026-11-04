import { describe, expect, test } from "bun:test"
import { CHANNEL_PICTURE_BYTES } from "@robot/shared"
import { Effect, Exit } from "effect"
import { Agents } from "./Agents.ts"
import { Channels } from "./Channels.ts"
import { Database } from "./Database.ts"
import { Servers } from "./Servers.ts"
import { testRuntime } from "./testing.ts"

// The picture of a channel (spec 004, "Picture").

/** A PNG head with a side, padded to `total` bytes. The service reads the head only. */
const png = (side: number, total = 200) => {
  const bytes = new Uint8Array(Math.max(total, 33))
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
  const view = new DataView(bytes.buffer)
  view.setUint32(16, side)
  view.setUint32(20, side)
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
}

const setup = async () => {
  const t = testRuntime()
  const run = t.runtime.runPromise
  const local = await run(Servers.use((s) => s.local))
  const agent = await run(
    Agents.use((a) =>
      a.create({ serverId: local.id, name: "Bo", role: "", instructions: "", model: null }),
    ),
  )
  const channel = await run(
    Channels.use((c) =>
      c.create({
        serverId: local.id,
        name: "Launch",
        topic: "",
        memberIds: [agent.id],
        leadId: null,
      }),
    ),
  )
  const set = (id: string, dataUrl: string | null) =>
    t.runtime.runPromiseExit(Channels.use((c) => c.setPicture(id, dataUrl)))
  const code = (exit: Exit.Exit<unknown, { code: string }>) =>
    Exit.isFailure(exit)
      ? exit.cause.reasons
          .map((r) => ("error" in r ? (r.error as { code: string }).code : ""))
          .join()
      : "ok"
  return { ...t, run, local, agent, channel, set, code }
}

describe("the picture of a channel", () => {
  test("a channel has no picture at first; a set picture shows in the channel and the list", async () => {
    const s = await setup()
    expect(s.channel.picture).toBeNull()
    const picture = png(256)
    const exit = await s.set(s.channel.id, picture)
    expect(s.code(exit)).toBe("ok")
    const got = await s.run(Channels.use((c) => c.get(s.channel.id)))
    expect(got.picture).toBe(picture)
    const list = await s.run(Channels.use((c) => c.list(s.local.id)))
    expect(list.map((c) => c.picture)).toEqual([picture])
  })

  test("remove brings back the mark: the picture is null again", async () => {
    const s = await setup()
    await s.set(s.channel.id, png(256))
    expect(s.code(await s.set(s.channel.id, null))).toBe("ok")
    const got = await s.run(Channels.use((c) => c.get(s.channel.id)))
    expect(got.picture).toBeNull()
  })

  test("a change of the other settings keeps the picture", async () => {
    const s = await setup()
    const picture = png(128)
    await s.set(s.channel.id, picture)
    const changed = await s.run(
      Channels.use((c) => c.update(s.channel.id, { topic: "New topic", reviewParts: true })),
    )
    expect(changed.picture).toBe(picture)
  })

  test("a picture over 256 px, one that is not square, a JPEG and a file over 1 MB are refused", async () => {
    const s = await setup()
    expect(s.code(await s.set(s.channel.id, png(257)))).toBe("channel_picture_invalid")
    expect(s.code(await s.set(s.channel.id, "data:image/jpeg;base64,AAAA"))).toBe(
      "channel_picture_invalid",
    )
    expect(s.code(await s.set(s.channel.id, png(256, CHANNEL_PICTURE_BYTES + 1)))).toBe(
      "channel_picture_too_large",
    )
    expect(s.code(await s.set("no-such-channel", png(256)))).toBe("channel_not_found")
    // Nothing was saved by a refused picture.
    const got = await s.run(Channels.use((c) => c.get(s.channel.id)))
    expect(got.picture).toBeNull()
  })

  test("the picture is saved in the database", async () => {
    const s = await setup()
    const picture = png(256)
    await s.set(s.channel.id, picture)
    const row = await s.run(
      Database.use((db) =>
        Effect.sync(() =>
          db.get<{ picture: string }>("SELECT picture FROM channel WHERE id = ?", s.channel.id),
        ),
      ),
    )
    expect(row?.picture).toBe(picture)
  })

  test("a channel that is deleted takes its picture with it", async () => {
    const s = await setup()
    await s.set(s.channel.id, png(256))
    await s.run(Channels.use((c) => c.remove(s.channel.id)))
    const left = await s.run(
      Database.use((db) =>
        Effect.sync(() => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM channel")),
      ),
    )
    expect(left?.n).toBe(0)
  })
})
