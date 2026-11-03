# 010 Workflows

## Purpose

The user connects steps into a reusable flow, for work that needs a fixed order or several agents.

## Concepts

- **Workflow**: a name, a trigger, and a graph of steps on a canvas.
- **Trigger**: manual, schedule (as in 009), or a message in a chosen channel that matches text.
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
- **Effort of a step**: an agent step can set its own reasoning effort, from low to max, or it can
  follow the effort of its agent (the default).
- **Version**: the graph as it was before a change that the assistant saved (see "Assistant").
- **Run**: one execution, with the state and result of each step.
- **Starter**: a ready graph for one job. The user adds it from the menu of the Workflows page (see
  "Starters").

## Flows

1. Edit: the user drags steps onto the canvas, connects outputs to inputs, and edits each step in
   a side panel. Zoom and pan with the trackpad or mouse.
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

## Assistant

- The agent has tools to read and to change the open workflow, and tools to list workflows,
  run one, and read the state of a run (see 007, "Tools").
- Read gives the nodes with their numbers, the connections, the triggers and a revision number.
- Change takes one batch. The batch names the revision that the agent read. If the workflow
  changed since, the app refuses the batch and the agent reads again. A batch can add, edit and
  remove nodes and connections and can clear a field. It can set the effort of an agent step.
- A change may name only an agent that exists and is not archived.
- The agent cannot set a schedule, a message trigger, or a post-message place. When the user asks
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

- A step starts when all its inputs are done.
- A failed step stops the run unless the step is marked "Continue on failure". An agent step
  whose task ends as Blocked (see 005) is a failed step, with the reason of the block.
- A workflow cannot be edited while it runs; the editor shows it read-only until the run ends.
- When two computers sync (019), a workflow runs on one computer only. The other computer shows
  "Runs on <name>".
- A linked client (012, "Workflows") sees the workflows of the server and runs and stops them.
  It changes them only with the switch "Can create and change agents". The assistant and the
  workflow file stay on the server.
- After an app restart, a run that was going is marked failed with the reason "The app
  stopped". This includes a run that waits at an approval step. Its tasks fail the same way,
  also a task that waits for an approval or a question (see 005).
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
