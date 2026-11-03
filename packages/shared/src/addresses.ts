/**
 * The addresses of a web page fetch (spec 007, "Addresses of a web page fetch"). The tool that
 * fetches a web page calls an address that the agent chooses. A page or a message can steer the
 * agent to an address that only this computer or its network can reach.
 *
 * - **Never allowed**: a link-local address (`169.254.0.0/16`, `fe80::/10`) and a cloud metadata
 *   address (`169.254.169.254`, `fd00:ec2::254`, and the host name `metadata.google.internal`).
 * - **Local**: an address on this computer or on a local network.
 *
 * This file runs in the window too, so it uses no module of Node.
 */

/** What an address is: refused at every level, local (a hard step), or any other. */
export type AddressKind = "never" | "local" | "public"

const WORST: Readonly<Record<AddressKind, number>> = { never: 2, local: 1, public: 0 }

/** The worse of two kinds: never is worse than local, and local is worse than public. */
export const worseKind = (a: AddressKind, b: AddressKind): AddressKind =>
  WORST[a] >= WORST[b] ? a : b

/** The worst kind of a list of addresses. One address that is never allowed refuses all. */
export const worstKind = (kinds: readonly AddressKind[]): AddressKind =>
  kinds.reduce<AddressKind>(worseKind, "public")

/** The bytes of an IPv4 address in dotted form, or null. A part has no leading zero. */
const parseV4 = (text: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (!parts.every((p) => p <= 255)) return null
  // A part with a leading zero can be read as octal by a program that connects, so it is no address.
  if (m.slice(1).some((p) => p.length > 1 && p.startsWith("0"))) return null
  return parts
}

/** The 16 bytes of an IPv6 address, or null. A zone (`%en0`) is dropped. */
const parseV6 = (input: string): number[] | null => {
  const text = input.split("%")[0] as string
  if (!/^[0-9a-f:.]+$/i.test(text) || !text.includes(":")) return null
  const halves = text.split("::")
  if (halves.length > 2) return null
  const toGroups = (part: string): number[] | null => {
    if (part === "") return []
    const out: number[] = []
    const pieces = part.split(":")
    for (const [i, piece] of pieces.entries()) {
      if (i === pieces.length - 1 && piece.includes(".")) {
        const v4 = parseV4(piece)
        if (!v4) return null
        out.push(
          ((v4[0] as number) << 8) | (v4[1] as number),
          ((v4[2] as number) << 8) | (v4[3] as number),
        )
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null
        out.push(Number.parseInt(piece, 16))
      }
    }
    return out
  }
  const head = toGroups(halves[0] as string)
  const tail = halves.length === 2 ? toGroups(halves[1] as string) : []
  if (!head || !tail) return null
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null
  const groups = [...head, ...Array<number>(Math.max(missing, 0)).fill(0), ...tail]
  return groups.flatMap((g) => [g >> 8, g & 255])
}

/** An IP address as bytes: 4 for IPv4, 16 for IPv6. Brackets are dropped. Null for a name. */
export const parseIp = (address: string): number[] | null => {
  const text = address.trim().replace(/^\[|\]$/g, "")
  return parseV4(text) ?? parseV6(text)
}

const kindOfV4 = (b: readonly number[]): AddressKind => {
  const [a, c, d, e] = b as [number, number, number, number]
  // Link-local, which holds the metadata address of most clouds (169.254.169.254).
  if (a === 169 && c === 254) return "never"
  // The metadata address of one cloud.
  if (a === 100 && c === 100 && d === 100 && e === 200) return "never"
  if (a === 0 || a === 127 || a === 10) return "local"
  if (a === 172 && c >= 16 && c <= 31) return "local"
  if (a === 192 && c === 168) return "local"
  // Shared address space, often a VPN or a carrier network.
  if (a === 100 && c >= 64 && c <= 127) return "local"
  return "public"
}

const kindOfV6 = (b: readonly number[]): AddressKind => {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0)
  const v4 = (at: number) => kindOfV4(b.slice(at, at + 4))
  // IPv4 inside IPv6: the address that the connection reaches is the IPv4 one.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4(12)
  // `::` and `::1`.
  if (zero(0, 15) && (b[15] === 0 || b[15] === 1)) return "local"
  // IPv4-compatible (`::a.b.c.d`), and the well-known prefix of NAT64 (`64:ff9b::/96`).
  if (zero(0, 12)) return v4(12)
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4(12)
  // 6to4 (`2002::/16`) holds the IPv4 address in the next four bytes.
  if (b[0] === 0x20 && b[1] === 0x02) return worseKind("public", v4(2))
  // Link-local: fe80::/10.
  if (b[0] === 0xfe && ((b[1] as number) & 0xc0) === 0x80) return "never"
  // The metadata address of one cloud over IPv6: fd00:ec2::254.
  if (
    b[0] === 0xfd &&
    b[1] === 0x00 &&
    b[2] === 0x0e &&
    b[3] === 0xc2 &&
    zero(4, 14) &&
    b[14] === 0x02 &&
    b[15] === 0x54
  )
    return "never"
  // Unique local: fc00::/7. Site-local, which is old: fec0::/10.
  if (((b[0] as number) & 0xfe) === 0xfc) return "local"
  if (b[0] === 0xfe && ((b[1] as number) & 0xc0) === 0xc0) return "local"
  return "public"
}

/** The kind of one IP address, as a look-up gives it. A text that is no address is "public". */
export const kindOfAddress = (address: string): AddressKind => {
  const bytes = parseIp(address)
  if (!bytes) return "public"
  return bytes.length === 4 ? kindOfV4(bytes) : kindOfV6(bytes)
}

/** Host names of cloud metadata services. */
const METADATA_NAMES = new Set(["metadata.google.internal", "metadata", "instance-data"])

/** How the host of an address is written, and what that says before any look-up. */
export type HostWriting =
  /** A cloud metadata name, or an address that is never allowed. */
  | { readonly kind: "never" }
  /**
   * An address written as numbers, `localhost`, or a name that ends in `.local`. A rule for this
   * host can allow it.
   */
  | { readonly kind: "local" }
  /** An address written as numbers that is not local or never allowed. */
  | { readonly kind: "public"; readonly written: "address" }
  /** Another name. The look-up decides, and a name that leads to a local address always asks. */
  | { readonly kind: "name" }

/**
 * What the host of an address says before the name is looked up. `hostname` is as the URL gives
 * it: lower case, with the brackets of an IPv6 address, and with a number in dotted form.
 */
export const classifyHostWriting = (hostname: string): HostWriting => {
  const host = hostname
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
  if (METADATA_NAMES.has(host) || host.endsWith(".metadata.google.internal"))
    return { kind: "never" }
  const bytes = parseIp(host)
  if (bytes) {
    const kind = bytes.length === 4 ? kindOfV4(bytes) : kindOfV6(bytes)
    return kind === "public" ? { kind: "public", written: "address" } : { kind }
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local"))
    return { kind: "local" }
  return { kind: "name" }
}

/** The host of an address as a rule for a web page matches it: lower case, no brackets, no final dot. */
export const ruleHost = (hostname: string): string =>
  hostname
    .trim()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase()
