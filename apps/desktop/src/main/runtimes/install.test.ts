import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  claudePlatform,
  codexAsset,
  firstTarFile,
  installRuntime,
  unpackFirstFile,
} from "./install.ts"
import { findBinary, knownPlace, managedPath, rememberPlace } from "./locate.ts"

const tmp = () => mkdtempSync(join(tmpdir(), "robot-install-test-"))
const sha = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")

/** A tar with a header record for extended data first, then one file. */
const tarOf = (name: string, content: string, withExtended = false) => {
  const record = (entryName: string, body: Buffer, type: string) => {
    const header = Buffer.alloc(512)
    header.write(entryName, 0)
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124)
    header.write(type, 156)
    const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
    return Buffer.concat([header, body, padding])
  }
  const parts = [
    ...(withExtended ? [record("pax", Buffer.from("20 comment=hello\n"), "x")] : []),
    record(name, Buffer.from(content), "0"),
    Buffer.alloc(1024),
  ]
  return Buffer.concat(parts)
}

const servers: { stop: () => void }[] = []
afterAll(() => {
  for (const s of servers) s.stop()
})

describe("platform names", () => {
  test("Claude Code names its platforms by system and processor", () => {
    expect(claudePlatform("darwin", "arm64")).toBe("darwin-arm64")
    expect(claudePlatform("win32", "x64")).toBe("win32-x64")
    expect(claudePlatform("linux", "x64", false)).toBe("linux-x64")
    expect(claudePlatform("linux", "arm64", true)).toBe("linux-arm64-musl")
    expect(() => claudePlatform("darwin", "ia32")).toThrow()
    expect(() => claudePlatform("freebsd", "x64")).toThrow()
  })

  test("Codex names its files by target", () => {
    expect(codexAsset("darwin", "arm64")).toBe("codex-aarch64-apple-darwin.tar.gz")
    expect(codexAsset("darwin", "x64")).toBe("codex-x86_64-apple-darwin.tar.gz")
    expect(codexAsset("linux", "x64")).toBe("codex-x86_64-unknown-linux-musl.tar.gz")
    expect(codexAsset("win32", "x64")).toBe("codex-x86_64-pc-windows-msvc.exe.tar.gz")
  })
})

describe("tar", () => {
  test("the first normal file is found, after a record of extended data", async () => {
    const dir = tmp()
    writeFileSync(join(dir, "a.tar"), tarOf("codex-x", "BINARY", true))
    const found = firstTarFile(join(dir, "a.tar"))
    expect(found.name).toBe("codex-x")
    expect(found.size).toBe(6)
  })

  test("an empty archive is refused", () => {
    const dir = tmp()
    writeFileSync(join(dir, "e.tar"), Buffer.alloc(1024))
    expect(() => firstTarFile(join(dir, "e.tar"))).toThrow()
  })

  test("only the file is written, under the name that the app chooses", async () => {
    const dir = tmp()
    const archive = join(dir, "a.tar.gz")
    writeFileSync(archive, Bun.gzipSync(tarOf("../../evil", "BINARY")))
    await unpackFirstFile(archive, join(dir, "codex"))
    expect(readFileSync(join(dir, "codex"), "utf8")).toBe("BINARY")
    expect(existsSync(join(dir, "a.tar.gz.tar"))).toBe(false)
  })
})

describe("install Claude Code", () => {
  const program = "#!/bin/sh\necho 1.2.3\n"
  const serve = (checksum: string) => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/latest") return new Response("1.2.3\n")
        if (path === "/1.2.3/manifest.json")
          return Response.json({
            platforms: { "darwin-arm64": { binary: "claude", checksum, size: program.length } },
          })
        if (path === "/1.2.3/darwin-arm64/claude") return new Response(program)
        return new Response("no", { status: 404 })
      },
    })
    servers.push(server)
    return `http://127.0.0.1:${server.port}`
  }

  test("a download with the right checksum is kept and found", async () => {
    const dataDir = tmp()
    const seen: (number | null)[] = []
    const version = await installRuntime("claude_code", {
      dataDir,
      signal: new AbortController().signal,
      onProgress: (p) => seen.push(p),
      claudeDist: serve(sha(program)),
      platform: "darwin",
      arch: "arm64",
    })
    expect(version).toBe("1.2.3")
    const path = managedPath(dataDir, "claude_code", "darwin")
    expect(path && readFileSync(path, "utf8")).toBe(program)
    expect(statSync(path as string).mode & 0o111).not.toBe(0)
    expect(seen.at(-1)).toBe(1)
    expect(
      findBinary("claude_code", { dataDir, env: { PATH: "" }, home: dataDir, extraDirs: [] }),
    ).toEqual({
      path: path as string,
      source: "app",
    })
  })

  test("a wrong checksum keeps nothing", async () => {
    const dataDir = tmp()
    await expect(
      installRuntime("claude_code", {
        dataDir,
        signal: new AbortController().signal,
        onProgress: () => {},
        claudeDist: serve("0".repeat(64)),
        platform: "darwin",
        arch: "arm64",
      }),
    ).rejects.toThrow("checksum")
    expect(managedPath(dataDir, "claude_code", "darwin")).toBeNull()
    expect(existsSync(join(dataDir, "runtimes", "claude_code", "1.2.3"))).toBe(false)
  })

  test("a platform that the release lacks is refused", async () => {
    await expect(
      installRuntime("claude_code", {
        dataDir: tmp(),
        signal: new AbortController().signal,
        onProgress: () => {},
        claudeDist: serve(sha(program)),
        platform: "linux",
        arch: "x64",
      }),
    ).rejects.toThrow("no program")
  })
})

describe("install Codex", () => {
  const archive = Bun.gzipSync(tarOf("codex-aarch64-apple-darwin", "CODEX-BINARY"))
  const serve = (digest: string | undefined) => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const path = new URL(req.url).pathname
        if (path === "/repos/openai/codex/releases/latest")
          return Response.json({
            tag_name: "rust-v0.166.0",
            assets: [
              {
                name: "codex-aarch64-apple-darwin.tar.gz",
                size: archive.length,
                digest,
                browser_download_url: `${new URL(req.url).origin}/download/codex.tar.gz`,
              },
            ],
          })
        if (path === "/download/codex.tar.gz") return new Response(archive)
        return new Response("no", { status: 404 })
      },
    })
    servers.push(server)
    return `http://127.0.0.1:${server.port}`
  }

  test("the archive is checked and unpacked into the app", async () => {
    const dataDir = tmp()
    const version = await installRuntime("codex", {
      dataDir,
      signal: new AbortController().signal,
      onProgress: () => {},
      codexApi: serve(`sha256:${sha(archive)}`),
      platform: "darwin",
      arch: "arm64",
    })
    expect(version).toBe("0.166.0")
    const path = managedPath(dataDir, "codex", "darwin") as string
    expect(readFileSync(path, "utf8")).toBe("CODEX-BINARY")
    expect(existsSync(`${path}.part`)).toBe(false)
    expect(
      existsSync(
        join(dataDir, "runtimes", "codex", "0.166.0", "codex-aarch64-apple-darwin.tar.gz"),
      ),
    ).toBe(false)
  })

  test("a release without a published checksum is refused", async () => {
    await expect(
      installRuntime("codex", {
        dataDir: tmp(),
        signal: new AbortController().signal,
        onProgress: () => {},
        codexApi: serve(undefined),
        platform: "darwin",
        arch: "arm64",
      }),
    ).rejects.toThrow("checked program")
  })

  test("a wrong checksum keeps nothing", async () => {
    const dataDir = tmp()
    await expect(
      installRuntime("codex", {
        dataDir,
        signal: new AbortController().signal,
        onProgress: () => {},
        codexApi: serve(`sha256:${"0".repeat(64)}`),
        platform: "darwin",
        arch: "arm64",
      }),
    ).rejects.toThrow("checksum")
    expect(managedPath(dataDir, "codex", "darwin")).toBeNull()
  })
})

describe("find the program", () => {
  const exe = (path: string) => {
    mkdirSync(join(path, ".."), { recursive: true })
    writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 })
    return path
  }

  test("a path in the environment comes first; a wrong one means nothing is found", () => {
    const dir = tmp()
    const bin = exe(join(dir, "mine", "claude"))
    expect(
      findBinary("claude_code", { dataDir: dir, env: { ROBOT_CLAUDE_BIN: bin }, extraDirs: [] })
        ?.path,
    ).toBe(bin)
    expect(
      findBinary("claude_code", { dataDir: dir, env: { ROBOT_CLAUDE_BIN: join(dir, "nope") } }),
    ).toBeNull()
  })

  test("the PATH is searched, then the usual places", () => {
    const dir = tmp()
    const onPath = exe(join(dir, "bin", "codex"))
    expect(
      findBinary("codex", {
        dataDir: dir,
        env: { PATH: join(dir, "bin") },
        home: dir,
        extraDirs: [],
      })?.path,
    ).toBe(onPath)
    const usual = exe(join(dir, "home", ".local", "bin", "claude"))
    expect(
      findBinary("claude_code", {
        dataDir: dir,
        env: { PATH: "" },
        home: join(dir, "home"),
        extraDirs: [],
      })?.path,
    ).toBe(usual)
  })

  test("a file that is not executable is skipped", () => {
    const dir = tmp()
    mkdirSync(join(dir, "bin"))
    writeFileSync(join(dir, "bin", "codex"), "x", { mode: 0o644 })
    expect(
      findBinary("codex", {
        dataDir: dir,
        env: { PATH: join(dir, "bin") },
        home: join(dir, "none"),
        extraDirs: [],
      }),
    ).toBeNull()
  })
})

describe("the places where the app saw a program", () => {
  test("a program that was never seen has no known place", () => {
    expect(knownPlace(tmp(), "codex")).toBeNull()
  })

  test("a place that the app kept is known again, for each program on its own", () => {
    const dir = tmp()
    rememberPlace(dir, "codex", "/usr/local/bin/codex")
    rememberPlace(dir, "claude_code", "/opt/claude")
    expect(knownPlace(dir, "codex")).toBe("/usr/local/bin/codex")
    expect(knownPlace(dir, "claude_code")).toBe("/opt/claude")
    expect(knownPlace(dir, "muse")).toBeNull()
    // The newest place wins.
    rememberPlace(dir, "codex", "/elsewhere/codex")
    expect(knownPlace(dir, "codex")).toBe("/elsewhere/codex")
  })

  test("a path that is only set in the environment is not a place that the app knew", () => {
    const dir = tmp()
    expect(
      findBinary("codex", { dataDir: dir, env: { ROBOT_CODEX_BIN: join(dir, "nope") } }),
    ).toBeNull()
    expect(knownPlace(dir, "codex")).toBeNull()
  })

  test("a file of places that is broken is no memory, and does not break the look", () => {
    const dir = tmp()
    mkdirSync(join(dir, "runtimes"), { recursive: true })
    writeFileSync(join(dir, "runtimes", "places.json"), "{ not json")
    expect(knownPlace(dir, "codex")).toBeNull()
    rememberPlace(dir, "codex", "/a/codex")
    expect(knownPlace(dir, "codex")).toBe("/a/codex")
  })
})
