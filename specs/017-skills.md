# 017 Skills

## Purpose

The user saves a set of instructions once and calls it with a slash in the chat of a workflow, so
the user does not type the same long request again. The responsible document can also pick a skill
by itself: it reads the names and short notes of the skills, and loads the full text of one only
when the task needs it. The user's own skills also stay as texts that a node prompt can include
(010).

## Concepts

- **Skill**: a name, a short description, the instructions, and an on or off switch. A skill
  belongs to the server of the user. It is not for one workflow.
  - The name holds 1 to 40 characters. It is unique, and the check ignores case. A slash at the
    start of the typed name is removed.
  - The description holds up to 140 characters. It may be empty.
  - The instructions hold 1 to 20000 characters of plain text.
- **Form of a skill**: a name, a description and a text of instructions. The responsible document
  (002) and the prompt of a node (010) have this form.
- **Skill chip**: a small tag with the name of a skill. It sits in the message box, and later in
  the message row.
- A **runtime skill** is a skill that a runtime reports (see 006). The user cannot edit it here. It
  is not a skill of this spec.
- **Skill diet**: the cuts that the app makes to the draft of a skill so that it is short (see "Make
  a skill from a workflow"). A diet never adds words.
- **Skill check**: a list of facts about a saved skill, each with "OK" or a reason (see "Skill
  check").
- **Skill list for the responsible document**: the names and descriptions of the usable skills that
  have a description. "Usable" means on (as the slash list). A skill with an empty description
  stays for slash use only.

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
6. Use: in the chat of a workflow, the user types a slash as the first character (see 003). The
   list shows the skills that are on (see 003, flow 7). The user picks one with the mouse or with
   Enter. The slash text leaves the box and a chip takes its place at the start of the box.
   - The user can type more text after the chip, or send the chip alone.
   - One chip at a time. Picking a second skill replaces the first.
   - The user removes the chip with its close button, or with Backspace at the start of the box.
7. Send: the responsible document reads the instructions of the skill first, then the text of the
   user, as one message. The chat row shows the text of the user with the chip above it. A click
   on the chip opens the instructions as they were sent, read only.
8. Pick by the responsible document: at the start of a turn in the chat of a workflow, the
   responsible document reads the skill list. When a skill fits the task, it loads the instructions
   of that skill. It loads one skill at a time, and only the skills that the task needs. The chat
   shows each loaded skill in a card with its name. A click on the card opens the instructions as
   loaded, read only.
   - A skill that is off or deleted before the load is not loaded. The load fails with the line
     "This skill is not available."
   - The slash chip works as before. When a message holds a chip and the responsible document
     loads more skills, it reads the chip first.
9. In a node prompt: a text node prompt can include the text of a skill of the user (010).
10. From a workflow: the user makes a skill from the nodes of a workflow (see "Make a skill from a
    workflow").
11. Check: the user runs the skill check on a skill (see "Skill check").

## Teach a task

Some tasks are easier to show than to write. The user does the task once in the browser of the
workflow, and the chat writes a draft skill from what the user did.

1. The user picks "Teach a task" in the menu of the chat header of a workflow. A short form asks
   what the result of the task is (1 to 500 characters), for example "Download this week's report
   and put it in the reports folder". The user picks "Start".
2. The browser of the workflow (see 007) opens with the user in control. A bar at the top shows
   "Teaching", the result text, the time, the number of steps, "Pause", "Stop teaching" and
   "Cancel". No node acts while the user teaches.
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
5. "Stop teaching": the app gives the result text and the list of steps to the model of the chat
   in one request, and asks for a draft skill. The chat shows a "Draft skill" card with these
   fields, which the user can edit: the name, the description (when to use the skill), and the
   instructions. The instructions hold the steps in plain words, what to check at the end, and when
   to ask the user first. The card also shows the number of recorded steps.
6. Save: the app makes the skill, as in flow 1, turned on. The same limits and checks apply. The
   card shows "Saved" and "Try it". "Try it" puts the chip of the skill in the message box with the
   result text after it, and the user sends it.
7. Discard, or "Cancel" during the recording: nothing is saved.

- "Teach a task" needs the browser of the workflow. It is not on the phone or on a linked device.
- One recording at a time on a computer. While one runs, "Teach a task" is off for other
  workflows, with the reason.
- While the user teaches, no text node of the workflow can start a task that uses its browser. Such
  a task waits until the recording ends.
- A recording with no steps cannot make a draft. "Stop teaching" then says so and ends.
- If the model request fails, the card shows the reason and "Try again". The recording stays
  until the user saves or discards.

## Make a skill from a workflow

The user turns the steps of a workflow into one skill, so that the user can call the steps with a
slash in another chat. The skill is a copy. It has no link back to the workflow.

1. Start: the workflow view has the button "Make a skill". It reads the workflow and does not change
   it. It works while a run goes, and at every permission level. A workflow with no node cannot make
   a skill: the button shows the line "This workflow has no node." and nothing opens.
2. Draft: the app writes a draft from the workflow. It asks no model and sends nothing out, so it
   needs no account and no key. The draft has three fields:
   - The name: the name of the workflow, cut to 40 characters. A name that is taken gets a number
     (flow 3 of this spec).
   - The description: the first sentence of the responsible document. If that text is empty, the
     description is "Do the steps of the workflow NAME." It holds at most 140 characters.
   - The instructions: one numbered step for each node, in the order of the node numbers.
     - A text node: its prompt.
     - A decision node: its question, and for each option the number of the step that it goes to,
       as in "If the answer is "Yes", go to step 4."
     - An approval node: "Ask the user: QUESTION. If the user rejects it, go to step N." When the
       rejection has no connection, the step says "If the user rejects it, stop."
   - The draft holds no folder path, no provider, no model, no reasoning level, no mark and no
     schedule of the workflow.
3. Diet: the app cuts the draft before it shows it. The cuts are:
   - The words `{{input}}` and `{{trigger}}` go away. A skill has no input of nodes.
   - A line that is empty, or that repeats a line before it (ignoring case and spaces), goes away.
     Spaces at the end of a line and doubled spaces go away.
   - Text that looks like a secret (see 014) becomes `[redacted]`.
   - The instructions hold at most 4000 characters. When they are longer, each step keeps its first
     sentences, up to an equal share of the 4000 characters, and a cut step ends with "…". A step
     that is within its share stays whole.
   The card shows the length before the diet, the length after it, and the saved part in percent. A
   draft that the diet did not change says "Nothing to cut."
4. Review: the draft shows as a card with the three fields, which the user can edit, and with the
   lines of flow 1 about secrets. The edit has no diet: the user may write more than 4000
   characters, up to the limit of the form (20000). The card has "Save" and "Discard".
5. Save: the app makes the skill, as in flow 1, turned on. The same limits and checks apply: a
   full server (100) refuses the save, and an edited name that is taken is refused with the reason
   under the field. After the save, the card runs the skill check at once and shows the result. The
   card has "Try it". "Try it" puts the chip of the skill in the message box of the open workflow,
   with no text after it.
6. Discard: nothing is saved.

- "Make a skill" needs this computer. It is not on the phone, and not on a linked client.
- A later change of the workflow does not change the skill. A later change of the skill does not
  change the workflow. Delete of either one changes nothing in the other.
- Two saves from the same workflow make two skills. The second name gets a number.

## Skill check

The skill check answers one question: "Can the app find and load this skill?" It reads facts about
the skill and about the other skills of the server. It asks no model.

1. Start: it runs by itself after "Save" of a skill from a workflow. The user can also run it on any
   skill: each row of the list of skills has "Check".
2. The facts, in this order. Each shows "OK" or its reason:
   - **Saved**: the skill is in the list of the server.
   - **On**: the skill is turned on. If it is off, the reason says that it is off and that it does
     not show in the slash list.
   - **Listed**: the description is not empty, so the responsible document reads the skill in its
     skill list (flow 8). If it is empty, the reason says that the skill works with the slash only.
   - **Slash**: a slash and the first letters of the name show the skill in the slash list of a
     chat. No other skill has the same name, ignoring case. If another skill has it, the reason names
     that skill.
   - **Loads**: the instructions load as saved, and they are not empty.
   - **No secret**: the instructions and the description hold no text that looks like a secret.
   - **Lean**: the description holds at most 140 characters, and the instructions hold at most 4000.
     A longer text shows "Long" with its length, and says that the skill still works. "Long" is not
     a failure.
3. The result is a list of lines, one for each fact. A reason is a short sentence. The result stays
   on the screen until the user closes it, and it is not stored.
4. The check changes nothing. It never deletes, edits or turns on a skill. A failed fact leaves the
   skill as it is.
5. The words of the check say what it saw. They do not say that the skill "works", "is verified" or
   "is correct". The check does not test that a model picks the skill for a task.

## Skills and self-improvement

- Self-improvement (002, 010) proposes changes to the responsible document, to a node prompt, to
  the graph and to the memory. It does not propose a new skill or a change to a skill in this
  version. The flow "Make a skill" from a task, an article or a memory item is not part of
  this version.
- A skill changes only when the user changes it (flows 1 to 5, "Teach a task", "Make a skill from a
  workflow"). The responsible document, the self-improvement and the skill check never make or
  change a skill.

## States

- No skills: the list shows one muted line that says what a skill is, and the "New skill"
  button.
- A form with a name that is taken, a name that is too long, or empty instructions: the form
  shows the reason under the field and does not save.
- A chip in the box, and the skill is turned off or deleted before the user sends: the send is
  refused with the line "This skill is not available." The chip stays so the user can remove it.
- No skill with a description: the responsible document reads no list, and the turn runs as before.

## Rules

- The message stores the name of the skill and a copy of its instructions at the time of sending.
  A later edit or delete of the skill does not change old messages.
- Edit of the last message of the user keeps its chip and its copy. Retry and a queued message
  keep them too.
- A message needs text, a file, or a chip. A chip alone is valid.
- A server holds at most 100 skills.
- A skill is not tied to a workflow. Deleting a workflow changes no skill. Old messages that used a
  deleted skill keep their chip and their copy.
- The slash and the pick by the responsible document work in the chat of a workflow. The use of a
  skill in a node prompt is in flow 9.
- Skills are stored in the local database. An export holds them (see 014). A workflow file (010)
  holds the prompts as strings.
- A skill is not a secret store. The instructions go to the model provider with the message, as
  any message does.
- The turn stores the name and a copy of the instructions of each loaded skill, as sent. A later
  edit or delete does not change the copy.
- Reading a skill is allowed at every permission level, also Read only: it reads text that the
  responsible document may already use.

## Surfaces

- **Ways in**: the slash (flows 6-7), automatic pick (flow 8), "Teach a task" (the menu of the chat
  header), the node prompt (flow 9), "Make a skill" (the workflow view, flow 10), and "Check" (a
  row of the list of skills, flow 11).
- **Devices**: the computer shows the cards. The phone and a linked computer show them as stored
  cards, read only. "Make a skill" and "Check" are for this computer only.
- **Runtimes**: every provider. The list of skills is part of the turn, and the responsible document
  loads a skill when the task needs it.
- **Ways out**: turn a skill off (it leaves the list), or empty its description (slash only).
  "Discard" closes a draft, and the user closes the result of a check. No new switch.
- **Seeing the state**: one card per loaded skill, readable after a restart as part of the stored
  turn.
- **Data**: nothing new syncs or exports beyond the stored turn. A draft and the result of a check
  are not stored. The draft of "Make a skill" uses no model and sends nothing out.

## Out of scope

- Parameters in a skill, such as a blank to fill in.
- Share or import of skills as files.
- Editing the skills of a runtime.
- Proposals of a skill by self-improvement (see "Skills and self-improvement").
- A diet that a model writes, and a test that asks a model to pick the skill for a task. Both are
  open (see the questions for 017).
- A link from a skill to its workflow, and an update of a skill when its workflow changes.

## Acceptance

- Make a skill "Weekly summary". Open the chat of a workflow, type `/we`: the list shows the skill
  after the commands. Pick it, type "for the team", send: the row shows the chip and the text, and
  the responsible document gets the instructions before the text.
- Send the chip alone: the message is sent.
- Edit the instructions after the send. Open the chip of the old message: it shows the old
  instructions.
- Turn the skill off: `/` in the chat of any workflow does not list it.
- Turn the skill off with its chip already in the box, and send: the send is refused with the
  message above. Remove the chip and send: it works.
- Make a skill with the name of an existing skill in other case: the form refuses it.
- With 100 skills, the form for one more refuses to save.
- Teach a task with a fake model on a local test page: open the page, click a button, type
  "hello" into a field, type a password into a password field. Stop teaching: the request to the
  model holds the click and "hello", holds "Typed a secret into Password", and does not hold the
  password. The card shows a draft. Save: the skill exists and is on.
- Cancel during a recording: no skill and no draft exist.
- Pause, then click: the click is not recorded.
- While a recording runs, a text node of the workflow that needs the browser waits until the
  recording ends.
- Delete a workflow: the skills stay.
- Export, then import into an empty app: the skills are back.
- No "Make a skill" shows in the task view, in the view of an article or in the menu of a memory
  item. A stand-in model proposes a skill: the tool of self-improvement has no such kind, and
  nothing waits.
- Two usable skills with notes, and a stand-in model that loads one: the turn holds both names,
  the card shows the loaded one, and the instructions of the other are never sent.
- A skill with an empty note is not in the list, but the slash still works.
- A skill turned off before the load fails with "This skill is not available."
- Chip plus a pick by the responsible document: the chip is read first.
- Make a skill from a workflow with three text nodes, where node 2 holds `{{input}}`: the card shows
  a draft with three steps, without `{{input}}`, and with the lengths before and after the diet.
- Make a skill from a workflow with a decision node and an approval node: the steps name the step
  that each option and each answer goes to.
- A prompt with the same line twice: the draft holds it once. A prompt that holds a key in the
  shape of a secret: the draft holds `[redacted]`.
- A workflow whose prompts hold 9000 characters: the instructions hold at most 4000, each step ends
  with "…" only if it was cut, and no step is missing.
- A workflow with no node: "Make a skill" shows "This workflow has no node." and no card opens.
- Make a skill from a workflow, and leave the permission level at "Read only": it works. The folder
  and the workflow do not change.
- Save the draft: the skill exists, is on, and the card shows the skill check with every fact.
  Press "Try it": the chip is in the message box with no text after it.
- Save two drafts of the same workflow: two skills exist, and the second name has a number.
- Edit the workflow after the save: the skill is unchanged. Delete the workflow: the skill stays.
- Discard the draft: no skill exists.
- Run "Check" on a skill that is off: "On" shows the reason, and the skill stays off. On a skill
  with an empty description: "Listed" shows the reason, and "Slash" shows "OK".
- Run "Check" on a skill with 5000 characters of instructions: "Lean" shows "Long" with 5000, and
  no fact is a failure.
- A stand-in model that records its requests: "Make a skill" and "Check" send no request to it.
- On the phone and on a linked client: no "Make a skill" and no "Check".
