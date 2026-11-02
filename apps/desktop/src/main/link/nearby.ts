import type { NearbyComputer } from "@robot/shared"
import makeMdns from "multicast-dns"

/**
 * Finds computers that show a pairing code (spec 012, "Pair"). A computer answers on the local
 * network only while its code is valid, and says its name, its addresses and its port. It never
 * says the code: the user types that, and the pairing proves it.
 *
 * The standard multicast name service is the way, so no service of ours is involved.
 */

const SERVICE = "_robot-link._tcp.local"
/** How long a record lives in the cache of a neighbour. A stop sends the same records with 0. */
const RECORD_TTL_S = 120
const NAME_MAX = 60
const FOUND_MAX = 20
/** The query goes out again after this share of the wait, because a packet can be lost. */
const WAIT_MS = 1500
const REPEAT_AT = 3

interface Question {
  readonly name: string
  readonly type: string
}
interface DnsRecord {
  readonly name: string
  readonly type: string
  readonly ttl?: number
  readonly data: unknown
}
export interface Packet {
  readonly questions?: readonly Question[]
  readonly answers?: readonly DnsRecord[]
  readonly additionals?: readonly DnsRecord[]
}

/** The part of the name service socket that is used here, so a test can stand in for it. */
export interface NameSocket {
  on(event: "query" | "response", fn: (packet: Packet, from: { address: string }) => void): unknown
  on(event: "error", fn: (error: Error) => void): unknown
  query(packet: { questions: readonly Question[] }): void
  respond(packet: { answers: readonly DnsRecord[] }): void
  destroy(done?: () => void): void
}
export type OpenSocket = () => NameSocket

export const openNameSocket: OpenSocket = () => {
  const port = Number(process.env.ROBOT_LINK_NEARBY_PORT)
  return makeMdns(port > 0 ? { port } : {}) as unknown as NameSocket
}

export interface Advert {
  /** The id of this device: the same on every advert, never the code. */
  readonly id: string
  readonly name: string
  readonly port: number
  /** IPv4 addresses of this computer. */
  readonly hosts: readonly string[]
}

const text = (value: unknown): string =>
  Buffer.isBuffer(value) ? value.toString("utf8") : String(value)

/** A name from the network is shown to the user, so it loses control characters and length. */
export const cleanName = (raw: string): string => {
  let out = ""
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0
    out += code < 32 || code === 127 ? " " : ch
  }
  return [...out.replace(/\s+/g, " ").trim()].slice(0, NAME_MAX).join("")
}

const isIpv4 = (host: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host)

export class Nearby {
  readonly #open: OpenSocket
  #ads: { socket: NameSocket; goodbye: () => void } | undefined

  constructor(open: OpenSocket = openNameSocket) {
    this.#open = open
  }

  get advertising() {
    return this.#ads !== undefined
  }

  /** Answers the questions of neighbours until `stop`. A new advert replaces the old one. */
  advertise(advert: Advert) {
    this.stop()
    const hosts = advert.hosts.filter(isIpv4)
    if (hosts.length === 0) return
    let socket: NameSocket
    try {
      socket = this.#open()
    } catch {
      return
    }
    const instance = `${advert.id}.${SERVICE}`
    const target = `${advert.id}.local`
    const records = (ttl: number): DnsRecord[] => [
      { name: SERVICE, type: "PTR", ttl, data: instance },
      {
        name: instance,
        type: "SRV",
        ttl,
        data: { port: advert.port, target, priority: 0, weight: 0 },
      },
      { name: instance, type: "TXT", ttl, data: [`id=${advert.id}`, `name=${advert.name}`] },
      ...hosts.map((host): DnsRecord => ({ name: target, type: "A", ttl, data: host })),
    ]
    // A socket that cannot bind (no network, a firewall) only means nobody finds this computer.
    socket.on("error", () => {})
    socket.on("query", (packet) => {
      const asked = packet.questions?.some(
        (q) => q.name.toLowerCase() === SERVICE && (q.type === "PTR" || q.type === "ANY"),
      )
      if (asked) socket.respond({ answers: records(RECORD_TTL_S) })
    })
    // Neighbours forget the records at once when the code ends.
    this.#ads = { socket, goodbye: () => socket.respond({ answers: records(0) }) }
  }

  stop() {
    const ads = this.#ads
    if (!ads) return
    this.#ads = undefined
    try {
      ads.goodbye()
    } catch {
      // The socket may be closed already.
    }
    ads.socket.destroy()
  }

  /** The computers that show a code now, except the one with id `own`. */
  async find(own: string, wait = WAIT_MS): Promise<NearbyComputer[]> {
    let socket: NameSocket
    try {
      socket = this.#open()
    } catch {
      return []
    }
    const pointers = new Set<string>()
    const ports = new Map<string, number>()
    const texts = new Map<string, Map<string, string>>()
    const hostOf = new Map<string, string>()
    const hosts = new Map<string, Set<string>>()
    const heard = new Map<string, string>()

    const take = (record: DnsRecord, from: string) => {
      const name = record.name.toLowerCase()
      switch (record.type) {
        case "PTR":
          if (name === SERVICE) {
            const instance = text(record.data).toLowerCase()
            if ((record.ttl ?? 1) > 0) pointers.add(instance)
            else pointers.delete(instance)
            heard.set(instance, from)
          }
          break
        case "SRV": {
          const data = record.data as { port?: number; target?: string }
          if (typeof data.port === "number" && data.port > 0 && data.port < 65536)
            ports.set(name, data.port)
          if (data.target) hostOf.set(name, data.target.toLowerCase())
          break
        }
        case "TXT": {
          const map = new Map<string, string>()
          for (const part of Array.isArray(record.data) ? record.data : []) {
            const line = text(part)
            const at = line.indexOf("=")
            if (at > 0) map.set(line.slice(0, at), line.slice(at + 1))
          }
          texts.set(name, map)
          break
        }
        case "A": {
          const host = text(record.data)
          if (!isIpv4(host)) break
          const set = hosts.get(name) ?? new Set<string>()
          set.add(host)
          hosts.set(name, set)
          break
        }
      }
    }

    socket.on("error", () => {})
    socket.on("response", (packet, from) => {
      for (const record of [...(packet.answers ?? []), ...(packet.additionals ?? [])])
        take(record, from.address)
    })
    const ask = () => {
      try {
        socket.query({ questions: [{ name: SERVICE, type: "PTR" }] })
      } catch {
        // A closed socket has nothing to ask.
      }
    }
    ask()
    await new Promise((done) => setTimeout(done, wait / REPEAT_AT))
    ask()
    await new Promise((done) => setTimeout(done, wait - wait / REPEAT_AT))
    socket.destroy()

    const out: NearbyComputer[] = []
    const seen = new Set<string>()
    for (const instance of pointers) {
      const info = texts.get(instance)
      const id = info?.get("id")
      const name = cleanName(info?.get("name") ?? "")
      const port = ports.get(instance)
      if (!id || id === own || seen.has(id) || !name || port === undefined) continue
      const list = hosts.get(hostOf.get(instance) ?? "")
      const host = list ? [...list][0] : heard.get(instance)
      if (!host) continue
      seen.add(id)
      out.push({ name, address: `${host}:${port}` })
      if (out.length >= FOUND_MAX) break
    }
    return out
  }
}
