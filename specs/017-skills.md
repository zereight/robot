# 017 Skills

## Purpose

The user saves a set of instructions once and calls it with a slash in any chat, so the user does
not type the same long request again.

## Concepts

- **Skill**: a name, a short description, the instructions, the agents that may use it, and an
  on or off switch.
  - The name holds 1 to 40 characters. It is unique, and the check ignores case. A slash at the
    start of the typed name is removed.
  - The description holds up to 140 characters. It may be empty.
  - The instructions hold 1 to 20000 characters of plain text.
  - The agents: "All agents" (the default), or a list that the user picks.
- **Skill chip**: a small tag with the name of a skill. It sits in the message box, and later in
  the message row.
- A **runtime skill** is a skill that an agent runtime reports (see 006). The user cannot edit
  it here. It is not a skill of this spec.

## Flows

1. Make: in settings, Skills, the user picks "New skill", fills the form and saves. The form
   says that a skill is sent to the model with the message, so the user must not write secrets in
   it.
2. Edit: the user opens a skill, changes any field, and saves.
3. Copy: the user picks "Duplicate" on a skill. The copy gets the name and the word "copy" in
   the language of the interface, and a number if that name is taken. It is off until the user
   turns it on.
4. Turn off or on: a switch on the row. A skill that is off does not show in the chat list.
5. Delete: the user deletes a skill after a confirm. Old messages that used it keep their chip.
6. Use: in a direct chat or a thread, the user types a slash as the first character (see 003).
   The list shows the skills of this agent (see 003, flow 7). The user picks one with the mouse
   or with Enter. The slash text leaves the box and a chip takes its place at the start of the
   box.
   - The user can type more text after the chip, or send the chip alone.
   - One chip at a time. Picking a second skill replaces the first.
   - The user removes the chip with its close button, or with Backspace at the start of the box.
7. Send: the agent reads the instructions of the skill first, then the text of the user, as one
   message. The chat row shows the text of the user with the chip above it. A click on the chip
   opens the instructions as they were sent, read only.

## States

- No skills: the list shows one muted line that says what a skill is, and the "New skill"
  button.
- A form with a name that is taken, a name that is too long, or empty instructions: the form
  shows the reason under the field and does not save.
- A chip in the box, and the skill is turned off, deleted, or no longer for this agent before the
  user sends: the send is refused with the line "This skill is not available." The chip stays
  so the user can remove it.

## Rules

- The message stores the name of the skill and a copy of its instructions at the time of sending.
  A later edit or delete of the skill does not change old messages.
- Edit of the last message of the user keeps its chip and its copy. Retry and a queued message
  keep them too.
- A message needs text, a file, or a chip. A chip alone is valid.
- A server holds at most 100 skills.
- Skills work in direct chats and threads. They do not work in channels, routines or workflows in
  this version.
- Skills are stored in the local database. An export holds them (see 014). An agent file (see
  002) does not.
- A skill is not a secret store. The instructions go to the model provider with the message, as
  any message does.

## Out of scope

- A skill that an agent picks by itself.
- Parameters in a skill, such as a blank to fill in.
- Skills in channels, routines and workflows.
- Share or import of skills as files.
- Editing the skills of a runtime.

## Acceptance

- Make a skill "Weekly summary" for all agents. Open a chat, type `/we`: the list shows the
  skill after the commands. Pick it, type "for the team", send: the row shows the chip and the
  text, and the agent gets the instructions before the text.
- Send the chip alone: the message is sent.
- Edit the instructions after the send. Open the chip of the old message: it shows the old
  instructions.
- Make a skill for one agent. In the chat of another agent, `/` does not list it.
- Turn the skill off with its chip already in the box, and send: the send is refused with the
  message above. Remove the chip and send: it works.
- Make a skill with the name of an existing skill in other case: the form refuses it.
- With 100 skills, the form for one more refuses to save.
- Export, then import into an empty app: the skills are back.
