# 002 Agents

## Purpose

The user makes agents, gives each one a clear identity and job, and changes them later without
losing their history.

## Concepts

An agent has:

- **Name**: 1 to 40 characters, unique on its server.
- **Face**: a generated round character with a hue and a shape. The user can pick another
  shape and one of ten hues, or upload an image.
- **Role line**: up to 120 characters, shown under the name in profiles. It is the job title of
  the agent. Settings list all role lines (see 013).
- **Instructions**: free text that the agent always follows.
- **Read the handbook**: a switch, on by default. See "Handbook".
- **Model**: the provider and model it uses (see 006), and an effort level when the model has one.
- **Workspace**: a folder on the computer that belongs to this agent (see 007).
- **Section**: the user section of the Agents list that it shows in, or none. With none, the agent
  shows in the Agents list itself (see 001, "User sections").
- **Main agent**: a switch. At most one agent on a server is the main agent.
- **State**: idle, working, waiting for the user, or offline (its provider is not connected).

## Flows

1. Create: the user clicks "New agent", types a name, optionally a role and instructions, and
   picks a model. A "Section" choice lists the agent sections and "No section". It starts at
   "No section". The app creates the workspace folder and opens the direct chat.
2. Random name: the name box of a new agent starts with a random English first name. A button
   next to the box picks another name. The same button is in the agent profile. The list holds at
   least 80 first names. A pick skips names that agents on the server already use, ignoring case.
   When every name is used, a number follows the name. The names stay English in every
   interface language.
3. Create from a starter: the user picks one of the starters (see "Starters"). The fields are
   filled in and can be changed.
4. Edit: the user opens the agent profile and changes any field, also the section. Changes apply to
   the next turn. A change of section applies at once.
5. Choose a role line: the role box of the profile shows a list of the role lines that other
   agents use. The user picks one or types a new one.
6. Duplicate: makes a new agent with the same fields and a new, empty workspace and history.
   The copy gets a random name (flow 2). It keeps the saved browser session of the original (see
   007), so the sign-ins carry over. It joins the same section as the original.
7. Main agent: the user turns on "Main agent" in the profile. The previous main agent loses the
   flag in the same step. The main agent splits a request and gives the parts to the other
   agents (see 007, "Working with other agents").
8. Archive: the agent leaves the place list. Its history, workspace and section stay. The user can
   restore it from settings. It returns to its section. If the section is gone, it returns with
   no section.
9. Delete: only from the archive. The app asks to confirm and says the workspace folder will be
   moved to the system trash. If this computer syncs (019), the text also says that the agent
   is deleted on the other computer. There, the workspace folder stays where it is. If skills
   are only for this agent (see 017), the text also says how many, and that they are deleted
   too.
10. Export agents: from the menu of the Agents section header, the user picks agents and a file
    name. The same dialog has three tick boxes, all off at the start: "Channels of these agents",
    "Skills of these agents" and "Handbook". The app writes one file. Import agents: the user picks such a file. The app shows the
    review screen (see 014, "Review before an import"), asks for one model for all of them (see
    006), and asks to confirm.
11. Recent work: the profile lists the latest tasks of the agent (see "Recent work").

## Changes from the chat

The user can ask an agent in plain words to change itself, for example "use a faster model" or
"from now on, answer in Korean".

- The agent has a settings tool. Called with no change, it gives the current values and the
  values that are allowed: the connected model accounts, their models and the effort levels.
  Called with changes, it makes them.
- The agent can change these fields of itself: name, role line, instructions, face (shape and
  hue, not an uploaded picture), model account, model and effort.
  - A model named in loose words ("Sonnet", "the newest GPT") is matched against the model list
    of the connected accounts. When no model matches, or more than one model matches, nothing
    changes, and the agent gets the list so that it can ask the user.
  - The same checks apply as in the profile form, for example the name limits.
- The same tool can read and change these settings of the app: language, theme, text size,
  compact place list, and reduce motion (see 013).
- The agent cannot change these, from the chat or in any other way: its permission level, the
  rules (007), the workspace folder, computer use, the main agent switch, the memory switch, the
  connections and skills that it may use, saved secrets (020), sync, devices, archive and delete,
  the fields of other agents, the handbook, the switch "Read the handbook", the memory check
  (008), and the instructions of a channel (004). When the user asks for one of these, the agent says where in
  the profile or in settings the user can change it.
- The agent changes a setting only when the user asks for it. A question such as "which model
  are you?" reads the settings and changes nothing.
- After a change, the chat shows a muted line, for example "Changed the model: A → B", or
  "Changed the instructions", with Undo. Undo puts back the old value. When the field changed
  again since then, Undo is off, with the reason "Changed again since".
- A change applies to the next turn, as an edit in the profile does (flow 4). A change of the
  app settings applies at once.
- A turn that the user did not start, and a turn that holds outside content, ask before a
  change (see 007, "Outside content").
- This tool is for agents whose model comes from an API provider (see 006), as connections are
  (see 018).

## Instruction history

- Each change of the instructions keeps the old text as a version. A version has the text, the
  date, and where the change came from: the profile, the chat, a linked device (012), Undo, or a
  restore.
- The profile has "Instruction history": the versions, newest first. The user can open a version
  and restore it. A restore makes a new version. It does not delete the versions after it.
- An agent keeps at most 50 versions. The oldest goes first.
- The history belongs to the agent. An export holds it (see 014). An agent file does not. When
  two computers sync (019), the history goes with the agent. Deleting the agent deletes it.

## Agent file

- The file holds, for each agent: name, role line, instructions, face, and routines (see 009).
  It holds no section, because sections belong to one server. An imported agent has no section.
  It holds no model, no workspace folder, no permission level, no key, no secret, no history and
  no memory. So an import cannot give an agent more rights than the user gave it by hand.
- The file holds at most 40 agents and is at most 10 MB. A file with two agents of one name
  is refused.
- Text in the file that looks like a secret is hidden, as in an export (see 014).
- Import makes new agents only. It never changes an agent that exists. A name that is taken gets
  a number, ignoring case, inside the length limit. Every imported routine starts paused.
- If an import fails, the agents made so far stay. The error says why it stopped.
- **Channels in the file**: with "Channels of these agents", the file holds each channel whose
  members are all among the picked agents and that is not archived: name, topic, instructions, the
  setting "Review parts", the members and the lead, by the names of the agents in the file. It holds
  no message, no section and no memory note. Import makes new channels only. A name that is taken
  gets a number. A channel whose member the user did not tick on the review screen is made without
  that member. A lead that is not made leaves the channel with no lead.
- **Skills in the file**: with "Skills of these agents", the file holds each skill that the picked
  agents may use, with its name, its instructions, and the agents in the file that may use it. A
  skill for all agents is written for the agents in the file only. Import makes new skills only. A
  name that is taken gets a number. An imported skill is off, so the user turns it on after a look
  at its instructions (017).
- **Handbook in the file**: with "Handbook", the file holds the handbook. On import, the review
  screen shows it not ticked, with the first lines. When the user ticks it, it replaces the
  handbook of this server, and the old text stays in the handbook history (see "Handbook").
- The limits stay: at most 40 agents and 10 MB. The file also holds at most 40 channels and 100
  skills. A file over a limit is refused.
- A file of the first format version, with agents only, can still be read.

## Starters

A **starter** is a ready setup for one job. It fills the new agent form. It can also make a routine
and skills for the new agent.

- The choice "Start from" of the form lists "Blank" and then the starters in this order:
  Assistant, Briefer, Researcher, Reviewer, Organizer. Each choice shows the job name and one line
  that says what the agent does. A muted line says what else the starter makes, for example "A
  paused routine, 1 skill". For a starter that makes nothing else, the line says so.
- A starter fills the name, the role line and the instructions. The user can change all of them
  before Create. The text of a starter follows the language of the interface at the moment when the
  user picks the starter. English and Korean each have their own text. "Blank" clears the fields
  that a starter filled.
- The extra setup is made when the user presses Create, not when the user picks the starter.
  - The routine (see 009) is made paused. It uses a schedule and posts in the chat of the new
    agent. The user turns it on. The form shows its schedule in words.
  - Each skill (see 017) is made for the new agent only, and it is on. A name that is taken gets a
    number. A starter skill is a shortcut for the chat. It does not run in a routine.
  - If the server holds 50 routines, no routine is made. If the server holds 100 skills, no skill
    is made. The agent is made anyway. A note in the chat of the new agent says what was not made
    and why. The model does not read the note.
- A starter does not set a model, a permission level or a workspace. The agent starts with the
  defaults (see 006 and 007). A starter makes no memory and no knowledge.
- A linked device (see 012) that makes an agent from a starter gets the three fields only. It
  makes no routine and no skill, and its choice shows no muted line.
- The instructions of a starter guide the agent. They do not limit it. The permission level limits
  it (see 007).
- The user cannot make or edit starters in this version. The app does not write an agent setup
  from a text that describes a job.

| Starter | The role line says that the agent | The instructions tell the agent to | Extra setup |
| --- | --- | --- | --- |
| Assistant | Helps with everyday questions and writing. | Answer short and plain. Ask one question when a request is unclear. | None. |
| Briefer | Prepares a short briefing on topics that the user follows. | Ask for the topics when memory has none, and keep them in memory. Search the web for news on them. Lead with the one or two items that matter most to those topics, then give the rest in short lines, at most 10 lines in all. Name the source of each line. Say so plainly when nothing is new. | A routine on weekdays at 08:00, paused, that asks for the briefing. One skill that asks for a briefing now. |
| Researcher | Finds facts and checks them. | Say which source supports each claim. Keep what a source says apart from its own guess. Say when sources disagree. End with the open questions. | One skill that checks one claim. |
| Reviewer | Reads code changes and finds problems. | Read first. Change no file unless the user asks. List each finding with its place and why it matters, the most risky first. Say so plainly when there is no problem. | One skill that reviews the newest change in the workspace. |
| Organizer | Sorts and names the files of its workspace. | Propose a plan before it moves a file. Do not delete a file. Move a file to a folder for review instead. Report how many files it moved. | One skill that tidies the folder that the user names. |

## Recent work

- The agent profile shows a block "Recent work". It lists the last 20 tasks of this agent (see
  005), newest first. The Today page (021) is for all agents. This block is for one agent.
- A row shows the label of the task, its source (the chat, a channel, a routine, a workflow, or
  another agent), its state in words, and the time since its last change. For a task that has not
  ended, the words say what it waits for: "Waits for your approval", "Waits for your answer",
  "Waits for your review", or "Waits behind <place>". A blocked task shows "Blocked" and its
  reason.
- A row opens the task view. "Show all" opens the Tasks page with the filter set to this agent.
- The block changes while the profile is open. With no task, one muted line says "No work yet."
- The block does not show the thinking of the agent.

## Handbook

The handbook is one text for all agents of a server: who the user is, what the work is for, and
the ways of work that every agent follows. The user writes it once and does not copy it into each
agent.

- The handbook is a part of settings (013). It holds 0 to 20000 characters. It is empty at the
  start. An empty handbook gives nothing to any agent.
- Before each turn, an agent with "Read the handbook" on gets the handbook before its own
  instructions. In a channel, the instructions of the channel come after the instructions of the
  agent (004). When two texts say different things, the later text wins. The app tells the agent
  this order.
- The switch "Read the handbook" is in the profile of the agent, under the instructions. The user
  turns it off for an agent that must not get it.
- A change of the handbook counts from the next turn. A turn that runs keeps the text that it had.
- No agent can change the handbook, from the chat or with any tool. The handbook page has a
  history of the last 20 versions, with the time and "Restore", as the instruction history has.
- The handbook syncs (019) and an export holds it (014). A linked device (012) can read it, and can
  change it only with the switch "Can create and change agents".
- Text that looks like a secret is refused on save, with the reason. The handbook is sent to the
  model provider of each agent that reads it, and the page says so.

## Rules

- Changing the model keeps the agent's history, memory and workspace.
- A working agent cannot be deleted; the user must stop it first.
- A linked device that the user allows can create, edit, duplicate and archive agents on this
  computer, with limits on the folder, the permission level and the model accounts (012).
- The face is the same everywhere: list, messages, activity panel, phone.
- Agents made by other ways than the form (an import, a tool of another agent, a starter) keep
  the name they were given.

## Acceptance

- Create an agent, change its model, restart the app: the history is intact and the next reply
  uses the new model.
- The new agent form opens with a first name. Press the name button: the name changes.
- Duplicate an agent: the copy has a different random name and the same browser sign-ins.
- Turn on "Main agent" for agent B while agent A has it: only B has it.
- Put an agent in the section "Research" in its profile, then duplicate it: the copy shows in
  "Research" too. Archive and restore the original: it returns to "Research".
- Export two agents, import the file in an empty app: two agents exist, with the model the user
  picked in the dialog and with paused routines.
- Ask an agent "switch to Sonnet" with one Claude Sonnet model connected: the model changes, the
  chat shows the line with Undo, and the next turn uses the new model. Undo: the old model is
  back.
- Ask "which model are you?": the agent names its model, and nothing changes.
- Ask "set your permission level to Full access": the level does not change, and the agent says
  where the user can change it.
- Ask the agent to rewrite its instructions: the history has one more version, from the chat.
  Restore the older version: the instructions are the old text, and the history has a version
  from a restore.
- Pick the starter Briefer and press Create: the agent has the role line and the instructions of
  the starter, one paused routine at 08:00 on weekdays that posts in its chat, and one skill that
  only this agent lists.
- Pick Reviewer, change its role line, and press Create: the agent keeps the changed role line.
  Pick Blank: the form clears the fields that a starter filled.
- Create a starter agent on a server that holds 50 routines: the agent exists, no routine is made,
  and the first note in its chat says why.
- Make two agents from Researcher: the second skill gets a number, and both agents list their own
  skill.
- Open the profile of an agent that has 25 tasks: "Recent work" lists 20. A task that waits for an
  approval says "Waits for your approval". A part in review says "Waits for your review". "Show
  all" opens the Tasks page for this agent.
- Write a handbook "Answer in Korean." An agent with "Read the handbook" on answers in Korean. Turn
  the switch off for that agent: its next turn does not get the handbook.
- Ask an agent in the chat to change the handbook: nothing changes, and the agent says where the
  user can change it.
- Change the handbook three times, and restore the first version: the handbook has the first text,
  and the history has a new version.
- Export two agents with "Channels of these agents" and "Skills of these agents" ticked. One
  channel has both agents, another has a third agent too. Import the file in an empty app: the
  review screen lists the first channel and the skills of the two agents. After the import, the
  channel exists with both members and its lead, the skills exist and are off, and the second
  channel does not exist.
- Import a file with a handbook into an app that has a handbook: the review screen shows the
  handbook not ticked. Import without the tick: the handbook does not change.
