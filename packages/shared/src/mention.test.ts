import { expect, test } from "bun:test"
import {
  directMentions,
  insertMention,
  MENTION_LIST_MAX,
  mentionEntries,
  openMention,
  parseMentions,
} from "./mention.ts"

test("a mention opens at an @ that starts the text or follows a space", () => {
  expect(openMention("@", 1)).toEqual({ start: 0, query: "" })
  expect(openMention("@Ad", 3)).toEqual({ start: 0, query: "Ad" })
  expect(openMention("ask @Bo", 7)).toEqual({ start: 4, query: "Bo" })
  expect(openMention("line\n@Bo", 8)).toEqual({ start: 5, query: "Bo" })
})

test("an @ inside a word is plain text", () => {
  expect(openMention("mail me at a@b", 14)).toBeNull()
  expect(openMention("a@", 2)).toBeNull()
})

test("the list closes after a space, and with no @", () => {
  expect(openMention("@Ada ", 5)).toBeNull()
  expect(openMention("hello", 5)).toBeNull()
  expect(openMention("", 0)).toBeNull()
})

test("the caret decides, not the end of the text", () => {
  // The caret is after "@B" and the text goes on.
  expect(openMention("@Bo and more", 2)).toEqual({ start: 0, query: "B" })
  // The caret is in the later word: the earlier @ is closed by the space.
  expect(openMention("@Bo and more", 8)).toBeNull()
})

test("the last @ before the caret counts", () => {
  expect(openMention("@Ada @C", 7)).toEqual({ start: 5, query: "C" })
})

/** The names of the list. */
const shown = (lines: readonly { name: string }[]) => lines.map((x) => x.name)

test("entries: names that start with the query first, then names that hold it", () => {
  const members = [{ name: "Cy" }, { name: "Lia" }, { name: "Alia" }, { name: "Bo" }]
  expect(shown(mentionEntries(members, ""))).toEqual(["Cy", "Lia", "Alia", "Bo"])
  expect(shown(mentionEntries(members, "li"))).toEqual(["Lia", "Alia"])
  expect(shown(mentionEntries(members, "LI"))).toEqual(["Lia", "Alia"])
  expect(mentionEntries(members, "zz")).toEqual([])
})

test("entries: a Korean name matches", () => {
  const members = [{ name: "하나" }, { name: "두리" }]
  expect(shown(mentionEntries(members, "두"))).toEqual(["두리"])
})

test("entries: the list has a limit", () => {
  const many = Array.from({ length: MENTION_LIST_MAX + 5 }, (_, i) => ({ name: `Agent ${i}` }))
  expect(mentionEntries(many, "")).toHaveLength(MENTION_LIST_MAX)
})

test("entries: @all is not a line of the list", () => {
  const members = [{ name: "Cy" }, { name: "Bo" }]
  expect(shown(mentionEntries(members, "all"))).toEqual([])
})

test("insert: @Name and one space take the place of the query", () => {
  const text = "ask @Bo"
  const open = openMention(text, text.length)
  if (!open) throw new Error("no mention")
  expect(insertMention(text, open, text.length, "Bob")).toEqual({
    text: "ask @Bob ",
    caret: 9,
  })
})

test("insert: the text after the caret stays, and a space is not doubled", () => {
  const text = "@B and more"
  const open = openMention(text, 2)
  if (!open) throw new Error("no mention")
  expect(insertMention(text, open, 2, "Bob")).toEqual({ text: "@Bob and more", caret: 5 })
  const split = "@Bone"
  const inside = openMention(split, 2)
  if (!inside) throw new Error("no mention")
  expect(insertMention(split, inside, 2, "Bob")).toEqual({ text: "@Bob one", caret: 5 })
})

const roster = [
  { id: "ada", name: "Ada", archived: false },
  { id: "bo", name: "Bo", archived: false },
  { id: "cy", name: "Cy", archived: true },
]

test("a direct chat names another agent, and not itself, an archived agent, an unknown name or @all", () => {
  expect(directMentions(roster, "ada", "@Bo look").map((agent) => agent.id)).toEqual(["bo"])
  expect(directMentions(roster, "ada", "@Ada hi")).toEqual([])
  expect(directMentions(roster, "ada", "@Cy hi")).toEqual([])
  expect(directMentions(roster, "ada", "@Nope hi")).toEqual([])
  expect(directMentions(roster, "ada", "@all hi")).toEqual([])
  expect(directMentions(roster, "ada", "mail a@Bo.com")).toEqual([])
})

test("a direct chat keeps the order of the agents when the message names two", () => {
  const open = [
    { id: "cy", name: "Cy", archived: false },
    { id: "bo", name: "Bo", archived: false },
  ]
  expect(directMentions(open, "ada", "@Bo and @Cy").map((agent) => agent.id)).toEqual(["cy", "bo"])
})

test("insert: the result is a mention that the parser reads, also with a space in the name", () => {
  for (const name of ["Bo", "Ada Lovelace", "두리"]) {
    const open = openMention("@", 1)
    if (!open) throw new Error("no mention")
    const { text } = insertMention("@", open, 1, name)
    expect(parseMentions(text, [name, "Other"])).toEqual([name])
  }
})
