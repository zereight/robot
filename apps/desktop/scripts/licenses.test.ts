import { expect, test } from "bun:test"
import { resolve } from "node:path"
import shipped from "../src/main/licenses.json"
import { collectLicenses } from "./licenses-lib.ts"

const allowed =
  /^(MIT|ISC|BSD-2-Clause|BSD-3-Clause|Apache-2\.0|0BSD|MIT OR Apache-2\.0|\(MIT OR Apache-2\.0\))$/

test("the shipped license list is up to date (run `bun run licenses`)", () => {
  expect(shipped).toEqual(collectLicenses(resolve(import.meta.dirname, "..")))
})

test("every shipped dependency has an MIT-compatible license", () => {
  for (const entry of shipped) expect(entry.license).toMatch(allowed)
})
