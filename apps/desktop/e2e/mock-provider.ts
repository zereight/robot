import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"

/** The key that the stand-in provider accepts. A test sends nothing to a real model account. */
export const GOOD_KEY = "sk-mock-good-0123456789"

export interface RecordedRequest {
  readonly path: string
  readonly body: {
    readonly model?: string
    readonly messages: { role: string; content: unknown }[]
    readonly tools?: { function: { name: string } }[]
  }
}

export interface MockProvider {
  /** The base URL of the OpenAI-compatible API (it ends with `/v1`). */
  readonly openaiUrl: string
  /** Every chat request that the app sent, in order. */
  readonly requests: RecordedRequest[]
  /** How many requests wait for `release` (a message `tool-hold ...`). */
  held(): number
  /** Lets every request that waits go on. */
  release(): void
  close(): Promise<void>
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = ""
    req.on("data", (chunk) => {
      data += chunk
    })
    req.on("end", () => resolve(data))
  })

const text = (content: unknown) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((p) => (typeof p === "object" && p && "text" in p ? String(p.text) : ""))
          .join("")
      : ""

/**
 * A stand-in for an OpenAI-compatible provider. What it answers depends on the last message:
 * - `slow`: 60 words, one every 50 ms, so a test can stop the reply;
 * - `tool <name> <json>`: one call of that tool; after the tool result it says "Tool said: ...";
 * - `tool-hold <name> <json>`: the same, but the answer waits until the test calls `release()`, so the
 *   test can change something in the app while the turn works;
 * - `tools <n> <name> <json>`: the same call n times in a row, then "Tool said: ...";
 * - the turn after a run (a message that starts "The run <id> has ended."): one call of the tool that a
 *   line `PROPOSE:<name> <json>` in the facts of the run names, when there is one;
 * - `[[fail]]`: a server error, always. `[[flaky]]`: a server error for the first two requests with the
 *   same last message, then the normal answer;
 * - `[[hang]]`: no answer at all, until the app closes the request;
 * - `[[blocked]]`: a reply whose last line is "Blocked: ...";
 * - anything else: "You said: <message>".
 */
export const startMockProvider = async (): Promise<MockProvider> => {
  const requests: RecordedRequest[] = []
  const flaky = new Map<string, number>()
  let waiting: (() => void)[] = []
  const server: Server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${GOOD_KEY}`) {
      res.writeHead(401, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "bad key" } }))
      return
    }
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ data: [{ id: "mock-fast" }, { id: "gpt-5" }] }))
      return
    }
    if (req.url?.endsWith("/chat/completions")) {
      const body = JSON.parse(await readBody(req)) as RecordedRequest["body"]
      requests.push({ path: req.url, body })
      const last = body.messages.at(-1)
      const said = text(last?.content)
      if (said.includes("[[fail]]") || (said.includes("[[flaky]]") && (flaky.get(said) ?? 0) < 2)) {
        if (said.includes("[[flaky]]")) flaky.set(said, (flaky.get(said) ?? 0) + 1)
        res.writeHead(500, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: { message: "mock failure" } }))
        return
      }
      if (said.includes("[[failsecret]]")) {
        res.writeHead(500, { "content-type": "application/json" })
        res.end(
          JSON.stringify({ error: { message: `bad key sk-${"leak".repeat(8)}1234 refused` } }),
        )
        return
      }
      if (said.includes("[[hang]]")) {
        res.writeHead(200, { "content-type": "text/event-stream" })
        res.on("close", () => {})
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      const send = (delta: object) =>
        res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      const finish = () => {
        res.write(
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n`,
        )
        res.write("data: [DONE]\n\n")
        res.end()
      }
      const first = body.messages.find((m) => m.role === "user")
      const firstSaid = text(first?.content)
      const many = /^tools (\d+) (\w+)\s*(.*)$/s.exec(firstSaid)
      if (many) {
        const done = body.messages.filter((m) => m.role === "tool").length
        if (done < Number(many[1])) {
          send({
            tool_calls: [
              {
                index: 0,
                id: `call-${requests.length}`,
                function: { name: many[2], arguments: many[3] || "{}" },
              },
            ],
          })
        } else send({ content: `Tool said: ${said}` })
        finish()
        return
      }
      if (last?.role === "tool") {
        send({ content: `Tool said: ${said}` })
        finish()
        return
      }
      const tool = /^tool(-hold)? (\w+)\s*(.*)$/s.exec(said)
      if (tool) {
        if (tool[1]) await new Promise<void>((resolve) => waiting.push(resolve))
        send({
          tool_calls: [
            {
              index: 0,
              id: `call-${requests.length}`,
              function: { name: tool[2], arguments: tool[3] || "{}" },
            },
          ],
        })
        finish()
        return
      }
      const reflect = /^The run \S+ has ended\./.test(said)
        ? /PROPOSE:(\w+) (\{[^\n]*\})/.exec(
            text(body.messages.find((m) => m.role === "system")?.content),
          )
        : null
      if (reflect) {
        send({
          tool_calls: [
            {
              index: 0,
              id: `call-${requests.length}`,
              function: { name: reflect[1], arguments: reflect[2] },
            },
          ],
        })
        finish()
        return
      }
      if (said.includes("[[blocked]]")) {
        send({ content: "I tried.\nBlocked: the file is missing" })
        finish()
        return
      }
      if (said.includes("slow")) {
        let closed = false
        res.on("close", () => {
          closed = true
        })
        for (let i = 1; i <= 60 && !closed; i++) {
          send({ content: `word${i} ` })
          await new Promise((r) => setTimeout(r, 50))
        }
        if (!closed) finish()
        return
      }
      send({ content: `You said: ${said}` })
      finish()
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    openaiUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    held: () => waiting.length,
    release: () => {
      const go = waiting
      waiting = []
      for (const resolve of go) resolve()
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/**
 * A stand-in for the decision model service (spec 013). It gives the probabilities that the test
 * sets with `set`, for every option in order. `set("error")` gives an answer that cannot be read.
 */
export const startMockDecision = async () => {
  let probabilities: number[] | "error" = [0.95, 0.05]
  const server: Server = createServer(async (req, res) => {
    await readBody(req)
    res.writeHead(200, { "content-type": "application/json" })
    if (probabilities === "error") {
      res.end(JSON.stringify({ nope: true }))
      return
    }
    res.end(
      JSON.stringify({
        answers: {
          decision: {
            type: "choice",
            probabilities: Object.fromEntries(probabilities.map((p, i) => [`option_${i + 1}`, p])),
          },
        },
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    set: (next: number[] | "error") => {
      probabilities = next
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
