# 002 Agents

## Purpose

The user makes agents, gives each one a clear identity and job, and changes them later without
losing their history.

## Concepts

An agent has:

- **Name**: 1 to 40 characters, unique on its server.
- **Face**: a generated round avatar with a hue and a shape (see "Avatars"). The user can pick
  another shape and one of ten hues, or upload an image.
- **Role line**: up to 120 characters. It is the job title of the agent. An agent has one. It works
  as a label: the user picks it from a list, adds a new one, and removes it with one click (see
  "Role label"). It shows under the name in profiles and as a badge in the place list (see 001,
  "Place rows"). Settings list all role lines (see 013).
- **Instructions**: free text that the agent always follows.
- **Read the handbook**: a switch, on by default. See "Handbook".
- **Model**: the provider and model it uses (see 006), and an effort level when the model has one.
- **Backup model**: optional. The model that takes the turns of the agent while its main model is
  held because a limit is spent (see 006, "Backup model"). It starts as "None".
- **Workspace**: a folder on the computer that belongs to this agent (see 007).
- **Section**: the user section of the Agents list that it shows in, or none. With none, the agent
  shows in "Unassigned" (see 001, "User sections").
- **Main agent**: a switch. At most one agent on a server is the main agent.
- **State**: idle, working, waiting for the user, or offline (its provider is not connected).

## Flows

1. Create: the user clicks "New agent", types a name, optionally a role and instructions, and
   picks a model. A "Section" choice lists the agent sections and "No section". It starts at
   "No section". The app creates the workspace folder and opens the direct chat.
   - **Effort** (see 006): the field shows when the model has levels. It offers "Default", which
     lets the model use its own level, and the levels of the model. In this form the field starts
     at "Medium" when the model offers it, and at "Default" when it does not. A lower level uses
     fewer tokens, so a new agent starts at the middle level, and the user can raise it.
   - The start counts only until the user picks a level or "Default" by hand. The pick of the user
     stays when the user picks another model that offers the same level. When the new model does
     not offer the level, the field goes to "Default", as before.
   - The start is for the form of a new agent (this flow) and for a starter (flow 3) only. It
     does not change the effort of an agent that exists, of a duplicate (flow 6), of an import
     (flow 10), or of a chat header, a routine or a workflow step. A change from the chat (see
     "Changes from the chat") changes the effort only when the user asks for it.
   - The same form on a linked computer starts the same way. The phone makes no agent in this
     version. The effort is the field that an agent has now, so a sync, an export and a file of
     agents hold nothing new. An agent on a vendor runtime gets the level as before, when its model
     has levels.
2. Random name: the name box of a new agent starts with a random English first name. A button
   next to the box picks another name. The same button is in the agent profile. The list holds at
   least 80 first names. A pick skips names that agents on the server already use, ignoring case.
   When every name is used, a number follows the name. The names stay English in every
   interface language.
3. Create from a starter: the user picks one of the starters (see "Starters"). The fields are
   filled in and can be changed.
4. Edit: the user opens the agent profile and changes any field, also the section. Changes apply to
   the next turn. A change of section applies at once.
5. Choose a role line: the role field of the form and of the profile shows a list of the role
   lines that other agents use. The user picks one or types a new one, and can remove it again
   (see "Role label").
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
    "Skills of these agents" and "Handbook". The app writes one file. Import agents: the user
    picks such a file. The app shows the review screen (see 014, "Review before an import"), asks for one model for all of them (see
    006), and asks to confirm.
11. Recent work: the profile lists the latest tasks of the agent (see "Recent work").
12. Organizations: the profile has a row "Organizations" with the organizations of the agent, and
    each skill and connection that the agent has from an organization shows the line "From
    <organization>" (see 030). A deleted agent leaves every organization.

## Role label

The field "Role" of the form of a new agent and of the profile works like a label field.

- **Shape**: with a role line, the field shows it as a chip with a "Remove" button at its end.
  With no role line, the field shows a muted "Choose a role" button. A click on the chip or on
  the button opens the list.
- **List**: a text box is at the top and has focus when the list opens. Under it are the roles
  that agents of this server have now (see 013, "Roles"), in alphabetical order. A choice shows
  the role and the number of agents that have it. The count is of the saved agents, so a pick that
  is not saved yet changes no count. The role of this agent, as the form holds it now, shows a
  check.
- **Filter**: typed text keeps the roles that hold it, ignoring case. When the typed text, after
  spaces at both ends are removed, is not empty and is not the same as a listed role (ignoring
  case), the last choice is "Add <text>". "Add" is off for a text over 120 characters, and a muted
  line says why.
- **Pick**: a click on a choice, or Enter on the choice that has the bar, sets the role line and
  closes the list. The bar marks the choice for the keys. It starts on the role that is the same
  as the typed text, ignoring case, or on the first choice when none is. Up and down move it.
  Escape closes the list and changes nothing. Typed text that is the same as a listed role
  (ignoring case) gets the spelling of the list, so "designer" picks "Designer".
- **Remove**: "Remove" empties the role line of this agent. It changes no other agent. The role
  line is optional.
- **Save**: a pick, an add and a remove change the form. The agent changes when the user saves the
  form (flow 4), as for every other field. A role that no agent has after the save leaves the
  list (013).
- **Other ways to a role line**: a starter, an import, a duplicate and the agent itself in the
  chat (see "Changes from the chat") set the same field. The chip shows it in the same way. A
  role line wider than the chip is cut with "…", and the whole text shows in a note when the
  pointer rests on the chip.
- **Other devices**: on a linked computer that lets this device create and change agents (012),
  the field works in the same way, with the roles of that server. Without that right, the
  profile shows the chip with no "Remove" button, leaves the whole field out, with its label,
  when the role line is empty, and the list does not open. The phone shows
  the role line as a badge in the place list (001) and follows the computer for the role list
  (011).
- **What the model reads**: a direct chat and a thread do not give the role line to the model. The
  text of a turn holds the handbook and the instructions of the agent. The role line is not in it.
  - A model reads the role line in three places only: the check of the lead (004), the fast pick
    (004), and the answer of the settings tool (002, "Changes from the chat"), which lists it among
    the values of the agent.
  - A turn of a channel names the agent and the names of its members, and no role line (004). The
    instructions of the channel are a separate text in that turn (004, "Rules").
  - So a change of the role line changes no answer of a direct chat. It changes the badge (001), the
    filter of places (001), the Roles page (013), a check of the lead and a fast pick.
  - This rule holds on an API provider and on a vendor runtime: a runtime also gets no role line,
    because the text of the turn holds none.
- **Data**: nothing new. The role line syncs (019), goes in an export (014) and in an agent file,
  as before.
- **Words**: the texts of the field come from the translation catalogue, in English and Korean. A
  role is text of the user and is not translated.

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
  the fields of other agents (the main agent can ask for them with the manage tools, 037, and the user
  allows each change), the handbook, the switch "Read the handbook", the memory check
  (008), the instructions of a channel (004), and the Teams link (028). When the user asks for one
  of these, the agent
  says where in the profile or in settings the user can change it.
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
  no message, no section and no memory note, and no organization, parent, tool or token limit (030). Import makes new channels only. A name that is taken
  gets a number. A channel whose member the user did not tick on the review screen is made without
  that member. A lead that is not made leaves the channel with no lead. A channel with no member
  left is not made, and the review screen lists it under "Not imported" with the reason.
- **Skills in the file**: with "Skills of these agents", the file holds each skill that the picked
  agents may use, with its name, its instructions, and the agents in the file that may use it. A
  skill for all agents is written for the agents in the file only. Import makes new skills only. A
  name that is taken gets a number. An imported skill is off, so the user turns it on after a look
  at its instructions (017).
- **Handbook in the file**: with "Handbook", the file holds the handbook. On import, the review
  screen shows it not ticked, with the first lines and "Show all", which opens the full text. When the user ticks it, it replaces the
  handbook of this server, and the old text stays in the handbook history (see "Handbook").
- The limits stay: at most 40 agents and 10 MB. The file also holds at most 40 channels and 100
  skills. A file over a limit is refused.
- A file of the first format version, with agents only, can still be read.

## Starters

A **starter** is a ready setup for one job. It fills the new agent form. It can also make a routine
and skills for the new agent.

- The choice "Start from" of the form lists "From a goal…" first (see 031), then "Blank" and then the starters in this order:
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
  makes no routine and no skill, and its choice shows no muted line. The choice "From a goal…" does not show on a linked computer (see 031).
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

- The handbook is a page of settings (013), but it is data of the agents, not a setting: it syncs
  (019) and an export holds it (014). It holds 0 to 20000 characters. It is empty at the
  start. An empty handbook gives nothing to any agent.
- Before each turn, an agent with "Read the handbook" on gets the handbook before its own
  instructions. In a channel, the instructions of the channel come after the instructions of the
  agent (004). When two texts say different things, the later text wins. The app tells the agent
  this order. The rules of the app (007, 014) always win over all three texts.
- The switch "Read the handbook" is in the profile of the agent, under the instructions. The user
  turns it off for an agent that must not get it.
- A change of the handbook counts from the next turn. A turn that runs keeps the text that it had.
- No agent can change the handbook, from the chat or with any tool. The handbook page has a
  history of the last 20 versions, with the time and "Restore", as the instruction history has.
- A linked device (012) can read the handbook, and can change it only with the switch "Can create
  and change agents".
- Text that looks like a secret is refused on save, with the reason. The handbook is sent to the
  model provider of each agent that reads it, and the page says so.

## Avatars

An avatar is the small round mark that shows who speaks, or whose place it is. ROBot has four: the
face of an agent, the picture of an agent, the mark of the user, and the mark of a channel. They
follow the theme. In the dark theme they are one family with the app mark: a very dark disc with
a thin rim of light, and features or a glyph of light that glow. The app mark is not an avatar.
It does not change with the theme.

- **Drawn face in the dark theme**: a very dark disc that the hue tints, with a thin rim of light
  in the colour of the hue. The features of the shape are near white, and a soft glow of the
  colour of the hue lies round them. There are six shapes and ten hues, as before. The hue picks
  the colour of the light. It does not pick the colour of the disc. Every shape shows its
  features, the first shape too.
- **Drawn face in the light theme**: a light disc that the hue tints, with a thin rim in the
  colour of the hue. The rim is dark enough to show on a light surface. The features of the shape
  are dark, and the hue tints them. A face has no glow in the light theme, because a glow does
  not show on a light disc. The six shapes, the ten hues, and the rule for the first shape are
  the same as in the dark theme.
- **Contrast**: in both themes, the features of a face stand out from the disc by a contrast of
  7 to 1 or more, at every size.
- **Picture**: an uploaded picture is round and has the same thin rim as a drawn face, in the
  hue of the agent. The theme does not change the picture. Its rim shows in both themes: it
  has the colour of the rim of a drawn face in that theme. A channel picture (004) has the same
  rim, in the colour of the light of the app mark in the dark theme, and in a darker form of that
  colour in the light theme.
- **Mark of the user**: a disc with the same thin rim and one glyph: a person on the desktop, and
  the first letter of the word for "you" on the phone. In the dark theme, the disc is dark and
  the glyph is light. In the light theme, the disc is light and the glyph is dark.
- **Mark of a channel**: a disc with the same thin rim and a `#`. The colours follow the rule of
  the mark of the user. A channel with a picture shows the picture in its place.
- **Theme change**: a change of the theme changes every avatar at once, with no motion. The
  choice "system" works as it does for the rest of the app (013).
- **The glow is still.** It shows in the dark theme only. It does not pulse, move, or change when
  the pointer is over it. A drawn face moves only once, for under 300 ms, at these moments: its
  agent ends a reply (a small nod and a blink), a reply fails (a shake), the agent asks the user a
  question (a small nod), and the agent is new (the face drops in and blinks). A face with closed
  eyes does not blink. With reduced motion, nothing moves.
- **Sizes**: the same drawing at every size, from 16 px to 80 px. In the dark theme, the glow of a
  small avatar is quieter than the glow of a large one, because a small glow cannot show detail.
- **Cost**: avatars must not slow the app. A chat of 500 messages scrolls as smoothly with its
  avatars as it would with flat ones. A list of many avatars, such as the place list or the list
  of messages, draws as fast as a list of flat discs of the same size.
- **Phone**: the phone draws the same avatars, with the same shapes and colours as the desktop
  in the same theme. It follows the theme of the phone (see 011).
- **Form**: the colour swatches of the hues show the colour of the hue, and the preview shows
  the face as it will look in the theme that shows now.

## Rules

- Changing the model keeps the agent's history, memory and workspace.
- A working agent cannot be deleted; the user must stop it first.
- A linked device that the user allows can create, edit, duplicate and archive agents on this
  computer, with limits on the folder, the permission level and the model accounts (012).
- The avatar of an agent is the same everywhere in the same theme: list, messages, activity
  panel, phone.
- Agents made by other ways than the form (an import, a tool of another agent, a starter) keep
  the name they were given.

## Acceptance

- Create an agent, change its model, restart the app: the history is intact and the next reply
  uses the new model.
- Open "New agent" and pick a model that offers "Medium": the field "Effort" shows "Medium". Pick a
  stand-in model that offers only "Low" and "High": the field shows "Default". Choose "Default" by
  hand, then pick a model that offers "Medium": the field keeps "Default".
- In the form, pick a model, choose "High" by hand, then pick another model that offers "High": the
  field keeps "High". Pick a model that does not offer "High": the field shows "Default".
- Make an agent from a starter with a model that offers "Medium": the profile shows "Medium". Save
  another one with "Default" chosen by hand: the profile shows "Default".
- An agent that exists before the change has "Default": its profile and its chat header still show
  "Default" after the update. Duplicate an agent that has "High": the copy has "High". In the dialog
  of an import, the effort starts at "Default".
- The new agent form opens with a first name. Press the name button: the name changes.
- Open "New agent" and open the role list: it lists the roles of the other agents, in alphabetical
  order, with the number of agents of each. Type "Qa tester": the last choice is "Add Qa tester".
  Press Enter: the field shows a chip. Press Create: the profile and the place list show "Qa
  tester".
- Type "designer" while the role "Designer" exists: the list has no "Add" choice. Enter picks
  "Designer".
- Type a role of 121 characters: "Add" is off, with the reason. Press Escape: the list closes and the
  role stays as it was.
- In a profile, press "Remove" and save: the agent has no role and its row has no badge. Another
  agent with the same role keeps it. When no agent has the role, the list no longer shows it.
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
- Change the role line of an agent, then send a message in its direct chat: the request to the
  model holds no role line, and the chat shows the new role as the badge of the row.
  Set the role of a member of a channel with fast pick on, and post a job that fits it: the role
  line of that member is in the request to the decision model. A check of the lead in that channel
  also holds the role line of each member.
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
- Make agents of all six shapes. In the dark theme, each face shows its features and its glow, the
  first shape too. Pick another hue in the form: the colour of the light changes, and the disc
  stays dark.
- In the light theme, the same six faces show dark features on a light disc, with a thin rim in
  the colour of the hue and no glow. Pick another hue in the form: the tint and the rim change,
  and the disc stays light. For all six shapes and ten hues, at 16 px and at 80 px, the features
  stand out from the disc by a contrast of 7 to 1 or more.
- Switch from the dark theme to the light theme: every avatar changes at once, with no motion.
  The mark of the user and the mark of a channel have a light disc and a dark glyph. A picture
  does not change, and its rim shows. The app mark does not change. Switch back: the dark discs
  and the glow come back.
- Choose the theme "system" and change the theme of the system: the avatars follow it.
- Upload a picture: it shows round with a thin rim in the hue of the agent, in the place list, in
  messages and in the form, in both themes. Remove it: the drawn face comes back.
- Look at a chat with many messages from the user and from agents. In the dark theme, the mark of
  the user is a dark disc with a person glyph of light. In the light theme, it is a light disc
  with a dark person glyph. The avatars of agents are the faces. Scroll through the chat in both
  themes: nothing stutters because of the avatars.
