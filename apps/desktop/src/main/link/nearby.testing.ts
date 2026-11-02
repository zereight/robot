import type { NameSocket, OpenSocket, Packet } from "./nearby.ts"

/**
 * A local network in memory, for tests: what one socket sends, every open socket receives, also
 * the sender, as a multicast on a real network does.
 */
export class MemoryNetwork {
  readonly #sockets = new Set<{
    query: Set<(packet: Packet, from: { address: string }) => void>
    response: Set<(packet: Packet, from: { address: string }) => void>
  }>()
  /** Every packet that was sent, to check what a computer says and when. */
  readonly sent: { kind: "query" | "response"; packet: Packet }[] = []
  /** When true, no socket can be opened (no network). */
  down = false

  readonly open: OpenSocket = () => {
    if (this.down) throw new Error("no network")
    const me = {
      query: new Set<(packet: Packet, from: { address: string }) => void>(),
      response: new Set<(packet: Packet, from: { address: string }) => void>(),
    }
    this.#sockets.add(me)
    const deliver = (kind: "query" | "response", packet: Packet) => {
      this.sent.push({ kind, packet })
      for (const other of [...this.#sockets]) {
        for (const fn of [...other[kind]]) queueMicrotask(() => fn(packet, { address: "10.0.0.9" }))
      }
    }
    return {
      on: (event: string, fn: never) => {
        if (event === "query" || event === "response") me[event].add(fn)
      },
      query: (packet) => deliver("query", { questions: packet.questions }),
      respond: (packet) => deliver("response", { answers: packet.answers }),
      destroy: (done) => {
        this.#sockets.delete(me)
        done?.()
      },
    } as NameSocket
  }

  /** How many sockets are open now. */
  get openCount() {
    return this.#sockets.size
  }
}
