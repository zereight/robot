import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { _electron as electron, expect, test } from "@playwright/test"
import { freshUserData } from "./harness.ts"

// A data file that cannot be opened must not leave the app alive with no window: the app shows an
// error dialog and quits. A test run writes the text of the dialog to a file, because it cannot
// press a button of a native dialog.

const appDir = resolve(import.meta.dirname, "..")

const startWith = async (userData: string, locale: string) => {
  const errorFile = `${userData}-error.json`
  const { ELECTRON_RUN_AS_NODE: _, ...base } = process.env
  const app = await electron.launch({
    args: [appDir],
    env: {
      ...base,
      ROBOT_USER_DATA: userData,
      ROBOT_TEST_SECRETS: `${userData}-secrets.json`,
      ROBOT_TEST_ERROR_FILE: errorFile,
      ROBOT_SYSTEM_LOCALE: locale,
    } as Record<string, string>,
  })
  // The process ends by itself. If it does not, the test fails on this wait.
  const code = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => done(-999), 20_000)
    app.process().once("exit", (c) => {
      clearTimeout(timer)
      done(c)
    })
  })
  return {
    code,
    dialog: JSON.parse(readFileSync(errorFile, "utf8")) as { title: string; message: string },
  }
}

test("start: a damaged data file shows the error dialog and the app quits", async () => {
  const userData = freshUserData()
  mkdirSync(userData, { recursive: true })
  const file = join(userData, "robot.db")
  writeFileSync(file, "not a database ".repeat(200))
  const { code, dialog } = await startWith(userData, "en-US")
  expect(code).toBe(1)
  expect(dialog.title).toBe("ROBot cannot open its data")
  expect(dialog.message).toContain(file)
  // The damaged file is not changed or erased.
  expect(readFileSync(file, "utf8")).toBe("not a database ".repeat(200))
})

test("start: the dialog follows the language of the system", async () => {
  const userData = freshUserData()
  mkdirSync(userData, { recursive: true })
  writeFileSync(join(userData, "robot.db"), "not a database ".repeat(200))
  const { code, dialog } = await startWith(userData, "ko-KR")
  expect(code).toBe(1)
  expect(dialog.title).toContain("데이터 파일")
  expect(dialog.message).toContain("다시 시작")
})

test("start: a data file that this account may not read shows the error dialog", async () => {
  test.skip(process.getuid?.() === 0, "root reads every file")
  const userData = freshUserData()
  mkdirSync(userData, { recursive: true })
  const file = join(userData, "robot.db")
  writeFileSync(file, "")
  spawnSync("chmod", ["000", file])
  try {
    const { code, dialog } = await startWith(userData, "en-US")
    expect(code).toBe(1)
    expect(dialog.message).toContain(file)
  } finally {
    spawnSync("chmod", ["600", file])
  }
})
