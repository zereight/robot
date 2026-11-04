import { createSocket } from "node:dgram"
import { connect, createServer } from "node:net"
import makeMdns from "multicast-dns"

// Ports for tests that run two copies of the app. A fixed number would meet another worker, another
// run, or a copy of ROBot that is open on the same computer. So a test asks for free ports, and a
// restart of an app in the same test keeps the number it got.

/** The range stays below the ports that the system hands out to outgoing connections. */
const FIRST = 20_000
const LAST = 31_999
const TRIES = 50

const handedOut = new Set<number>()

const randomPort = () => FIRST + Math.floor(Math.random() * (LAST - FIRST + 1))

const tcpBindsFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer()
    probe.once("error", () => resolve(false))
    probe.listen(port, () => probe.close(() => resolve(true)))
  })

// True when something on this computer answers TCP on 127.0.0.1 and the port. The bind probe
// listens on all addresses, but that still misses a holder on 127.0.0.1 or on all IPv4 addresses,
// so this check guards the address that the tests use to reach the app.
const tcpAnswersOnLoopback = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host: "127.0.0.1", port })
    const end = (answers: boolean) => {
      socket.destroy()
      resolve(answers)
    }
    // A connect that never ends means the number is not safe to use either.
    socket.setTimeout(1000, () => end(true))
    socket.once("connect", () => end(true))
    socket.once("error", (reason: NodeJS.ErrnoException) => end(reason.code !== "ECONNREFUSED"))
  })

/** True when no program of this computer holds the TCP port. */
export const tcpIsFree = async (port: number): Promise<boolean> =>
  (await tcpBindsFree(port)) && !(await tcpAnswersOnLoopback(port))

const udpIsFree = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createSocket({ type: "udp4", reuseAddr: false })
    probe.once("error", () => {
      probe.close()
      resolve(false)
    })
    probe.bind(port, () => probe.close(() => resolve(true)))
  })

const pick = async (isFree: (port: number) => Promise<boolean>) => {
  for (let i = 0; i < TRIES; i++) {
    const port = randomPort()
    if (handedOut.has(port) || !(await isFree(port))) continue
    handedOut.add(port)
    return port
  }
  throw new Error("no free port found for the test")
}

/** A TCP port that nothing listens on. A number is given once in a run of tests. */
export const freePort = () => pick(tcpIsFree)

/** The two link ports of two copies of the app. */
export const freePortPair = async (): Promise<[number, number]> => [
  await freePort(),
  await freePort(),
]

/** A UDP port for the name service, so that a test never speaks on the real one. */
export const freeNearbyPort = () => pick(udpIsFree)

/**
 * True when two sockets on this computer can find each other with multicast. Some hosted test
 * machines block it; a test that needs it then checks the rest without it.
 */
export const multicastWorks = (port: number) =>
  new Promise<boolean>((resolve) => {
    const listener = makeMdns({ port })
    const asker = makeMdns({ port })
    let done = false
    const finish = (works: boolean) => {
      if (done) return
      done = true
      clearTimeout(giveUp)
      clearInterval(repeat)
      listener.destroy(() => asker.destroy(() => resolve(works)))
    }
    listener.on("error", () => finish(false))
    asker.on("error", () => finish(false))
    listener.on("query", () => finish(true))
    const ask = () => asker.query({ questions: [{ name: "_robot-probe._tcp.local", type: "PTR" }] })
    // The first packet can be lost before the sockets have joined the group.
    const repeat = setInterval(ask, 400)
    const giveUp = setTimeout(() => finish(false), 3_000)
    setTimeout(ask, 200)
  })
