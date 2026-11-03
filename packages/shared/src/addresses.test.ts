import { describe, expect, test } from "bun:test"
import {
  classifyHostWriting,
  kindOfAddress,
  parseIp,
  ruleHost,
  worseKind,
  worstKind,
} from "./addresses.ts"

describe("kindOfAddress: IPv4", () => {
  test("link-local and cloud metadata addresses are never allowed", () => {
    for (const address of ["169.254.169.254", "169.254.0.1", "169.254.255.255", "100.100.100.200"])
      expect(kindOfAddress(address)).toBe("never")
  })

  test("this computer and the local networks are local", () => {
    for (const address of [
      "127.0.0.1",
      "127.255.255.254",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "192.168.255.255",
      "0.0.0.0",
      "100.64.0.1",
    ])
      expect(kindOfAddress(address)).toBe("local")
  })

  test("the edges of a range are public", () => {
    for (const address of [
      "172.15.255.255",
      "172.32.0.0",
      "192.167.1.1",
      "192.169.1.1",
      "11.0.0.1",
      "9.255.255.255",
      "169.253.1.1",
      "169.255.1.1",
      "8.8.8.8",
      "93.184.216.34",
      "100.63.255.255",
      "100.128.0.1",
    ])
      expect(kindOfAddress(address)).toBe("public")
  })

  test("a text that is not an address is public here: the look-up decides for a name", () => {
    for (const text of ["example.com", "", "1.2.3", "256.1.1.1", "1.2.3.4.5", "01.2.3.4"])
      expect(kindOfAddress(text)).toBe("public")
  })
})

describe("kindOfAddress: IPv6", () => {
  test("link-local fe80::/10 and the metadata address are never allowed", () => {
    for (const address of [
      "fe80::1",
      "FE80::1",
      "fe80:0:0:0:0:0:0:1",
      "febf:ffff::1",
      "fe80::1%en0",
      "[fe80::1]",
      "fd00:ec2::254",
      "FD00:EC2:0:0:0:0:0:254",
      "fd00:0ec2::0254",
    ])
      expect(kindOfAddress(address)).toBe("never")
  })

  test("the loopback, the unspecified address and unique local addresses are local", () => {
    for (const address of [
      "::1",
      "0:0:0:0:0:0:0:1",
      "[::1]",
      "::",
      "fc00::1",
      "fd12:3456:789a::1",
      "fdff:ffff::1",
      "fec0::1",
    ])
      expect(kindOfAddress(address)).toBe("local")
  })

  test("other fd addresses than the metadata one are local, not never", () => {
    expect(kindOfAddress("fd00:ec2::255")).toBe("local")
    expect(kindOfAddress("fd00:ec3::254")).toBe("local")
  })

  test("public IPv6 addresses", () => {
    for (const address of [
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "fec0",
      "fe7f::1",
      "fbff::1",
      "ff02::1",
    ])
      expect(kindOfAddress(address)).toBe("public")
  })

  test("IPv4 inside IPv6 takes the kind of the IPv4 address", () => {
    expect(kindOfAddress("::ffff:169.254.169.254")).toBe("never")
    expect(kindOfAddress("::ffff:a9fe:a9fe")).toBe("never")
    expect(kindOfAddress("0:0:0:0:0:ffff:169.254.169.254")).toBe("never")
    expect(kindOfAddress("::ffff:127.0.0.1")).toBe("local")
    expect(kindOfAddress("::ffff:7f00:1")).toBe("local")
    expect(kindOfAddress("::ffff:10.1.2.3")).toBe("local")
    expect(kindOfAddress("::ffff:8.8.8.8")).toBe("public")
    // The deprecated IPv4-compatible form.
    expect(kindOfAddress("::169.254.169.254")).toBe("never")
    expect(kindOfAddress("::127.0.0.2")).toBe("local")
    // NAT64 and 6to4 carry an IPv4 address too.
    expect(kindOfAddress("64:ff9b::a9fe:a9fe")).toBe("never")
    expect(kindOfAddress("64:ff9b::7f00:1")).toBe("local")
    expect(kindOfAddress("64:ff9b::808:808")).toBe("public")
    expect(kindOfAddress("2002:a9fe:a9fe::1")).toBe("never")
    expect(kindOfAddress("2002:7f00:1::")).toBe("local")
    expect(kindOfAddress("2002:808:808::1")).toBe("public")
  })
})

describe("parseIp", () => {
  test("reads the usual forms, and nothing else", () => {
    expect(parseIp("1.2.3.4")).toEqual([1, 2, 3, 4])
    expect(parseIp("::1")).toHaveLength(16)
    expect(parseIp("[::1]")).toHaveLength(16)
    expect(parseIp("1:2:3:4:5:6:7:8")).toHaveLength(16)
    expect(parseIp("1:2:3:4:5:6:1.2.3.4")).toHaveLength(16)
    for (const text of [
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7",
      "::1::2",
      "1::2::3",
      "12345::1",
      "g::1",
      ":::",
      "1:2:3:4:5:6:7::8",
      "example.com",
    ])
      expect(parseIp(text)).toBeNull()
  })

  test("a part with a leading zero is no address, because a program can read it as octal", () => {
    expect(parseIp("0127.0.0.1")).toBeNull()
    expect(parseIp("127.0.0.01")).toBeNull()
    expect(parseIp("0.0.0.0")).toEqual([0, 0, 0, 0])
  })
})

describe("classifyHostWriting", () => {
  test("a metadata name or an address that is never allowed", () => {
    for (const host of [
      "metadata.google.internal",
      "METADATA.GOOGLE.INTERNAL",
      "metadata.google.internal.",
      "a.metadata.google.internal",
      "169.254.169.254",
      "[fe80::1]",
      "[fd00:ec2::254]",
      "[::ffff:169.254.169.254]",
    ])
      expect(classifyHostWriting(host)).toEqual({ kind: "never" })
  })

  test("an address written as numbers, localhost and .local names are local", () => {
    for (const host of [
      "127.0.0.1",
      "10.1.2.3",
      "192.168.1.5",
      "[::1]",
      "[fd12::1]",
      "localhost",
      "LOCALHOST",
      "localhost.",
      "app.localhost",
      "printer.local",
      "Printer.Local.",
    ])
      expect(classifyHostWriting(host)).toEqual({ kind: "local" })
  })

  test("a public address, and a name that needs a look-up", () => {
    expect(classifyHostWriting("8.8.8.8")).toEqual({ kind: "public", written: "address" })
    expect(classifyHostWriting("[2606:4700:4700::1111]")).toEqual({
      kind: "public",
      written: "address",
    })
    expect(classifyHostWriting("example.com")).toEqual({ kind: "name" })
    expect(classifyHostWriting("www.example.com")).toEqual({ kind: "name" })
    // A name that only looks like a local one.
    expect(classifyHostWriting("notlocal.com")).toEqual({ kind: "name" })
    expect(classifyHostWriting("local.example.com")).toEqual({ kind: "name" })
    expect(classifyHostWriting("localhost.example.com")).toEqual({ kind: "name" })
  })
})

describe("the worst of a list", () => {
  test("never is worse than local, and local is worse than public", () => {
    expect(worseKind("public", "local")).toBe("local")
    expect(worseKind("local", "never")).toBe("never")
    expect(worseKind("never", "public")).toBe("never")
    expect(worstKind([])).toBe("public")
    expect(worstKind(["public", "public"])).toBe("public")
    expect(worstKind(["public", "local", "public"])).toBe("local")
    expect(worstKind(["public", "local", "never"])).toBe("never")
  })

  test("the key of a rule for a host has no brackets, no final dot and no capitals", () => {
    expect(ruleHost("[::1]")).toBe("::1")
    expect(ruleHost("Printer.Local.")).toBe("printer.local")
    expect(ruleHost("127.0.0.1")).toBe("127.0.0.1")
  })
})
