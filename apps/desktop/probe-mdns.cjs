// TEMPORARY diagnostic: can two sockets on this machine find each other by multicast?
const os = require("node:os")
const makeMdns = require("multicast-dns")
const nets = os.networkInterfaces()
for (const [name, list] of Object.entries(nets))
  console.log(
    "PROBE iface",
    name,
    (list || []).map((a) => `${a.family}:${a.address}${a.internal ? "(internal)" : ""}`).join(" "),
  )
const port = 15353
const a = makeMdns({ port })
const b = makeMdns({ port })
for (const [n, s] of [
  ["A", a],
  ["B", b],
]) {
  s.on("error", (e) => console.log("PROBE error", n, e.code, e.message))
  s.on("warning", (e) => console.log("PROBE warning", n, e.code, e.message))
}
let got = false
a.on("query", () => {
  got = true
  console.log("PROBE A received the query of B")
})
setTimeout(() => {
  b.query({ questions: [{ name: "_robot-link._tcp.local", type: "PTR" }] })
  console.log("PROBE B sent the query")
}, 500)
setTimeout(() => {
  console.log("PROBE result", got ? "MULTICAST WORKS" : "MULTICAST BLOCKED")
  a.destroy(() => b.destroy(() => process.exit(0)))
}, 4000)
