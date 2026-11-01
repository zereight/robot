export interface SseEvent {
  readonly event: string
  readonly data: string
}

/** Reads server-sent events from a response body. */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder()
  let buffer = ""
  const reader = body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n")
      let end = buffer.indexOf("\n\n")
      while (end >= 0) {
        const block = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const parsed = parseBlock(block)
        if (parsed) yield parsed
        end = buffer.indexOf("\n\n")
      }
    }
    const rest = parseBlock(buffer)
    if (rest) yield rest
  } finally {
    reader.releaseLock()
  }
}

const parseBlock = (block: string): SseEvent | undefined => {
  let event = "message"
  const data: string[] = []
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue
    const colon = line.indexOf(":")
    const field = colon < 0 ? line : line.slice(0, colon)
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "")
    if (field === "event") event = value
    else if (field === "data") data.push(value)
  }
  return data.length ? { event, data: data.join("\n") } : undefined
}
