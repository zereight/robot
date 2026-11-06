import { expect, test } from "bun:test"
import { byMemberName } from "./memberOrder"

test("an archived member stands by name among the other agents", () => {
  const choices = [
    { agent: { name: "Eve" }, archived: false },
    { agent: { name: "bo" }, archived: true },
    { agent: { name: "Ada" }, archived: false },
  ]
  expect(byMemberName(choices).map((c) => c.agent.name)).toEqual(["Ada", "bo", "Eve"])
})
