import { expect, test } from "bun:test"
import { EVERYONE_MENTION, mentionsEveryone, parseMentions } from "./channels.ts"
import {
  insertMention,
  MENTION_LIST_MAX,
  type MentionEntry,
  mentionEntries,
  openMention,
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

/** The lines of the list as short words: a name, or "@all". */
const shown = (lines: readonly MentionEntry<{ name: string }>[]) =>
  lines.map((x) => (x.kind === "all" ? "@all" : x.member.name))

test("entries: names that start with the query first, then names that hold it", () => {
  const members = [{ name: "Cy" }, { name: "Lia" }, { name: "Alia" }, { name: "Bo" }]
  expect(shown(mentionEntries(members, "", false))).toEqual(["Cy", "Lia", "Alia", "Bo"])
  expect(shown(mentionEntries(members, "li", false))).toEqual(["Lia", "Alia"])
  expect(shown(mentionEntries(members, "LI", false))).toEqual(["Lia", "Alia"])
  expect(mentionEntries(members, "zz", false)).toEqual([])
})

test("entries: a Korean name matches", () => {
  const members = [{ name: "하나" }, { name: "두리" }]
  expect(shown(mentionEntries(members, "두", false))).toEqual(["두리"])
})

test("entries: the list has a limit for members", () => {
  const many = Array.from({ length: MENTION_LIST_MAX + 5 }, (_, i) => ({ name: `Agent ${i}` }))
  expect(mentionEntries(many, "", false)).toHaveLength(MENTION_LIST_MAX)
  expect(mentionEntries(many, "", true)).toHaveLength(MENTION_LIST_MAX + 1)
})

test("entries: @all is the last line, so a bare @ and Enter pick a member", () => {
  const members = [{ name: "Cy" }, { name: "Bo" }]
  expect(shown(mentionEntries(members, "", true))).toEqual(["Cy", "Bo", "@all"])
  expect(shown(mentionEntries(members, "a", true))).toEqual(["@all"])
  expect(shown(mentionEntries(members, "al", true))).toEqual(["@all"])
})

test("entries: the whole word @all is the first line", () => {
  const members = [{ name: "Allan" }, { name: "Bo" }]
  expect(shown(mentionEntries(members, "al", true))).toEqual(["Allan", "@all"])
  expect(shown(mentionEntries(members, "all", true))).toEqual(["@all", "Allan"])
  expect(shown(mentionEntries(members, "ALL", true))).toEqual(["@all", "Allan"])
})

test("entries: no @all when the channel does not offer it, or when the query is another word", () => {
  const members = [{ name: "Cy" }, { name: "Bo" }]
  expect(shown(mentionEntries(members, "", false))).toEqual(["Cy", "Bo"])
  expect(shown(mentionEntries(members, "b", true))).toEqual(["Bo"])
  expect(shown(mentionEntries(members, "alls", true))).toEqual([])
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

test("insert: @all is read as the everyone mention", () => {
  const open = openMention("@", 1)
  if (!open) throw new Error("no mention")
  const { text } = insertMention("@", open, 1, EVERYONE_MENTION)
  expect(text).toBe("@all ")
  expect(mentionsEveryone(text)).toBe(true)
})

test("insert: the result is a mention that the channel reads, also with a space in the name", () => {
  for (const name of ["Bo", "Ada Lovelace", "두리"]) {
    const open = openMention("@", 1)
    if (!open) throw new Error("no mention")
    const { text } = insertMention("@", open, 1, name)
    expect(parseMentions(text, [name, "Other"])).toEqual([name])
  }
})
