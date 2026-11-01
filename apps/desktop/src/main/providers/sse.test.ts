import { expect, test } from "bun:test"
import { readSse } from "./sse.ts"

const streamOf = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c))
      controller.close()
    },
  })

test("reads events split across chunks", async () => {
  const events = []
  for await (const e of readSse(
    streamOf('event: a\ndata: {"x"', ":1}\n\n: comment\n\ndata: two\r\n\r\n", "data: [DONE]"),
  )) {
    events.push(e)
  }
  expect(events).toEqual([
    { event: "a", data: '{"x":1}' },
    { event: "message", data: "two" },
    { event: "message", data: "[DONE]" },
  ])
})
