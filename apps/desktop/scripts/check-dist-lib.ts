// Checks of the files that users download (docs/release.md). The functions here only read
// facts and judge them. `check-dist.ts` collects the facts from a disk image and a zip file.

/** What `codesign -dvvv` tells about an app. */
export interface SignatureFacts {
  /** The signature has no certificate: `Signature=adhoc`. */
  adhoc: boolean
  /** The certificate chain, leaf first (the `Authority=` lines). */
  authority: string[]
  teamId: string | null
  /** The hash of the code directory. Two copies of one build have the same hash. */
  cdHash: string | null
  /** The hardened runtime is on (`flags=0x10000(runtime)`). */
  hardenedRuntime: boolean
}

export interface AppFacts {
  /** Where the app was found, for the messages: "disk image" or "zip file". */
  from: string
  /** `CFBundleShortVersionString` of the app. */
  version: string | null
  /** The processor types of the main program, as `lipo -archs` tells them. */
  mainArchs: string[]
  /** The host program in Resources: found, can be run, and its processor types. */
  host: { found: boolean; executable: boolean; archs: string[] }
  /** Whether `codesign --verify --deep --strict` passed, and what it said if not. */
  verify: { ok: boolean; message: string }
  signature: SignatureFacts
  /** `spctl --assess` and `stapler validate`: only asked for a signed build. */
  gatekeeper: { ok: boolean; message: string } | null
  stapled: { ok: boolean; message: string } | null
}

export interface Want {
  /** The version of `apps/desktop/package.json`. */
  version: string
  /** A build with a Developer ID, notarized. False for the ad-hoc build. */
  signed: boolean
}

/** Reads the output of `codesign -dvvv`. The program writes it to the error stream. */
export const parseSignature = (text: string): SignatureFacts => {
  const lines = text.split(/\r?\n/)
  const value = (key: string): string | null => {
    const line = lines.find((l) => l.startsWith(`${key}=`))
    return line ? line.slice(key.length + 1).trim() : null
  }
  const team = value("TeamIdentifier")
  const flags = lines
    .find((l) => l.startsWith("CodeDirectory "))
    ?.match(/flags=0x[0-9a-f]+\(([^)]*)\)/)
  return {
    adhoc: value("Signature") === "adhoc",
    authority: lines.filter((l) => l.startsWith("Authority=")).map((l) => l.slice(10).trim()),
    teamId: team && team !== "not set" ? team : null,
    cdHash: value("CDHash"),
    hardenedRuntime: (flags?.[1] ?? "").split(",").includes("runtime"),
  }
}

/** Reads the output of `lipo -archs`, for example "arm64" or "x86_64 arm64". */
export const parseArchs = (text: string): string[] => text.split(/\s+/).filter(Boolean)

const onlyArm64 = (archs: string[]) => archs.length === 1 && archs[0] === "arm64"

/** The problems of one app. An empty list means the app is as the release wants it. */
export const problemsOf = (app: AppFacts, want: Want): string[] => {
  const out: string[] = []
  const bad = (text: string) => out.push(`${app.from}: ${text}`)
  if (app.version !== want.version)
    bad(`the app version is ${app.version ?? "missing"}, not ${want.version}`)
  if (!onlyArm64(app.mainArchs))
    bad(`the main program is for ${app.mainArchs.join(" ") || "no processor"}, not for arm64 only`)
  if (!app.host.found) bad("the host program is not in Resources")
  else {
    if (!app.host.executable) bad("the host program cannot be run")
    if (!onlyArm64(app.host.archs))
      bad(`the host program is for ${app.host.archs.join(" ") || "no processor"}, not arm64 only`)
  }
  if (!app.verify.ok) {
    // The packaging seals the bundle only when it signs. A bundle with a signed program inside
    // and no seal around it is what a build that skipped the signing leaves.
    const unsealed = /no resources but signature indicates/.test(app.verify.message)
    bad(
      `the signature does not hold: ${app.verify.message}` +
        (unsealed ? " (the bundle has no seal: was the signing skipped?)" : ""),
    )
  }
  if (want.signed) {
    if (app.signature.adhoc) bad("the build is ad-hoc signed, but a Developer ID is wanted")
    if (!app.signature.authority.some((a) => a.startsWith("Developer ID Application:")))
      bad("the certificate chain has no Developer ID Application")
    if (!app.signature.teamId) bad("the signature has no team")
    if (!app.signature.hardenedRuntime) bad("the hardened runtime is off")
    if (!app.gatekeeper?.ok) bad(`Gatekeeper does not accept the app: ${app.gatekeeper?.message}`)
    if (!app.stapled?.ok) bad(`the notarization ticket is not on the app: ${app.stapled?.message}`)
  } else if (!app.signature.adhoc && app.signature.authority.length === 0) {
    bad("the app has no signature")
  }
  return out
}

/** Problems of the pair: the disk image and the zip file must hold one build. */
export const problemsOfPair = (a: AppFacts, b: AppFacts): string[] => {
  if (!a.signature.cdHash || !b.signature.cdHash)
    return ["a code hash is missing, so the two files cannot be compared"]
  return a.signature.cdHash === b.signature.cdHash
    ? []
    : [`the ${a.from} and the ${b.from} hold different builds`]
}

/** The file names that a release has for a version (`artifactName` of electron-builder.yml). */
export const artifactNames = (version: string) => ({
  dmg: `ROBot-${version}-mac-arm64.dmg`,
  zip: `ROBot-${version}-mac-arm64.zip`,
})
