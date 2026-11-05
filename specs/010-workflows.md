# 010 Workflows

## Purpose

The user connects steps into a reusable flow, for work that needs a fixed order or several agents.

## Concepts

- **Workflow**: a name, a trigger, and a graph of steps on a canvas. The workflow list is its own
  page. The Workflows button on the rail opens it (001). The page does not show routines.
- **Trigger**: manual, schedule (as in 009), a message in a chosen channel that matches text, or
  a web hook (see "Web hook").
- **Step kinds**: agent step (an agent and a prompt that can use earlier results), model step (a
  prompt for a model with no tools and no chat), condition (if/else on a result), wait for
  approval, post message, and notify.
- **Notify step**: shows a system notification (see 015). The title is a text that the user sets.
  The body is the first 200 characters of the input of the step. The run view shows the whole
  input. The step passes its input on unchanged.
- **Note**: a text on the canvas, in one of four tones. A note has no connection, no node number
  and no effect on a run. It does not count towards the limit of steps.
- **Condition modes**: "contains text" tests the input for a text, ignoring case. "Ask a model"
  asks a model a yes or no question about the input.
- **Node number**: every step on the canvas shows its number. The numbers are in the order of the
  graph and stay with the step.
- **Effort of a step**: an agent step can set its own reasoning effort, at a level that its model
  lists (006), or it can follow the effort of its agent (the default).
- **Version**: the graph as it was before a change that the assistant saved (see "Assistant").
- **Run**: one execution, with the state and result of each step.
- **Starter**: a ready graph for one job. The user adds it from the menu of the Workflows page (see
  "Starters").

## Flows

1. Edit: the user drags steps onto the canvas, connects outputs to inputs, and edits each step in
   a side panel. Zoom and pan with the trackpad or mouse. A step, a connection and a note are
   deleted with a danger button that asks first (000, "Danger buttons").
2. Run: manual trigger or the configured trigger. Steps light up as they run. Each agent step is a
   task (see 005).
3. History: a list of runs with their states; a run opens to show each step's input and result.
4. Assistant: the Workflows page has a chat panel beside the canvas. The user picks an agent and
   asks about the open workflow. The app tells the agent which workflow is open, so the agent
   never has to guess. The panel is off, with the reason, while the workflow is read-only.
5. Versions: the editor lists the versions of a workflow. The user opens one and can restore it.
   A restore also keeps the current graph as a version.
6. Export workflows: from the menu of the Workflows page, the user picks workflows and a file
   name. The app writes one file. Import workflows: the user picks such a file. The app shows the
   review screen (see 014, "Review before an import"), with the agent names that it cannot find,
   and asks to confirm.
7. Start from a starter: from the menu of the Workflows page, the user picks "New from a starter",
   picks a starter and an agent, and presses Create. The app makes a new workflow (see
   "Starters").
8. Move a workflow to or from CC Workflow Studio: the user imports its file with "Import
   workflows", or exports one workflow with "Export for CC Workflow Studio" (see "CC Workflow Studio
   files").
9. Diagram: the editor shows the Mermaid text of the open workflow (see "Diagram").

## Workflow file

- The file holds, for each workflow: name, trigger, steps, connections and notes. A step holds its
  kind, its name, its place on the canvas and the fields of its kind. A condition holds its mode
  and its text. An agent step names its agent by the name of the agent, and it holds its prompt,
  its effort and its "Continue on failure" mark.
- The trigger in the file is manual or a schedule. A workflow with a message trigger is written
  with the manual trigger. A post step is written with no place, because the file holds no
  channel.
- The file holds no run, no version, no chat, no key and no secret. Text in the file that looks
  like a secret is hidden, as in an export (see 014).
- The file holds at most 20 workflows and is at most 10 MB. A file with two workflows of one name
  is refused.
- Import makes new workflows only. It never changes a workflow that exists. A name that is taken
  gets a number, ignoring case, inside the length limit.
- Every imported workflow is off: its schedule does not fire until the user turns it on. Import
  makes no agent, no channel and no routine.
- An agent step is linked to the agent that has the same name, ignoring case, and is not
  archived. If there is none, the step has no agent. It shows "Pick an agent", and a run fails at
  that step with the reason "No agent".
- A post step from a file shows "Pick a place", and a run fails at that step with the reason "No
  place".
- If a workflow in the file breaks the rules of the graph (a connection to a step that does not
  exist, a condition without both branches, or more steps than the limit), the app refuses the
  whole file and names the workflow and the place of the fault.
- Notes in the file keep their text, tone and place.

## CC Workflow Studio files

CC Workflow Studio is a public tool in which the user draws a workflow on a canvas and saves it as
a JSON file. The user can move a workflow from that tool to ROBot and from ROBot to that tool.
The form of the file and the table of steps are in
[docs/cc-wf-studio-format.md](../docs/cc-wf-studio-format.md).

That tool has more kinds of node than ROBot has kinds of step, and ROBot has parts that the tool
does not have. So a move loses some parts. The app always says which parts, and never loses a part
in silence.

### Import

- "Import workflows" takes a file of CC Workflow Studio as well as a ROBot file. The app finds the
  form from the content, not from the name of the file. A file of neither form is refused with the
  reason "This is not a workflow file." The file holds one workflow.
- The review screen shows first (see 014, "Review before an import"). The app makes nothing
  before the user confirms.
- The rules of "Workflow file" hold: the new workflow is off, its trigger is manual, a name that
  is taken gets a number, text that looks like a secret is hidden, and the limits of 30 steps and
  10 MB hold.
- A node with a prompt makes an agent step. A node with an if and else makes a condition in the
  mode "Ask a model". The first branch of that node is the branch "yes", and the second is the
  branch "no".
- The file names no agent that ROBot can link. So each agent step has no agent, shows "Pick an
  agent", and fails a run with the reason "No agent". The review screen has the field "Agent for
  agent steps", with the agents that are not archived and the choice "None" at the start. An agent
  that the user picks is the agent of every agent step.
- A node that has no step in ROBot (a question to the user, a switch, a skill, a connection to a
  tool, a Codex call, a sub-agent flow, a session checkpoint, a group) becomes a note. The note
  has the tone "pink", the place of the node, and a first line that says what the node was. It
  holds the main text of the node. The start node and the end node make nothing.
- A connection to or from a node that became a note is dropped. A step that lost an input this
  way shows "Connect" in the checklist after the import (see 014).
- A node in a group keeps the place that it has on the canvas of the tool.
- A variable `{{name}}` in a prompt gets the value that the node holds for it. Another `{{...}}`
  text stays as it is.
- The app refuses the whole file, and names the node or the place of the fault, in these cases:
  the file has more than 30 steps, a connection joins a step to itself, the connections make a
  loop, a connection names a node that does not exist, or a condition has no connection for the
  branch "yes" or for the branch "no" (also when the app dropped the connection).
- The review screen lists under "Not imported" each node that became a note, each part of the
  file that ROBot does not make (for example sub-agent flows, hooks, the model of a sub-agent),
  and each text that the app cut. Each row has a reason.

### Export

- The menu of the Workflows page has the choice "Export for CC Workflow Studio". The user picks one
  workflow and a file name. The app writes one file that CC Workflow Studio opens.
- An agent step becomes a sub-agent node with the prompt of the step. A condition becomes an if
  and else node. An approval step becomes a node that asks "Approve" or "Reject"; only "Approve"
  goes on. The app adds a start node and an end node.
- A post step and a notify step are not written. The connections go around them, so the steps
  before and after them stay joined.
- Notes, the trigger, the agent of a step, the effort of a step and the mark "Continue on failure"
  have no place in that tool, so the app does not write them.
- A text that is longer than the limit of that tool is cut.
- Text that looks like a secret is hidden, as in a ROBot file (see 014).
- When the write is done, the app lists under "Not exported" what the file does not hold: each
  step that is not written, the trigger when it is not "manual", the count of notes, the count of
  steps that lost an agent, an effort or the mark "Continue on failure", and each cut text. If
  nothing is lost, the app shows no list.
- The file holds no run, no version, no chat, no key, no secret, no channel, no agent and no id of
  ROBot.
- The import of the file that the app wrote makes a workflow with the same agent steps and
  conditions, the same connections between them and the same prompts. A condition in the mode
  "contains text" comes back in the mode "Ask a model". Each agent step comes back with no agent,
  unless the user picks one on the review screen. An approval step comes back as a note, because
  the import has no step for a question node (see "Import").

## Diagram

The editor has the control "Diagram". It opens a box with the Mermaid flowchart of the graph that
is open, including a change that is not saved. The box has "Copy". Copy puts that text on the
clipboard. The control works while the workflow is read-only.

- The first line is `flowchart TD`.
- Each step is one line, in node-number order. A condition is a diamond. Every other step is a
  box. The label is the node number, a full stop, a space, and the name of the step.
- Each connection is one line. A connection that leaves a condition is labelled `yes` or `no`.
  Those words stay English, because they are the branch values of the file.
- A note is not in the diagram. The trigger is not a node.
- A character that would break a line (`"`, `[`, `]`, `{`, `}`, `|`, or a line break) becomes a
  space.
- A workflow with no steps has a flowchart with no nodes.
- The app does not draw the picture. It does not send the text to another service.
- The phone has no workflow editor, so it has no diagram control in this version. A linked client
  that opens the editor has the control.

## Starters

A **workflow starter** is a ready graph for one job. It is like an agent starter (see 002), but it
makes a workflow. This version has one starter: **TLA+ check**.

TLA+ is a public language that describes how a system behaves. TLC is a public program that tries
every order of the steps of a TLA+ model and reports a state that breaks a rule. The starter lets
an agent write a model of a spec, run TLC on it, and explain what TLC finds.

### Way in

- The menu of the Workflows page has the choice "New from a starter". It opens a dialog that lists
  the starters. Each row shows the name, one line that says what the workflow does, and a muted
  line that says what it needs.
- The dialog has the field "Agent". It lists the agents that are not archived. The default is the
  main agent (see 002), or, when there is none, the first agent of the list. Every agent step of
  the new workflow uses this agent.
- The choice is off, with the reason, when no agent exists ("Make an agent first."), and for a
  linked client that has no switch "Can create and change agents" (see 012).
- Create makes one workflow in the open profile (see 022). Its name is the name of the starter, in
  the language of the interface at that moment. A name that is taken gets a number, as for an
  import. The trigger is "manual". The app opens the canvas of the new workflow.
- The workflow is an ordinary workflow from then on. The user can edit, run, export, sync and
  delete it. The user cannot make or edit starters in this version. The assistant of the Workflows
  page has no tool for starters.

### The graph of TLA+ check

| Node | Kind | Name | What it does |
| --- | --- | --- | --- |
| 1 | Agent step | Write model | Asks the user, with the tool "ask the user" (see 007), which spec to check: a path in the workspace, or pasted text. Reads the spec. Writes a TLA+ model and its settings file in a folder of the workspace, from the text of the spec only. The model must check at least one property. A choice that the spec does not make is an assumption, written as a comment in the model. The reply lists the properties and the assumptions. If the step cannot write the model, its reply ends with a "Blocked:" line (see 005). |
| 2 | Agent step | Run TLC | Runs TLC on the model with a shell command. Copies the last 30 lines of the TLC output without change. The last line of the reply is `TLC_RESULT: PASS` when TLC says that it found no error, and `TLC_RESULT: FAIL` when TLC reports an error. If Java or the TLA+ tools program is missing, or if TLC cannot read the model after one fix, the reply ends with a "Blocked:" line. The step downloads nothing. |
| 3 | Condition | TLC passed? | Mode "contains text", with the text `TLC_RESULT: PASS`. Branch "yes" goes to node 4. Branch "no" goes to node 5. |
| 4 | Notify | No error found | The title is "TLA+ check: no error found". |
| 5 | Agent step | Explain the finding | Explains the output of node 2 in at most 12 lines: the steps of the trace in order, the rule of the spec that each step comes from, and the assumptions that the trace needs. Says if the trace follows from the text of the spec alone. Writes the result as a question to the author of the spec, not as a defect. |
| 6 | Notify | Possible gap | The title is "TLA+ check: possible gap". The run view holds the whole explanation. |

The connections are 1 to 2, 2 to 3, 3 to 4 (yes), 3 to 5 (no), and 5 to 6.

The canvas also holds one yellow note. The note says that the workflow needs Java 17 or later and
the TLA+ tools program (the file `tla2tools.jar`) in the folder `tools` of the workspace of the
agent, that the workflow downloads nothing, and that a pass says only that the model has no error.

### Rules of the starter

- The agent steps run shell commands and write files under the permission level of the agent (see
  007). At "Read only", a shell command and a file write are refused. The steps tell the agent to
  end its reply with a "Blocked:" line when a step is refused, so the step ends as Blocked.
- An agent on a vendor runtime (see 006) uses the tools of that runtime. If it cannot run a shell
  command, node 2 ends as Blocked.
- The lines `TLC_RESULT:` and `Blocked:` are the same in English and Korean, because the app reads
  them. All other texts of the starter (names, prompts, titles and the note) have an English and a
  Korean version, and follow the language of the interface when the user presses Create.
- No text of the starter says that a spec is proven, verified or correct. A pass says "no error
  found", and it speaks about the model, not about the spec.
- The spec text and the model go to the model provider of the agent, as in any agent step (see 000
  and 014). TLC runs on this computer. The starter sends nothing else out.
- The graph follows the rules of the graph and of the file format. The file that the app writes
  for this workflow imports with nothing in "Not imported".

### Surfaces

- **Ways in**: the menu of the Workflows page only. Not in this version: the search field, a key,
  a setting, a command of the message box.
- **Devices**: a linked computer (see 012) has the same dialog, and it needs the switch "Can
  create and change agents". The phone (see 011) cannot add a starter in this version. It shows
  and runs the new workflow like any workflow. A second profile has its own list, and the new
  workflow goes to the open profile only.
- **Runtimes**: see "Rules of the starter".
- **Ways out**: the user deletes the workflow, as any workflow. Creating one changes nothing else,
  so no confirm is needed.
- **Seeing the state**: the list and the run view of any workflow. A question at node 1 shows as a
  question of a task (see 005). A Blocked step shows its reason.
- **Data**: the new workflow syncs (see 019), exports (see 014) and goes into a workflow file like
  any workflow. It runs on this computer.
- **Words**: "Starter" is in the glossary.

## Web hook

A web hook lets an outside service start a workflow, for example a code host that tells ROBot about
a new issue. ROBot runs no service on the internet for this (000).

- **Setting up**: in the trigger of the workflow the user picks "Web hook". The form shows an
  address on this computer and a secret. The secret is hidden. It has "Copy" and "Make a new
  secret". The trigger works only while the workflow is on.
- **Who can reach it**: the app listens on this computer only, on the loopback address. An outside
  service reaches the address only when the user makes it reachable, for example with a tunnel or
  a VPN that the user sets up. ROBot sets up no tunnel and uses no relay.
- **Proof**: a call must show that it knows the secret. It can do this in one of two ways.
  - A signature of the body made with the secret. This is HMAC SHA-256 in the header
    "X-Hub-Signature-256", as the public documents of GitHub describe it.
  - The secret itself, as a bearer token.
  A call without valid proof gets the answer 401 and starts nothing. The app compares the proof
  in constant time.
- **Id of a call**: a call can carry an id, so that the app finds a call that comes again. For the
  preset "GitHub" the id is the header "X-GitHub-Delivery". For "Any service" it is the header
  "X-Request-Id". A call with no such header has no id, and the app never counts it as a
  duplicate. See 038, "Duplicates".
- **Subject**: the repository and the number of the issue or the pull request for "GitHub", and the
  header "X-Subject" for "Any service". The subject shows in the event, and a subject that does not
  fit the form of 038 refuses the call with 400. It starts nothing.
- **Presets**: the user picks one.
  - "GitHub": the user ticks the events: issue opened, issue closed, issue labeled, pull request
    opened, pull request updated, review requested, review submitted, checks failed, pull request
    merged, comment added, and a mention of a name that the user types. Two filters exist: the
    repository (a list of names) and "Author is not a bot". The app reads the kind of event from
    the header "X-GitHub-Event" and the fields from the body, as the public documents describe.
    The first step gets a short text: the kind, the repository, the title, the author, the link,
    and the text of the issue, comment or review cut at 4,000 characters.
  - "Any service": every call with valid proof starts the workflow. An optional filter "contains
    text" looks at the body. The first step gets the body cut at 20,000 characters.
- **Outside content**: the text that comes with a call is outside content (007). The agent steps
  of the run hold the mark.
- **Limits**: a body over 1 MB gets the answer 413. A workflow starts at most 30 times in a minute.
  More calls get 429 and start nothing. A call with valid proof counts toward the 30, also when
  the busy rule skips it.
- **Order of checks**: a call to an address that the app does not know, or to a workflow that is
  off, gets 404 first. Then the app checks the size (413), then the proof (401), then the subject
  (400), then the rate (429).
  A call that passes these and fails the filter of the preset gets 202 and starts nothing. Then
  the busy rule applies.
- **Busy**: a call that comes while a run of the same workflow goes is skipped, as a schedule
  skips an occurrence (009). It gets 202, and the workflows log (014) gets one line.
- **Answer**: the app answers 202 at once when it starts a run. It does not wait for the run.
- **No reply to the sender**: the workflow answers the outside service by its steps, for example
  an agent step that uses a connection to the code host (018). No step kind exists for it.
- **The address**: it holds a port and a random part. The app picks a free port when the user
  first picks the trigger, and keeps it, so the address stays the same after a restart. Each
  profile (022) listens on its own port while the app runs, also when the profile is not open.
- **When the address cannot open**: for example when another program uses the saved port, the
  form shows the reason and the button "Pick another port". The address then changes. The
  workflow does not start by call until it opens.
- **Ways out**: "Make a new secret" ends the old secret at once. A change of the trigger to
  another kind, and the delete of the workflow, delete the secret and the address.
- **App closed**: when the app does not run, the sender gets no answer. ROBot keeps no call, and
  the sender may try again.
- **Run history**: a run that a call started shows "Started by web hook" in its list.
- **Events**: each call that passes the proof makes one event on the tab "Events" (038), with the
  result of the call. An id from the sender makes the call a duplicate when the sender used it
  before (038, "Duplicates"). "Check where this goes" on the form of this trigger makes a test
  event that starts no run (038).
- **Not synced**: the secret is in the keychain (014) and does not sync (019). A synced workflow
  arrives with the trigger "Web hook, not set up on this computer". It starts from no call until
  the user makes a secret on this computer. The workflow runs on one computer (see "Rules"), and
  the calls go to that computer.
- **Linked client**: it sees the kind of trigger and the name of the computer. It sees neither
  the address nor the secret (012).
- **File**: the workflow file writes a web hook as the trigger "manual", with no secret, as for a
  message trigger (`docs/workflow-file-format.md`).
- A trigger from a chat service (Discord, Slack and so on) is not in this version.

## Assistant

- The agent has tools to read and to change the open workflow, and tools to list workflows,
  run one, and read the state of a run (see 007, "Tools").
- Read gives the nodes with their numbers, the connections, the triggers and a revision number.
- Change takes one batch. The batch names the revision that the agent read. If the workflow
  changed since, the app refuses the batch and the agent reads again. A batch can add, edit and
  remove nodes and connections and can clear a field. It can set the effort of an agent step.
- A change may name only an agent that exists and is not archived.
- The agent cannot set a schedule, a message trigger, a web hook, or a post-message place. It never
  sees the address or the secret of a web hook. When the user asks
  for one, the agent makes the rest of the change and tells the user to set that part on the
  canvas.
- A batch with a wrong shape is an error that the agent can read and correct. It is not a crash.
- Before the app saves a change, it keeps the earlier graph as a version. The agent tells the
  user when it did.
- The canvas shows a saved change at once. If the user opens another workflow while the agent
  works, the view of that workflow does not jump.
- Run takes a workflow and, optionally, a node to start from. The same call twice in one turn
  starts one run. The state of a run holds the status, the error and the status of each step. It
  holds no step outputs.
- These tools work only in a turn that the user started in the direct chat of the agent. A
  routine run, a message of another agent, and a channel turn get a clear failure instead,
  because a run can message people or change things elsewhere.

## Rules

- The delete of a workflow, from its card, is a danger button that asks first. Its question names
  the workflow and says that its runs go with it (000, "Danger buttons").
- A step starts when all its inputs are done.
- A failed step stops the run unless the step is marked "Continue on failure". An agent step
  whose task ends as Blocked (see 005) is a failed step, with the reason of the block.
- A workflow cannot be edited while it runs; the editor shows it read-only until the run ends.
- When two computers sync (019), a workflow runs on one computer only. The other computer shows
  "Runs on <name>".
- A linked client (012, "Workflows") sees the workflows of the server and runs and stops them.
  It changes them only with the switch "Can create and change agents". The assistant and the
  workflow file stay on the server. So do the import and the export of CC Workflow Studio files.
- After an app restart, a run that was going is marked failed with the reason "The app
  stopped". This includes a run that waits at an approval step. Its tasks fail the same way,
  also a task that waits for an approval or a question (see 005).
- An agent step uses the model of its agent, so it follows the backup model of the agent while
  the agent is on it (006). A model step and a condition in "Ask a model" mode name their own
  provider and get no backup.
- An agent step with its own effort runs one turn with that effort. The agent keeps its own
  setting for all other turns. If the model of the agent does not offer that effort, the step
  runs with the effort of the agent. The retry of a step takes the effort from the step, not
  from the state of the first try.
- A model step or a condition in "Ask a model" mode gets 3 tries, 2 seconds apart. Only a plain
  failure of the call is tried again. A usage limit, a busy model and a shutdown end the step at
  once.
- A step that names no provider takes the preferred provider, then the default one. It skips a
  provider that cannot answer a prompt with no tools and no chat (Muse Code). A step that names
  such a provider still gets it, so a wrong choice fails where the user made it.
- A condition whose answer is not yes or no fails. Its error holds the start of the answer (up to
  240 characters, on one line), and the run view shows it.
- The workflows log (see 014) holds one line for each retry (the step, the failed try and the
  cause), a final line that says how many tries were made, and a line for a model step that
  cannot get an answer (the provider, the model, the time taken and the cause).

## Acceptance

- A two-step workflow passes the first agent's result to the second and posts the final message.
- Ask the assistant to add a step after step 2: the canvas shows a new node 3, and the version
  list holds the graph from before.
- Ask the assistant to run the workflow: one run starts, and the assistant reports its status.
- Ask the assistant for a schedule: it tells the user to set the schedule on the canvas.
- Export a workflow with an agent step, a condition in "Ask a model" mode, a notify step and a
  note. Make an agent with the same name in an empty app, and import the file: the workflow
  exists and is off. It has the same steps, node numbers and note, and the agent step is linked.
- Import the same file into an app that has no agent of that name: the list names the missing
  agent, and the step shows "Pick an agent".
- Run a workflow with a notify step and the window hidden: a notification shows the title, and the
  run view holds the whole input.
- Pick the trigger "Web hook" with the preset "GitHub", and turn the workflow on. A stand-in sender
  posts "issue opened" with a valid signature: one run starts, the first step gets the short text,
  the run list says "Started by web hook", and the agent steps hold the mark of outside content.
  The same call with a wrong signature gets 401 and starts nothing. A body of 2 MB gets 413.
  A call while the run goes gets 202 and starts no second run. 31 valid calls in a minute: the
  31st gets 429. Switch off "Author is not a bot" and send an event from a bot: it starts a run
  only then.
- Export a workflow with a web hook and import it into an empty app: the workflow has the
  trigger "manual" and the file holds no secret. Sync it to a second computer: it shows "Web hook,
  not set up on this computer".
- A model step fails on the first try and works on the second: the run goes on, and the log holds
  one retry line.
- An agent step with effort "low" runs with low effort. The next chat turn of that agent uses
  the effort that the agent had before.
- Pick "New from a starter", pick "TLA+ check" and the agent "Reviewer", and press Create: one new
  workflow named "TLA+ check" exists, with the trigger "manual", six steps with the nodes, kinds
  and connections of "The graph of TLA+ check", and one note. Every agent step names "Reviewer".
  Do it again: the second workflow has the same name with a number.
- Export the new workflow, and import the file into an empty app that has an agent with the same
  name: the review screen lists nothing under "Not imported", and the workflow has the same steps.
- Run it with a stand-in agent. Node 1 asks which spec. The reply of node 2 ends with `TLC_RESULT:
  PASS`: node 4 shows its notification, and nodes 5 and 6 do not run.
- Run it again. The reply of node 2 ends with `TLC_RESULT: FAIL`: node 5 runs, node 6 shows its
  notification, and node 4 does not run. The run view holds the whole explanation.
- Run it again. The reply of node 2 ends with "Blocked: Java is missing": the run fails at node 2
  with the reason, and nodes 3 to 6 do not run.
- Set the agent to "Read only" and run it: the shell command of node 2 shows "Refused: read only".
- Set the language to Korean and press Create: the name, the step names, the titles and the note
  are Korean. The lines `TLC_RESULT:` and `Blocked:` stay English.
- With no agent, "New from a starter" is off and says "Make an agent first." On a linked client
  with the switch off, it is off and says why.
- Search all texts of the starter, in English and Korean, for "proven", "verified" and "correct"
  and for their Korean words ("증명", "검증됨", "정확"): none appear.
- Send a call with the secret as a bearer token to the preset "Any service" with the filter
  "contains text" `deploy`: a body without the text gets 202 and starts nothing, and a body with it
  starts a run. A body of 25,000 characters reaches the first step cut to 20,000. A GitHub issue
  text of 5,000 characters reaches the first step cut to 4,000. Filter the repository to one name:
  an event of another repository starts nothing.
- A call has a body of 2 MB and a wrong signature: it gets 413, not 401. A call with a wrong
  signature and a normal body gets 401. A skipped call counts toward the 30 in a minute.
- "Make a new secret": a call with the old secret gets 401. Change the trigger to "manual": the
  address no longer answers.
- Restart the app: the address of the web hook is the same. Another program holds the saved port:
  the form shows the reason and "Pick another port".
- A call to the address of a workflow that is off, and a call to a wrong address, get 404. Two
  profiles each have a workflow with a web hook: the two addresses use two ports, and each call
  reaches only its own profile.
- Open Diagram on a workflow whose step 1 is the agent step "Draft", step 2 is the condition
  "Polite?", and the branch "yes" goes to step 3 "Post it", with one note on the canvas. The text
  starts with `flowchart TD`. Step 2 is a diamond. The branch is labelled `yes`. The note is not
  in the text. A name that holds `"` shows a space in that place.
- Import a CC Workflow Studio file with a start node, a prompt node, a sub-agent node, a question
  node, a second prompt node and an end node, joined in this order. The review screen lists one
  workflow with three steps, and "Not imported" names the question node. After the import the
  workflow is off. It has a pink note at the place of the question node. The two prompt steps and
  the sub-agent step show "Pick an agent", and the second prompt step shows "Connect".
- Import the same file again and pick the agent "Reviewer" in "Agent for agent steps": every agent
  step names "Reviewer", and no step shows "Pick an agent".
- Import one workflow in the wrapped form (with a `meta` field) and in the bare form, with
  connections that have no ports: both make the same workflow.
- Import a file with a sub-agent node inside a group. The step lands at the place of the group
  plus the place of the node. A prompt node with `variables` and the text `{{topic}}` gets the
  value of `topic` in its prompt, and the text `{{other}}` stays.
- Import a file with a loop: the app refuses it and names the nodes of the loop, and nothing is
  made. Do the same for an if and else node whose second branch goes to a question node: the app
  refuses the file and names the node and the branch "no".
- Import a file of 31 steps: the app refuses it and makes nothing.
- Export a workflow with an agent step, a condition in the mode "contains text", an approval step,
  a notify step, a note, and a schedule. The file has a start node, a sub-agent node, an if and
  else node, a question node with the answers "Approve" and "Reject", and an end node. It has no
  node for the notify step, and the steps before and after it are joined. "Not exported" names the
  notify step, the schedule, one note and the agent of one step. The CLI of CC Workflow Studio
  accepts the file (checked by hand).
- Export a workflow with a prompt that holds a key: the file holds `[redacted]` and not the key.
- Export a workflow with a prompt of 12 000 characters: the prompt in the file has 10 000, and
  "Not exported" names the step and the cut text.
- Export a workflow with an agent step, a condition and two agent steps after it, and import the
  file into an empty app: the workflow has the same four steps, the same connections and the same
  prompts. The condition is in the mode "Ask a model", and each agent step shows "Pick an agent".
- Export a workflow with an approval step between two agent steps, and import the file: the canvas
  shows a pink note for the question node, and the second agent step shows "Connect".
- On a linked client, "Export for CC Workflow Studio" and the import of such a file are not
  offered. The client shows the muted line "Open this on <server name>.", as for the export and
  import of a ROBot file (012).
