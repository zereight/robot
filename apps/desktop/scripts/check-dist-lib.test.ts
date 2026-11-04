import { describe, expect, test } from "bun:test"
import {
  type AppFacts,
  artifactNames,
  parseArchs,
  parseSignature,
  problemsOf,
  problemsOfPair,
} from "./check-dist-lib.ts"

const ADHOC = `Executable=/Volumes/ROBot/ROBot.app/Contents/MacOS/ROBot
Identifier=io.github.zereight.robot
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20400 size=512 flags=0x2(adhoc) hashes=8+3 location=embedded
Signature=adhoc
Info.plist entries=24
TeamIdentifier=not set
CDHash=1111111111111111111111111111111111111111
`

const SIGNED = `Executable=/Volumes/ROBot/ROBot.app/Contents/MacOS/ROBot
Identifier=io.github.zereight.robot
Format=app bundle with Mach-O thin (arm64)
CodeDirectory v=20500 size=900 flags=0x10000(runtime) hashes=8+7 location=embedded
Authority=Developer ID Application: Example Person (ABCDE12345)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
TeamIdentifier=ABCDE12345
CDHash=2222222222222222222222222222222222222222
`

const app = (patch: Partial<AppFacts> = {}): AppFacts => ({
  from: "disk image",
  version: "0.2.0",
  mainArchs: ["arm64"],
  host: { found: true, executable: true, archs: ["arm64"] },
  verify: { ok: true, message: "" },
  signature: parseSignature(ADHOC),
  gatekeeper: null,
  stapled: null,
  ...patch,
})

describe("parseSignature", () => {
  test("an ad-hoc signature has no team and no authority", () => {
    expect(parseSignature(ADHOC)).toEqual({
      adhoc: true,
      authority: [],
      teamId: null,
      cdHash: "1111111111111111111111111111111111111111",
      hardenedRuntime: false,
    })
  })

  test("a Developer ID signature with the hardened runtime", () => {
    const facts = parseSignature(SIGNED)
    expect(facts.adhoc).toBe(false)
    expect(facts.authority[0]).toBe("Developer ID Application: Example Person (ABCDE12345)")
    expect(facts.teamId).toBe("ABCDE12345")
    expect(facts.hardenedRuntime).toBe(true)
  })

  test("the hardened runtime is found among several flags", () => {
    const text = "CodeDirectory v=20500 size=1 flags=0x10002(adhoc,runtime) hashes=1+1\n"
    expect(parseSignature(text).hardenedRuntime).toBe(true)
  })

  test("an unsigned app gives no facts and no crash", () => {
    const facts = parseSignature("code object is not signed at all\n")
    expect(facts.adhoc).toBe(false)
    expect(facts.authority).toEqual([])
    expect(facts.cdHash).toBeNull()
  })
})

describe("parseArchs", () => {
  test("splits the processor types", () => {
    expect(parseArchs("x86_64 arm64\n")).toEqual(["x86_64", "arm64"])
    expect(parseArchs("")).toEqual([])
  })
})

describe("problemsOf, ad-hoc build", () => {
  const want = { version: "0.2.0", signed: false }

  test("a good ad-hoc app has no problem", () => {
    expect(problemsOf(app(), want)).toEqual([])
  })

  test("a wrong version, a wrong processor, no host and a broken signature each show", () => {
    const problems = problemsOf(
      app({
        version: "0.1.9",
        mainArchs: ["x86_64", "arm64"],
        host: { found: false, executable: false, archs: [] },
        verify: { ok: false, message: "a sealed resource is missing" },
      }),
      want,
    )
    expect(problems).toHaveLength(4)
    expect(problems.join("\n")).toContain("0.1.9, not 0.2.0")
    expect(problems.join("\n")).toContain("not for arm64 only")
    expect(problems.join("\n")).toContain("host program is not in Resources")
    expect(problems.join("\n")).toContain("a sealed resource is missing")
  })

  test("a bundle that was never sealed says that the signing may have been skipped", () => {
    // What electron-builder leaves in a pull request, where it skips all signing.
    const problems = problemsOf(
      app({
        verify: {
          ok: false,
          message: "ROBot.app: code has no resources but signature indicates they must be present",
        },
      }),
      want,
    )
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain("was the signing skipped?")
    // Another failure of the seal gets no such guess.
    const other = problemsOf(
      app({ verify: { ok: false, message: "a sealed resource is missing or invalid" } }),
      want,
    )
    expect(other[0]).not.toContain("skipped")
  })

  test("a host program that cannot run or is for another processor shows", () => {
    const problems = problemsOf(
      app({ host: { found: true, executable: false, archs: ["x86_64"] } }),
      want,
    )
    expect(problems).toHaveLength(2)
  })

  test("an app with no signature at all shows", () => {
    const unsigned = parseSignature("code object is not signed at all\n")
    expect(problemsOf(app({ signature: unsigned }), want)).toEqual([
      "disk image: the app has no signature",
    ])
  })
})

describe("problemsOf, signed build", () => {
  const want = { version: "0.2.0", signed: true }
  const good = (): Partial<AppFacts> => ({
    signature: parseSignature(SIGNED),
    gatekeeper: { ok: true, message: "" },
    stapled: { ok: true, message: "" },
  })

  test("a signed, notarized app has no problem", () => {
    expect(problemsOf(app(good()), want)).toEqual([])
  })

  test("an ad-hoc app is refused where a Developer ID is wanted", () => {
    const problems = problemsOf(
      app({
        gatekeeper: { ok: false, message: "rejected" },
        stapled: { ok: false, message: "no" },
      }),
      want,
    )
    expect(problems.join("\n")).toContain("ad-hoc signed")
    expect(problems.join("\n")).toContain("no Developer ID Application")
    expect(problems.join("\n")).toContain("no team")
    expect(problems.join("\n")).toContain("hardened runtime is off")
    expect(problems.join("\n")).toContain("Gatekeeper does not accept the app: rejected")
    expect(problems.join("\n")).toContain("ticket is not on the app: no")
  })

  test("a signed app that was not notarized shows", () => {
    const problems = problemsOf(
      app({ ...good(), stapled: { ok: false, message: "no ticket" } }),
      want,
    )
    expect(problems).toEqual(["disk image: the notarization ticket is not on the app: no ticket"])
  })

  test("a missing check counts as failed, not as passed", () => {
    expect(problemsOf(app({ ...good(), gatekeeper: null, stapled: null }), want)).toHaveLength(2)
  })
})

describe("problemsOfPair", () => {
  test("two copies of one build match", () => {
    expect(problemsOfPair(app(), app({ from: "zip file" }))).toEqual([])
  })

  test("two builds do not match", () => {
    const other = app({ from: "zip file", signature: parseSignature(SIGNED) })
    expect(problemsOfPair(app(), other)).toEqual([
      "the disk image and the zip file hold different builds",
    ])
  })

  test("a missing hash is a problem, not a match of two nulls", () => {
    const none = app({ signature: parseSignature("") })
    expect(problemsOfPair(none, none)).toHaveLength(1)
  })
})

describe("artifactNames", () => {
  test("follow artifactName of electron-builder.yml", () => {
    expect(artifactNames("0.1.0-alpha.9")).toEqual({
      dmg: "ROBot-0.1.0-alpha.9-mac-arm64.dmg",
      zip: "ROBot-0.1.0-alpha.9-mac-arm64.zip",
    })
  })
})
