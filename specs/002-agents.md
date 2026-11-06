# 002 Agents

## Purpose

The user makes agents, gives each one a clear identity and job, and changes them later without
losing their history. An agent is the whole bot: the agent itself, its skills (017), its Soul and
its self-improvement. With self-improvement, the agent proposes changes to its own Soul, skills and
memory from its work, and the user accepts each one before it applies.

## Concepts

An agent has:

- **Name**: 1 to 40 characters, unique on its server.
- **Face**: a generated round avatar with a hue and a shape (see "Avatars"). The user can pick
  another shape and one of ten hues, or upload an image.
- **Role line**: up to 120 characters. It is the job title of the agent. An agent has one. It works
  as a label: the user picks it from a list, adds a new one, and removes it with one click (see
  "Role label"). It shows under the name in profiles and as a badge in the place list (see 001,
  "Place rows"). Settings list all role lines (see 013).
- **Soul**: a text that says who the agent is: its character, its values, its way of work and its
  limits. The agent follows it in every turn. See "Soul".
- **Role instructions**: one text for each role line, shared by all agents that have that role line.
  See "Role instructions".
- **Read the handbook**: a switch, on by default. See "Handbook".
- **Model**: the provider and model it uses (see 006), and an effort level when the model has one.
- **Backup model**: optional. The model that takes the turns of the agent while its main model is
  held because a limit is spent (see 006, "Backup model"). It starts as "None".
- **Workspace**: a folder on the computer that belongs to this agent (see 007).
- **Section**: the user section of the Agents list that it shows in, or none. With none, the agent
  shows in "Unassigned" (see 001, "User sections").
- **Main agent**: a switch. At most one agent on a server is the main agent.
- **Self-improvement**: a switch, on by default. See "Self-improvement".
- **State**: idle, working, waiting for the user, or offline (its provider is not connected).

## Flows

1. Create: the user clicks "New agent", types a name, optionally a role and a Soul, and
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
   too. If the agent owns workflows (see 010), the text also says how many, and that they have no
   owner then. Any agent can work in them. The workflows stay.
10. Export agents: from the menu of the Agents section header, the user picks agents and a file
    name. The same dialog has two tick boxes, both off at the start: "Skills of these agents" and
    "Handbook". The app writes one file. Import agents: the user
    picks such a file. The app shows the review screen (see 014, "Review before an import"), asks for one model for all of them (see
    006), and asks to confirm.
11. Recent work: the profile lists the latest tasks of the agent (see "Recent work").
12. Workflows: the profile has a row "Workflows" with the workflows that the agent owns (see 010,
    "Owner and participants"). A click on a name closes the profile and shows the card of the
    workflow on the Workflows page. An agent with no workflow shows no row.

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
  text of a turn holds the handbook, the role instructions and the Soul of the agent. The role
  line is not in it.
  - A model reads the role line in one place only: the answer of the settings tool (002, "Changes
    from the chat"), which lists it among the values of the agent.
  - So a change of the role line changes no answer of a direct chat. It changes the badge (001), the
    filter of places (001) and the Roles page (013).
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
- The agent can change these fields of itself: name, role line, Soul, face (shape and hue, not an
  uploaded picture), model account, model and effort.
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
  (008), the choice "Memory saving" (008), the switch "Self-improvement", and the Teams link
  (028). When the user asks for one of these, the agent says where in
  the profile or in settings the user can change it.
- The agent changes a setting only when the user asks for it. A question such as "which model
  are you?" reads the settings and changes nothing. When the agent itself sees that its Soul
  needs a change, it makes a proposal (see "Self-improvement"). It does not change the Soul.
- A change that the user asks for in the chat is not a proposal. The words of the user are the
  approval, and the chat line has Undo.
- After a change, the chat shows a muted line, for example "Changed the model: A → B", or
  "Changed the Soul", with Undo. Undo puts back the old value. When the field changed
  again since then, Undo is off, with the reason "Changed again since".
- A change applies to the next turn, as an edit in the profile does (flow 4). A change of the
  app settings applies at once.
- A turn that the user did not start, and a turn that holds outside content, ask before a
  change (see 007, "Outside content").
- This tool is for agents whose model comes from an API provider (see 006), as connections are
  (see 018).

## Soul

The Soul is a text that says who the agent is: its character, its values, its way of work and its
limits. The user writes it once, and the agent follows it in every turn. "Soul" is the word for
the field that was called "instructions" before. It is the same field, with the same data.

- **Where**: the profile of the agent shows the field "Soul" under the role line. The form of a new
  agent has the same field (flow 1). A muted line under the field says: "Who this agent is: its
  character, its values, how it works, and what it does not do." The user edits the text and saves
  the profile (flow 4).
- **Empty**: a new agent from "Blank" has an empty Soul. The field then shows the muted line as its
  placeholder. An empty Soul gives nothing to the agent. The agent then follows the handbook, its
  role instructions and the rules of the app only. An empty Soul is valid.
- **Order**: before each turn, the agent gets the handbook, then its role instructions, then its
  Soul (see "Handbook"). The Soul comes last, so it wins when two texts say different things. The
  rules of the app (007, 014) always win over all of these texts.
- **Who changes it**: the user in the profile, the agent in the chat when the user asks for it
  (see "Changes from the chat"), and a proposal that the user accepts (see "Self-improvement").
  Each change makes a version in the Soul history. A change counts from the next turn. A turn that
  runs keeps the text that it had.
- **Data**: the Soul syncs (019), an export holds it (014), and an agent file holds it (see "Agent
  file"). A spec that says "the instructions of an agent" means the Soul.
- **Words**: the interface says "Soul". It does not say "instructions", "prompt", "persona" or
  "system prompt" for this text. Role instructions (013) and the instructions of a skill (017) keep
  their names, because they are other texts.

## Soul history

- Each change of the Soul keeps the old text as a version. A version has the text, the date, and
  where the change came from: the profile, the chat, a linked device (012), a request of the manage
  tools that the user allowed (037), an outside program (023), a proposal that the user accepted
  (see "Self-improvement"), Undo, or a restore.
- The profile has "Soul history": the versions, newest first. The user can open a version
  and restore it. A restore makes a new version. It does not delete the versions after it.
- An agent keeps at most 50 versions. The oldest goes first.
- The history belongs to the agent. An export holds it (see 014). An agent file does not. When
  two computers sync (019), the history goes with the agent. Deleting the agent deletes it.

## Self-improvement

An agent proposes changes to its own Soul, its skills and its memory from its work. The user
accepts, edits or rejects each proposal. A proposal applies only after the user accepts it. The
agent never changes itself without approval. This is the only flow for proposals: the memory
proposals of 008 and "Make a skill" of 017 use it.

### Concepts

- **Proposal**: one change that an agent suggests for itself. It has a kind, a target, the new
  text, the old text for a change, a reason, a source, a time and a state. A proposal is not a
  change. The agent does not read a proposal as its Soul, skill or memory.
- **Kinds**:
  - **Soul change**: a new text for the Soul of this agent.
  - **New skill**: a skill for this agent only (017): name, description and instructions.
  - **Skill change**: a new description or new instructions for a skill that is for this agent
    only.
  - **Memory item**: a new fact for the memory of this agent (008).
- **Target**: what a proposal changes. For a Soul change, the Soul of the agent. For a skill change,
  that skill. Each new skill and each memory item is its own target, because it does not exist
  yet.
- **Reason**: one line from the agent that says what in its work led to the proposal. At most 200
  characters.
- **Source**: a turn of the agent, with a link to its chat or its task; a memory check (008); or
  "Make a skill" that the user started (017).
- **State**: one of these.
  - **Waiting**: the proposal waits for the user.
  - **Applied**: the user accepted it, and the change is made.
  - **Rejected**: the user rejected it, or it expired. Nothing changed.
  - **Failed**: the user accepted it, and the change could not be made. Nothing changed.
  - **Undone**: the change was applied, and then the user undid it: with "Undo" in the change
    log, or, for a memory item, with "Undo" in the memory history (008). The change is not there
    any more. Only an Applied row can become Undone.
- **Switch "Self-improvement"**: in the profile of the agent, on by default. When it is off:
  - The agent cannot make a Soul change, a new skill or a skill change.
  - The agent saves no memory item by itself. A new fact is a proposal, as with "Ask me first"
    (008), also when the choice "Memory saving" of the agent is "Save at once". The choice stays as
    the user set it, and it counts again when the switch goes on.
  - "Make a skill" of the user still works. Proposals that wait stay.
  So with the switch off, nothing changes the agent before the user accepts a card.
- **Change log**: the list of the proposals that do not wait any more, with their state.

### Flows

1. **Propose**: in a turn, the agent has a tool of the app that proposes a change. The app checks
   the limits (see "Limits"). When the proposal passes, it is Waiting, and the chat shows a muted
   line after the reply: "Suggested a change to its Soul", "Suggested a skill: <name>", "Suggested
   a change to the skill <name>", or "Suggested for memory". The line has the link "Review". When
   the proposal does not pass, nothing is made, and the tool tells the agent the reason. When the
   reason is that 20 proposals wait, the chat also shows one muted line (see "How many wait").
2. **See**: the profile of the agent has the page "Self-improvement" with two tabs. "Waiting" lists
   the proposals that wait, oldest first. "Change log" lists the change log, newest first. The row
   of the page in the profile shows the number of proposals that wait. The link "Review" opens the
   card in "Waiting". The memory page (008) has the link "Proposals (N)" to the same tab.
3. **Card**: a card shows the kind, the target, the reason, the source and the time. For a Soul
   change and a skill change, it shows the old text and the new text, with the removed and the
   added parts marked. For a new skill and a memory item, it shows the full text. The card has
   three buttons: "Accept", "Edit and accept", and "Reject".
   - **Accept** makes the change as the card shows it. The state is Applied.
   - **Edit and accept** opens the new text in an editor in the card. For a new skill, it opens the
     form of a new skill (017, flow 1) with the draft. In that form, the field "Agents" shows this
     agent only and is locked, so "Edit and accept" cannot give the skill to other agents. The user
     changes the text and saves. The
     edited text is the change. The same limits and checks apply as in the profile or the form. A
     text that does not pass shows the reason and is not saved. "Cancel" closes the editor, and the
     proposal still waits.
   - **Reject** changes nothing. The state is Rejected, with the reason "Rejected by you".
4. **Apply**: the change counts from the next turn. A turn that runs keeps what it had.
   - Soul change: a new version in the Soul history, from "a proposal that the user accepted".
   - New skill: a skill as in 017, flow 1, for this agent only, and on. When the name is taken, the
     app adds a number to the name. Later, the user can give the skill to other agents in the
     form of the skill (017), as for any skill.
   - Skill change: the skill gets the new text. Old messages keep their copies (017).
   - Memory item: a memory item that came from a proposal, and a row in the memory history (008).
5. **Fail**: when the change cannot be made at the moment of the accept, nothing changes. The state
   is Failed, and the change log row shows the reason. The reasons are:
   - The target changed after the proposal: "The Soul changed after this proposal." or "The skill
     changed after this proposal."
   - The skill is deleted, or it is not for this agent only any more.
   - The server holds 100 skills (017).
   - Memory is off for the agent, or the same text is already an item (008).
   A failed proposal does not come back. The agent can make a new proposal.
6. **Change log row**: the kind, the target, the state, the time of the answer, and the source.
   A row for Applied shows the old text and the new text and has the button "Undo". A row for
   Rejected or Failed shows the reason and has no button.
7. **Undo**: Undo puts back the version before the change.
   - Soul change: the Soul gets the old text again, with a new version from Undo in the Soul
     history.
   - New skill: the app removes this agent from the list of agents of the skill. When no other
     agent may use the skill, the skill is deleted. When the user gave the skill to other agents
     after the accept, the skill stays for them. Old messages that used it keep their chip and their
     copy.
   - Skill change: the skill gets its old description and instructions again.
   - Memory item: the item is removed. This is the same undo as the one in the memory history
     (008), and each place shows the result of the other.
   - Undo is on only while the target is exactly as the change left it. For a new skill, the name,
     the description and the instructions count, and the list of agents does not. Otherwise Undo
     is off, and the row says: "A newer change exists. Undo that one first."
   - After an undo, the state of the row is Undone. The row shows "Undone" and the time, and has no
     button. The Soul history and the memory history keep their own rows for the undo.

### Limits

- **How often**: in one turn, an agent makes at most 1 proposal of the kinds Soul change, new skill
  and skill change together. In 24 hours, an agent makes at most 3 proposals of these kinds. Only
  a proposal that passes all limits counts. A refused proposal does not count. A memory check makes
  memory items only, at most 5 (008). The limits of how often do not apply to "Make a skill",
  because the user starts it.
- **One for each target**: at most one proposal waits for the Soul, and at most one for each skill
  that exists. A second proposal for the same target is refused, and the tool tells the agent that
  one waits. A memory item with the same text as an item or as another proposal is refused (008).
- **How many wait**: at most 20 proposals wait for each agent, of all kinds together. When 20 wait,
  a new proposal of any kind is refused. No proposal that waits is replaced, so memory items never
  push out a Soul change or a draft of "Make a skill". The user sees one muted line: "20 proposals
  wait. Answer some before this agent can suggest more." The line shows in the chat after the reply
  of the turn that made the refused proposal, at the top of the tab "Waiting" while 20 wait, and on
  the card of "Make a skill" in place of a draft (017). A proposal that waits for 30 days goes to
  Rejected with the reason "Expired".
- **Size**:
  - Soul change: the new Soul is at most 20000 characters. The removed text and the added text
    together are at most 2000 characters.
  - New skill: the limits of a skill (017).
  - Skill change: the limits of a skill (017). The removed text and the added text together are at
    most 2000 characters.
  - Memory item: at most 500 characters (008).
  - A proposal over a limit is refused, and the tool tells the agent the limit.
- **What a proposal never touches**: the name, the role line and the face; the model account, the
  model, the effort and the backup model (006); the permission level, the rules and the workspace
  (007); keys, saved secrets (020) and saved logins; the connections (018); the list of agents of a
  skill, and a skill for all agents or for other agents; the handbook and the role instructions;
  routines (009) and workflows (010); the switches of the agent, also memory, the memory check,
  "Read the handbook" and "Self-improvement"; sync, devices and the Teams link (028); and other
  agents. The tool has no kind for these. Text in a proposal that asks for one of these changes
  nothing outside the text.
- **Secrets**: a proposal with text that looks like a secret (014) is refused. The tool tells the
  agent to leave the secret out.
- **Outside content**: a turn that holds outside content (007) can make a proposal. Its card then
  shows the muted line: "This work read outside content. Read the change before you accept."
  Nothing applies before the user accepts, so no approval card shows at the moment of the
  proposal.
- **No change without approval**: the agent never changes itself without approval of the user. It
  has no other way to change its Soul, its skills or its memory by itself. Two ways are not
  proposals, because the user decided first:
  - a change that the user asks for in the chat (see "Changes from the chat");
  - "Save at once" for new memory items (008). A new agent starts at "Ask me first". "Save at once"
    is a choice that the user makes on purpose for one agent, on its memory page. No agent, starter,
    import or sync sets it. It counts only while the switch "Self-improvement" is on (see
    "Concepts").

### States

- **None**: a state of the page, not of a proposal: the agent has no proposal that waits and no
  row in the change log. The tab "Waiting" shows one muted line: "No proposals. When this agent
  sees a better way of work, it suggests a change here, and you decide." The tab "Change log" shows
  "No changes yet."
- **Switch off**: the tab "Waiting" shows "Self-improvement is off for this agent." above the
  proposals that still wait.
- **Waiting**: the cards, and the number in the row of the page.
- **Full**: 20 proposals wait. The tab "Waiting" shows the line of "How many wait" above the cards.
- **Applied, Rejected, Failed, Undone**: the rows of the change log, with their reason. The states
  stay after a restart.

### Surfaces

- **Ways in**: the tool of the agent in a turn, a memory check (008), and "Make a skill" (017). The
  user answers in the tab "Waiting", from the link "Review" in the chat, or from the link on the
  memory page.
- **Devices**: the page and the cards are on the computer that holds the proposal. A linked
  device (012) and the phone (011) do not show them. There, the muted line in the chat is plain
  text with no link.
- **Runtimes**: the tool is a tool of the app. An agent on a vendor runtime (006) that cannot call
  the tools of the app cannot propose. The switch is off for that agent, with the muted line
  "<program> cannot use self-improvement." "Make a skill" still works for that agent.
- **Ways out**: "Reject" for a card, "Undo" for an applied change, and the switch for the agent.
- **Data**: proposals and the change log are in the local database of the profile (014).
  - They do not sync (019). They stay on the computer that holds them.
  - An export of data (014) holds them, as it holds the rest of the database. An import of that
    export restores them with the agent.
  - An agent file holds neither (see "Agent file").
  - An applied change is data of its target, so it follows the sync and export rules of that
    target: a Soul change and a memory item sync (019), and a skill does not (019). An export holds
    all three.
  - The change log keeps 90 days and at most 1000 rows for each agent. The oldest rows go first.
  - Deleting an agent deletes its proposals and its change log. Archiving keeps them.
- **Words**: the texts come from the catalogue in English and Korean (see
  [docs/glossary.md](../docs/glossary.md)). No text says that the agent or the model learns, trains
  or evolves (000).

| English | Korean |
| --- | --- |
| Self-improvement | 자기 개선 (proposed) |
| Proposal | 제안 |
| Proposals (N) | 제안 (N) (proposed) |
| Waiting | 대기 중 (proposed) |
| Change log | 변경 기록 (proposed) |
| Accept | 수락 (proposed) |
| Edit and accept | 수정 후 수락 (proposed) |
| Reject | 거절 (proposed) |
| Undo | 되돌리기 |
| Undone | 되돌림 (proposed) |

## Agent file

- The file holds, for each agent: name, role line, Soul, face, and routines (see 009).
  It holds no section, because sections belong to one server. An imported agent has no section.
  It holds no model, no workspace folder, no permission level, no key, no secret, no history and
  no memory. It holds no proposal and no change log (see "Self-improvement"). So an import cannot
  give an agent more rights than the user gave it by hand.
- The file holds at most 40 agents and is at most 10 MB. A file with two agents of one name
  is refused.
- Text in the file that looks like a secret is hidden, as in an export (see 014).
- Import makes new agents only. It never changes an agent that exists. A name that is taken gets
  a number, ignoring case, inside the length limit. Every imported routine starts paused.
- If an import fails, the agents made so far stay. The error says why it stopped.
- **Skills in the file**: with "Skills of these agents", the file holds each skill that the picked
  agents may use, with its name, its instructions, and the agents in the file that may use it. A
  skill for all agents is written for the agents in the file only. Import makes new skills only. A
  name that is taken gets a number. An imported skill is off, so the user turns it on after a look
  at its instructions (017).
- **Handbook in the file**: with "Handbook", the file holds the handbook. On import, the review
  screen shows it not ticked, with the first lines and "Show all", which opens the full text. When the user ticks it, it replaces the
  handbook of this server, and the old text stays in the handbook history (see "Handbook").
- The limits stay: at most 40 agents and 10 MB. The file also holds at most 100 skills. A file
  over a limit is refused.
- A file of the first format version, with agents only, can still be read.
- A file that a version before the word "Soul" wrote can still be read. Its text for each agent
  becomes the Soul of the new agent. The file keeps the same form (see
  [docs/agent-file-format.md](../docs/agent-file-format.md)).

## Starters

A **starter** is a ready setup for one job. It fills the new agent form. It can also make a routine
and skills for the new agent.

- The choice "Start from" of the form lists "Blank" first and then the starters in this order:
  Assistant, Briefer, Researcher, Reviewer, Organizer. Each choice shows the job name and one line
  that says what the agent does. A muted line says what else the starter makes, for example "A
  paused routine, 1 skill". For a starter that makes nothing else, the line says so.
- A starter fills the name, the role line and the Soul. The user can change all of them
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
- The Soul of a starter guides the agent. It does not limit it. The permission level limits
  it (see 007).
- The user cannot make or edit starters in this version. The app does not write an agent setup
  from a text that describes a job.

| Starter | The role line says that the agent | The Soul tells the agent to | Extra setup |
| --- | --- | --- | --- |
| Assistant | Helps with everyday questions and writing. | Answer short and plain. Ask one question when a request is unclear. | None. |
| Briefer | Prepares a short briefing on topics that the user follows. | Ask for the topics when memory has none, and keep them in memory. Search the web for news on them. Lead with the one or two items that matter most to those topics, then give the rest in short lines, at most 10 lines in all. Name the source of each line. Say so plainly when nothing is new. | A routine on weekdays at 08:00, paused, that asks for the briefing. One skill that asks for a briefing now. |
| Researcher | Finds facts and checks them. | Say which source supports each claim. Keep what a source says apart from its own guess. Say when sources disagree. End with the open questions. | One skill that checks one claim. |
| Reviewer | Reads code changes and finds problems. | Read first. Change no file unless the user asks. List each finding with its place and why it matters, the most risky first. Say so plainly when there is no problem. | One skill that reviews the newest change in the workspace. |
| Organizer | Sorts and names the files of its workspace. | Propose a plan before it moves a file. Do not delete a file. Move a file to a folder for review instead. Report how many files it moved. | One skill that tidies the folder that the user names. |

## Recent work

- The agent profile shows a block "Recent work". It lists the last 20 tasks of this agent (see
  005), newest first. The Tasks page (005) is for all agents. This block is for one agent.
- A row shows the label of the task, its source (the chat, a routine, a workflow, or another
  agent), its state in words, and the time since its last change. For a task that has not ended,
  the words say what it waits for: "Waits for your approval", "Waits for your answer", or "Waits
  behind <place>". A blocked task shows "Blocked" and its reason.
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
- Before each turn, an agent with "Read the handbook" on gets the handbook before its Soul. The
  role instructions come after the handbook, and before its Soul (see "Role instructions"). When two texts say different things, the later text wins. The app
  tells the agent this order. The rules of the app (007, 014) always win over all of these texts.
- The switch "Read the handbook" is in the profile of the agent, under the Soul. The user
  turns it off for an agent that must not get it.
- A change of the handbook counts from the next turn. A turn that runs keeps the text that it had.
- No agent can change the handbook, from the chat or with any tool. The handbook page has a
  history of the last 20 versions, with the time and "Restore", as the Soul history has.
- A linked device (012) can read the handbook, and can change it only with the switch "Can create
  and change agents".
- Text that looks like a secret is refused on save, with the reason. The handbook is sent to the
  model provider of each agent that reads it, and the page says so.

## Role instructions

Agents that do the same job often need the same rules. The user writes those rules once for the
role line, and every agent with that role line follows them.

- Role instructions are free text of 0 to 5000 characters. A role starts with none. A role with no
  text gives nothing to its agents.
- The user writes them on the Roles page (013). The profile of an agent shows them under the
  field "Soul", read only, with a link to the Roles page. The text does not change the Soul of the
  agent.
- Before each turn, an agent that has the role line gets the role instructions after the
  handbook, and before its Soul. The app tells the
  agent this order, as for the handbook. When two texts say different things, the later text wins.
  The rules of the app (007, 014) always win.
- Lines that differ only in case are one role, and share one text (013, "Roles").
- A change counts from the next turn. A turn that runs keeps the text that it had.
- A role keeps its text while any agent, archived or not, has the role line. When no agent has it,
  the text is deleted.
- No agent can change role instructions, from the chat or with any tool.
- A linked device (012) can read them, and can change them only with the switch "Can create and
  change agents".
- Text that looks like a secret is refused on save, with the reason. The text goes to the model
  provider of each agent that has the role, and the page says so.
- The text syncs (019). In this version an agent file (014) holds no role instructions.

## Avatars

An avatar is the small round mark that shows who speaks, or whose place it is. ROBot has three:
the face of an agent, the picture of an agent, and the mark of the user. They follow the theme. In
the dark theme they are one family with the app mark: a very dark disc with a thin rim of light,
and features or a glyph of light that glow. The app mark is not an avatar.
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
  has the colour of the rim of a drawn face in that theme.
- **Mark of the user**: a disc with the same thin rim and one glyph: a person on the desktop, and
  the first letter of the word for "you" on the phone. In the dark theme, the disc is dark and
  the glyph is light. In the light theme, the disc is light and the glyph is dark.
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
- Ask the agent to rewrite its Soul: the Soul history has one more version, from the chat.
  Restore the older version: the Soul is the old text, and the history has a version from a
  restore.
- Pick the starter Briefer and press Create: the agent has the role line and the Soul of the
  starter, one paused routine at 08:00 on weekdays that posts in its chat, and one skill that
  only this agent lists.
- Pick Reviewer, change its role line, and press Create: the agent keeps the changed role line.
  Pick Blank: the form clears the fields that a starter filled.
- Create a starter agent on a server that holds 50 routines: the agent exists, no routine is made,
  and the first note in its chat says why.
- Make two agents from Researcher: the second skill gets a number, and both agents list their own
  skill.
- Open the profile of an agent that has 25 tasks: "Recent work" lists 20. A task that waits for an
  approval says "Waits for your approval". "Show all" opens the Tasks page for this agent.
- Write a handbook "Answer in Korean." An agent with "Read the handbook" on answers in Korean. Turn
  the switch off for that agent: its next turn does not get the handbook.
- Write role instructions "Answer in Korean." for the role "Reviewer". Two agents with that role
  answer in Korean from their next turn. An agent with another role does not. Change the role of
  one agent: its next turn does not get the text.
- Give an agent a Soul that says "Answer in English." and role instructions that say "Answer in
  Korean.": the agent answers in English, because its Soul comes later.
- Ask an agent in the chat to change its role instructions: nothing changes, and the agent says
  where the user can change them.
- Ask an agent in the chat to change the handbook: nothing changes, and the agent says where the
  user can change it.
- Change the handbook three times, and restore the first version: the handbook has the first text,
  and the history has a new version.
- Export two agents with "Skills of these agents" ticked. Import the file in an empty app: the
  review screen lists the skills of the two agents. After the import, the skills exist and are
  off.
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
  The mark of the user has a light disc and a dark glyph. A picture
  does not change, and its rim shows. The app mark does not change. Switch back: the dark discs
  and the glow come back.
- Choose the theme "system" and change the theme of the system: the avatars follow it.
- Upload a picture: it shows round with a thin rim in the hue of the agent, in the place list, in
  messages and in the form, in both themes. Remove it: the drawn face comes back.
- Look at a chat with many messages from the user and from agents. In the dark theme, the mark of
  the user is a dark disc with a person glyph of light. In the light theme, it is a light disc
  with a dark person glyph. The avatars of agents are the faces. Scroll through the chat in both
  themes: nothing stutters because of the avatars.
- Give an agent the workflow "Weekly" as its owner: the profile lists "Weekly" in the row "Workflows".
  Archive and delete the agent: the confirm says that one workflow has no owner then, and "Weekly"
  stays with no owner.
- Make an agent from "Blank": the field "Soul" is empty and shows the muted line. Send a message:
  the request to the model holds no Soul text, and the reply still comes. Type a Soul and save:
  the next request holds it after the handbook and the role instructions.
- Import an agent file that a version before the word "Soul" wrote: the text of each agent is the
  Soul of the new agent.
- With a stand-in model, a turn proposes a Soul change with a reason. The chat shows "Suggested a
  change to its Soul" with "Review". The Soul does not change, and the next request holds the old
  Soul. Open the card: it shows the old and the new text with the changes marked. Press "Accept":
  the Soul history has a version from a proposal, the change log has a row Applied, and the next
  request holds the new Soul. Press "Undo" on the row: the Soul is the old text, the history has a
  version from Undo, and the row shows "Undone".
- Press "Edit and accept" on a Soul change, change one word, and save: the Soul is the edited text.
- Press "Reject" on a proposal: nothing changes, and the change log has a row Rejected.
- A stand-in model proposes a new skill. Press "Accept": the skill exists for this agent only and is
  on, and `/` in its chat lists it. "Undo" on the change log row deletes the skill, and the row is
  Undone.
- Accept a new skill, then give the skill to a second agent in the form of the skill. Press "Undo"
  on the change log row: the skill is not for this agent any more, and it stays for the second
  agent.
- A stand-in model proposes a change to the instructions of a skill for this agent only. Press
  "Accept": the skill has the new instructions. Press "Undo" on the change log row: the skill has
  its old description and instructions, and the row is Undone.
- A skill change waits. Delete the skill, then press "Accept": the state is Failed, and the row
  shows the reason that the skill is deleted. Nothing is made.
- A Soul change waits. The user edits the Soul in the profile, then presses "Accept" on the card:
  the state is Failed with "The Soul changed after this proposal.", and the Soul keeps the text of
  the user.
- A Soul change waits, and the stand-in model proposes a second one: the tool refuses it and says
  that one waits. A fourth Soul or skill proposal in 24 hours is refused. A second Soul or skill
  proposal in one turn is refused.
- A stand-in model proposes a Soul change that removes and adds 2001 characters: the tool refuses
  it. A proposal with a text that looks like a key is refused, and the agent is told to leave the
  secret out.
- A stand-in model tries to propose a change of its model or its permission level: the tool has no
  such kind, and nothing waits.
- With 20 proposals that wait, a Soul change among them, a stand-in model proposes a memory item:
  the tool refuses it, the 20 proposals still wait, the Soul change is one of them, and the chat
  shows "20 proposals wait. Answer some before this agent can suggest more." The tab "Waiting"
  shows the same line. The refused proposal does not count toward the 3 in 24 hours.
- With a test clock, a proposal waits for 30 days: it leaves the tab "Waiting", and the change log
  has a row Rejected with "Expired". Nothing changed.
- With a test clock, a change log row is 91 days old: it is not in the change log any more. The
  change that it made stays.
- An agent on a vendor runtime that cannot call the tools of the app: the switch "Self-improvement"
  is off and shows "<program> cannot use self-improvement." "Make a skill" still works.
- In the chat, ask the agent to turn off "Self-improvement": nothing changes, and the agent says
  where in the profile the user can change it.
- Accept a Soul change, then edit the Soul in the profile: "Undo" on the change log row is off and
  says "A newer change exists. Undo that one first."
- A turn that read a web page proposes a Soul change: the card shows "This work read outside
  content. Read the change before you accept.", and the Soul changes only after "Accept".
- Turn "Self-improvement" off: the agent cannot propose a Soul change or a skill. With "Ask me
  first" in memory, a memory item still waits as a proposal. Set "Save at once", keep the switch
  off, and tell the agent a fact: no item is saved, and the fact waits as a proposal. Turn the
  switch on again: the proposals that waited are still there, and the next fact is saved at once.
- Make a new agent: its choice "Memory saving" is "Ask me first". Tell it a fact: no item is saved,
  and the fact waits as a proposal.
- Export the data of the profile with a proposal that waits and a row Applied in the change log.
  Import it into an empty app: the proposal still waits, and the row is in the change log. Write an
  agent file of the same agent: it holds no proposal and no change log row.
- Open the same agent on a linked device: no page "Self-improvement" shows, and the line in the
  chat has no link.
