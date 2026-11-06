# 017 Skills

## Purpose

The user saves a set of instructions once and calls it with a slash in any chat, so the user does
not type the same long request again. The agent can also pick a skill by itself: it reads the names
and short notes of its skills, and loads the full text of one only when the task needs it. An
agent can also propose a new skill or a change to a skill that is for it only. The user accepts
each proposal first (002, "Self-improvement").

## Concepts

- **Skill**: a name, a short description, the instructions, the agents that may use it, and an
  on or off switch.
  - The name holds 1 to 40 characters. It is unique, and the check ignores case. A slash at the
    start of the typed name is removed.
  - The description holds up to 140 characters. It may be empty.
  - The instructions hold 1 to 20000 characters of plain text.
  - The agents: "All agents" (the default), or a list of agents that the user picks.
- **Skill chip**: a small tag with the name of a skill. It sits in the message box, and later in
  the message row.
- A **runtime skill** is a skill that an agent runtime reports (see 006). The user cannot edit
  it here. It is not a skill of this spec.
- **Skill list for the agent**: the names and descriptions of the usable skills that have a
  description. "Usable" means on, and for this agent (as the slash list). A skill with an empty
  description stays for slash use only.

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
8. Pick by the agent: at the start of a turn in a direct chat or a thread, the agent reads its
   skill list. When a skill fits the task, it loads the instructions of that skill. It loads one
   skill at a time, and only the skills that the task needs. The chat shows each loaded skill in
   a card with its name. A click on the card opens the instructions as loaded, read only.
   - A skill that is off, deleted, or no longer for this agent before the load is not loaded.
     The load fails with the line "This skill is not available."
   - The slash chip works as before. When a message holds a chip and the agent loads more
     skills, the agent reads the chip first.

## Teach a task

Some tasks are easier to show than to write. The user does the task once in the browser of an
agent, and the agent writes a draft skill from what the user did.

1. The user picks "Teach a task" in the agent profile or in the menu of the chat header. A short
   form asks what the result of the task is (1 to 500 characters), for example "Download this
   week's report and put it in the reports folder". The user picks "Start".
2. The browser of the agent (see 007) opens with the user in control. A bar at the top shows
   "Teaching", the result text, the time, the number of steps, "Pause", "Stop teaching" and
   "Cancel". The agent does not act while the user teaches.
3. The app records each step of the user:
   - a page that opens: its address and its title,
   - a click: the role and the label of the control, or its visible text,
   - text typed into a field: the label of the field and the text,
   - a choice in a list, a key such as Enter or Tab, and a scroll. The app joins scrolls that
     follow each other into one step.
   For a password field, and for a field whose label names a password, a code, a token, a key
   or a card number, the app records "Typed a secret into LABEL", never the text. Text that looks
   like a secret (see 014) in an address or a label becomes `[redacted]`. While the recording is
   paused, the app records nothing.
4. A recording stops by itself at 300 steps or after 30 minutes, with a short line that says
   why. The steps so far stay.
5. "Stop teaching": the app gives the result text and the list of steps to the model of the
   agent in one request, and asks for a draft skill. The chat shows a "Draft skill" card with
   these fields, which the user can edit: the name, the description (when to use the skill), and
   the instructions. The instructions hold the steps in plain words, what to check at the end,
   and when to ask the user first. The card also shows the number of recorded steps.
6. Save: the app makes the skill, as in flow 1, for this agent only, and turned on. The same
   limits and checks apply. The card shows "Saved" and "Try it". "Try it" puts the chip of the
   skill in the message box with the result text after it, and the user sends it.
7. Discard, or "Cancel" during the recording: nothing is saved.

- "Teach a task" needs the browser of the agent. It is not on the phone or on a linked device.
- One recording at a time on a computer. While one runs, "Teach a task" is off for other agents,
  with the reason.
- While the user teaches, the agent cannot start a turn that uses its browser. Such a turn waits
  until the recording ends.
- A recording with no steps cannot make a draft. "Stop teaching" then says so and ends.
- If the model request fails, the card shows the reason and "Try again". The recording stays
  until the user saves or discards.

## Make a skill from work

The user can turn work that went well into a skill, and does not write the instructions by hand.
The draft is a proposal of a new skill (002, "Self-improvement"). The card, the states, the change
log and Undo are in that section.

### Sources

- **A task**: "Make a skill" in the task view (005), for a task in the state done.
- **An article**: "Make a skill" in the view of an article on the knowledge page (016).
- **A memory item**: "Make a skill" in the menu of a row of the tab Items (008).

### Flow

1. The user picks "Make a skill". The page "Self-improvement" of the agent opens with a card that
   shows the muted line "Writing a draft…". The app asks the model account of the agent for a
   draft, in one request, as "Teach a task" does. The agent is the agent of the task, of the
   article or of the item. "Cancel" closes the card, and the app drops the answer. No proposal is
   made.
2. What the request holds:
   - For a task: the prompt of the task, the messages of the user that joined its turns, its final
     reply, and its steps as lines of kind and target (a command, a path or a host, each cut at 200
     characters; at most 40 steps, the oldest dropped first). It holds no output of a tool, no
     thinking, no page and no content of a file.
   - For an article: its title, its summary and its body.
   - For a memory item: its text.
   - The request is at most 20000 characters. Text that looks like a secret (014) is hidden. The
     request asks for a name, a description that tells when to use the skill, and instructions in
     plain words: the steps, what to check at the end, and when to ask the user first.
3. The draft is a proposal of the kind "New skill", with the source "Make a skill", and it waits.
   The card shows the draft. When the name is taken, the app adds a number to the name of the
   draft.
4. "Accept" saves the skill as flow 1, for the agent of the source only, and on. "Edit and accept"
   opens the form of flow 1 with the draft. There the user can edit every field, also the field
   "Agents". "Reject" saves nothing. The same limits, checks and warning about secrets apply.
5. When a turn of the task held outside content (007), the card shows the muted line of 002: "This
   work read outside content. Read the change before you accept." A skill is a lasting order, so
   the user reads it first. Nothing is saved before the user accepts.
6. When the request fails, the card shows the reason and the button "Try again". No proposal is
   made, and nothing is saved.

- "Make a skill" needs a connected model account. Without one, the form shows the same line as
  "Teach a task" does.
- The request makes no task and no message. The limits of how often a proposal can come (002) do
  not apply, because the user starts it.
- A skill made this way has no link to its source. A later change or delete of the source does not
  change the skill.
- "Make a skill" is on the computer only. A linked device (012) and the phone (011) do not show it.

## Skills that the agent proposes

- In a turn, an agent can propose a new skill for itself, or a change to the description or the
  instructions of a skill that is for it only. The proposal follows 002, "Self-improvement": the
  card, the limits, the states and Undo.
- The agent cannot propose a skill for other agents or for all agents, a change of the list of
  agents of a skill, a change of a skill for all agents, a delete, or a change of the switch.
- An accepted new skill is for this agent only and is on, as a skill from "Make a skill" is. It
  counts in the limit of 100. With 100 skills, the accept fails with the reason (002).
- With the switch "Self-improvement" off (002), the agent cannot propose a skill.

## States

- No skills: the list shows one muted line that says what a skill is, and the "New skill"
  button.
- A form with a name that is taken, a name that is too long, or empty instructions: the form
  shows the reason under the field and does not save.
- A chip in the box, and the skill is turned off, deleted, or no longer for this agent before the
  user sends: the send is refused with the line "This skill is not available." The chip stays
  so the user can remove it.
- No skill with a description: the agent reads no list, and the turn runs as before.

## Rules

- The message stores the name of the skill and a copy of its instructions at the time of sending.
  A later edit or delete of the skill does not change old messages.
- Edit of the last message of the user keeps its chip and its copy. Retry and a queued message
  keep them too.
- A message needs text, a file, or a chip. A chip alone is valid.
- A server holds at most 100 skills.
- When the user deletes an agent, the app removes it from the list of agents of every skill. A
  skill whose list held only this agent is deleted with it. A skill for "All agents" and a skill
  for other agents stay. Archive changes no skill. Old messages that used a deleted skill keep
  their chip and their copy.
- A starter (see 002) can make skills for its new agent. They are for that agent only, they are
  on, and they count in the limit of 100. They are shortcuts for the chat. They do not run in a
  routine (see the next rule).
- Skills work in direct chats and threads. They do not work in routines or workflows in this
  version.
- Skills are stored in the local database. An export holds them (see 014). An agent file (see
  002) holds them only when the user ticks "Skills of these agents". An imported skill is off. It
  counts in the limit of 100. A skill over the limit is not made, and the review screen lists it
  under "Not imported" with the reason.
- A skill is not a secret store. The instructions go to the model provider with the message, as
  any message does.
- The turn stores the name and a copy of the instructions of each loaded skill, as sent. A later
  edit or delete does not change the copy.
- Pick by the agent works in direct chats and threads only, as the slash does.
- Reading a skill is allowed at every permission level, also Read only: it reads text that the
  agent may already use.

## Surfaces

- **Ways in**: automatic, plus the slash (flows 6-7). No new button. A proposal of a skill comes
  from the agent or from "Make a skill" (002, "Self-improvement").
- **Devices**: the computer shows the cards. The phone and a linked computer show them as stored
  cards, read only.
- **Runtimes**: every agent. The list is part of the turn, and the load is a tool of the app (as
  the browser is in 026).
- **Ways out**: turn a skill off (it leaves the list), or empty its description (slash only). No
  new switch.
- **Seeing the state**: one card per loaded skill, readable after a restart as part of the stored
  turn.
- **Data**: nothing new syncs or exports beyond the stored turn. No new words.

## Out of scope

- Parameters in a skill, such as a blank to fill in.
- Skills in routines and workflows.
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
- With a stand-in model: a task in the state done has a prompt, two steps and a reply. Press "Make a
  skill" in the task view: a card opens, then shows the draft of the stand-in as a proposal that
  waits. The request to the stand-in holds the prompt, the two steps and the reply, and holds no
  output of a tool. Press "Accept": the skill shows in the list of skills, for the agent of the task
  only, and it is on. In the chat of that agent, `/` lists it. The change log has a row Applied.
- Press "Edit and accept" on such a card: the form of a new skill opens with the draft, and Save
  makes the skill with the edited fields.
- A task whose turn held outside content: the card shows "This work read outside content. Read the
  change before you accept."
- "Make a skill" on an article and on a memory item: the card fills in the same way.
- The stand-in fails: the card shows the reason and "Try again", and no proposal and no skill is
  made. Press "Cancel" while the draft is written: the card closes and no proposal is made.
- With 100 skills, "Make a skill" makes the proposal, and "Accept" fails with the reason.
- Press "Make a skill" four times in one day: four proposals wait, because the limit of how often
  counts only the proposals that the agent starts.
- A stand-in model proposes a change to a skill for all agents: the tool refuses it, and the skill
  does not change.
- On a linked device and on the phone, no "Make a skill" shows.
- Export, then import into an empty app: the skills are back.
- Teach a task with a fake model on a local test page: open the page, click a button, type
  "hello" into a field, type a password into a password field. Stop teaching: the request to the
  model holds the click and "hello", holds "Typed a secret into Password", and does not hold the
  password. The card shows a draft. Save: the skill exists for this agent only and is on.
- Cancel during a recording: no skill and no draft exist.
- Pause, then click: the click is not recorded.
- Make a skill only for agent A, a skill for agents A and B, and a skill for "All agents". Delete
  agent A from the archive: the confirm text says that 1 skill is deleted too. After the delete,
  the first skill is gone, the second is only for B, and the third is unchanged.
- Archive agent A with a skill that is only for A: the skill stays.
- Two usable skills with notes, and a stand-in model that loads one: the turn holds both names,
  the card shows the loaded one, and the instructions of the other are never sent.
- A skill with an empty note is not in the list, but the slash still works.
- A skill turned off before the load fails with "This skill is not available."
- Chip plus a pick by the agent: the chip is read first.
