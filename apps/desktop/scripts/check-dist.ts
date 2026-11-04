// Checks the files that users download: the disk image and the zip file in dist/desktop.
// `bun scripts/check-dist.ts [--signed] [folder]`. macOS only (docs/release.md).
//
// The end-to-end suite runs on the unpacked app. Users get a disk image or a zip file, so this
// opens both, and checks the version, the processor type, the host program and the signature.
// With --signed, the app must also have a Developer ID, the hardened runtime and a notarization
// ticket, and Gatekeeper must accept it.
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type AppFacts,
  artifactNames,
  parseArchs,
  parseSignature,
  problemsOf,
  problemsOfPair,
} from "./check-dist-lib.ts"

const run = (cmd: string, args: string[]) => {
  const out = spawnSync(cmd, args, { encoding: "utf8" })
  return {
    ok: out.status === 0,
    // `codesign` writes its facts to the error stream.
    text: `${out.stdout ?? ""}${out.stderr ?? ""}`.trim(),
  }
}

const factsOf = (from: string, appPath: string, signed: boolean): AppFacts => {
  const plist = join(appPath, "Contents/Info.plist")
  const version = run("plutil", ["-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist])
  const main = join(appPath, "Contents/MacOS/ROBot")
  const host = join(appPath, "Contents/Resources/robot-host")
  const hostFound = existsSync(host)
  const verify = run("codesign", ["--verify", "--deep", "--strict", appPath])
  return {
    from,
    version: version.ok ? version.text : null,
    mainArchs: existsSync(main) ? parseArchs(run("lipo", ["-archs", main]).text) : [],
    host: {
      found: hostFound,
      executable: hostFound && (statSync(host).mode & 0o111) !== 0,
      archs: hostFound ? parseArchs(run("lipo", ["-archs", host]).text) : [],
    },
    verify: { ok: verify.ok, message: verify.text.split("\n").slice(-1)[0] ?? "" },
    signature: parseSignature(run("codesign", ["-dvvv", appPath]).text),
    gatekeeper: signed
      ? (({ ok, text }) => ({ ok, message: text.split("\n")[0] ?? "" }))(
          run("spctl", ["--assess", "--type", "execute", "--verbose=2", appPath]),
        )
      : null,
    stapled: signed
      ? (({ ok, text }) => ({ ok, message: text.split("\n").slice(-1)[0] ?? "" }))(
          run("xcrun", ["stapler", "validate", appPath]),
        )
      : null,
  }
}

const main = () => {
  const args = process.argv.slice(2)
  const signed = args.includes("--signed")
  const folder = resolve(
    args.find((a) => !a.startsWith("--")) ?? join(import.meta.dirname, "../../../dist/desktop"),
  )
  const version = JSON.parse(readFileSync(join(import.meta.dirname, "../package.json"), "utf8"))
    .version as string
  const names = artifactNames(version)
  const dmg = join(folder, names.dmg)
  const zip = join(folder, names.zip)
  const missing = [dmg, zip].filter((f) => !existsSync(f))
  if (missing.length > 0)
    throw new Error(`Missing: ${missing.join(", ")}. Run "bun run dist" first.`)

  const work = mkdtempSync(join(tmpdir(), "robot-check-dist-"))
  const mount = join(work, "mount")
  const unzipped = join(work, "zip")
  let mounted = false
  try {
    // -nobrowse keeps the image out of Finder; the check never leaves it mounted.
    const attach = run("hdiutil", [
      "attach",
      "-nobrowse",
      "-readonly",
      "-noverify",
      "-mountpoint",
      mount,
      dmg,
    ])
    if (!attach.ok) throw new Error(`Cannot open ${names.dmg}: ${attach.text}`)
    mounted = true
    // ditto keeps the links and the signature that a plain unzip can break.
    const unpack = run("ditto", ["-x", "-k", zip, unzipped])
    if (!unpack.ok) throw new Error(`Cannot open ${names.zip}: ${unpack.text}`)

    const fromDmg = factsOf("disk image", join(mount, "ROBot.app"), signed)
    const fromZip = factsOf("zip file", join(unzipped, "ROBot.app"), signed)
    const problems = [
      ...problemsOf(fromDmg, { version, signed }),
      ...problemsOf(fromZip, { version, signed }),
      ...problemsOfPair(fromDmg, fromZip),
    ]
    if (problems.length > 0) throw new Error(problems.map((p) => `- ${p}`).join("\n"))
    console.log(
      `${names.dmg} and ${names.zip}: version ${version}, arm64, ${signed ? "Developer ID, notarized" : "ad-hoc signed"}, one build.`,
    )
  } finally {
    if (mounted) {
      // A busy image needs a second try, and then force.
      if (!run("hdiutil", ["detach", mount]).ok) run("hdiutil", ["detach", "-force", mount])
    }
    rmSync(work, { recursive: true, force: true })
  }
}

// An error ends the run after the disk image is detached: process.exit would skip that.
try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
