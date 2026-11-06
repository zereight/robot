# 010 Workflows

## Purpose

The user connects steps into a reusable flow, for work that needs a fixed order or several agents.

## Concepts

- **Workflow**: a name, a trigger, and a graph of steps on a canvas. The workflow list is its own
  page. The Workflows button on the rail opens it (001). The page does not show routines.
- **Owner**: none (the default) or one agent (002). A workflow with no owner is a **shared
  workflow**. The owner decides who can work in the workflow (see "Owner and participants").
- **Participant**: an agent that may be the agent of an agent step of a workflow. A shared workflow
  has every agent as a participant. See "Owner and participants".
- **Trigger**: manual, schedule (as in 009), or a web hook (see "Web hook").
- **Step kinds**: agent step (an agent and a prompt that can use earlier results), model step (a
  prompt for a model with no tools and no chat), condition (if/else on a result), wait for
  approval, and notify.
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
- **Check**: the app tries every way that a run of the workflow can go, and reports a way that
  goes wrong, for example a step that never runs. It reads the steps and the connections only
  (see "Check").

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
7. Check: the user presses "Check" on the canvas. The app shows "Passed", or the problem and the
   steps on its path. Before the first run after a change, the app checks the workflow by itself
   (see "Check").
8. Move a workflow to or from CC Workflow Studio: the user imports its file with "Import
   workflows", or exports one workflow with "Export for CC Workflow Studio" (see "CC Workflow Studio
   files").
9. Diagram: the editor shows the Mermaid text of the open workflow (see "Diagram").
10. Own a workflow: the user sets the field "Owner" of a workflow to an agent, or back to "None"
    (see "Owner and participants").

## Owner and participants

A workflow can have an owner: one agent. The owner makes the workflow private to that agent. A
workflow with no owner is shared, and it works as in all other parts of this spec.

- **Who participates**: an archived agent is never a participant. For the others:
  - A shared workflow: every agent.
  - A workflow of an agent: that agent only.
- **What is checked**: the agent steps only. A person, a trigger (a schedule or a web hook) and
  the assistant (flow 4) are no participants and need no right. The user can always edit and run
  the workflow, and any agent can be the assistant.
- **In the editor**: the agent list of an agent step shows the participants only. A step that names
  an agent who is not a participant shows "Not a participant" on its node, in the place of the
  kind of the step. The agent that the step names stays in its list, with "Not a participant"
  after the name, so that the user can read the step. The user cannot pick that line again.
- **In a run**: the app reads the participants when an agent step starts. A step whose agent is
  not a participant fails with the reason "Not a participant", and no task starts. The step rules
  of "Rules" apply to it, so "Continue on failure" lets the run go on.
- **A change of the group**: a change of the owner or of the archive state of an agent changes no
  step. The step keeps its agent. The next run reads the participants again, so a step can fail,
  or work again, with no edit.
- **Set the owner**: the editor has a field "Owner" with the choices "None" and the agents. The
  dialog of a new workflow has the same field. It starts at "None", or at the owner that the
  filter of the page names. The field is read-only while the workflow runs.
- **See the owner**: the Workflows page has a filter "Owner" (All, None, an agent), and each card
  shows the name of its owner. The profile of an agent (002) has a row "Workflows" with the
  workflows that it owns. A click closes the box and shows the card of the workflow on the page,
  whatever the filter "Owner" says.
- **When the owner is gone**: an agent that is deleted leaves its workflows with the owner
  "None". The workflows, their runs and their steps stay. The confirm of the delete says how many
  workflows then have no owner and that any agent can work in them (002).
  An archived agent stays the owner. It is no participant while it is archived.
- **Linked client**: it sees the owner and the participants as on the server. It changes the owner
  only with the switch "Can create and change agents" (012). The phone shows no owner.
- **Runtimes**: the app checks the step. It is the same for agents that use the tools of the app
  and for agents on each vendor runtime (006).
- **Data**: the owner syncs with the workflow (019) and is in the export of the data (014). A
  workflow file and a CC Workflow Studio file hold no owner. Import makes shared workflows.

## Workflow file

- The file holds, for each workflow: name, trigger, steps, connections and notes. A step holds its
  kind, its name, its place on the canvas and the fields of its kind. A condition holds its mode
  and its text. An agent step names its agent by the name of the agent, and it holds its prompt,
  its effort and its "Continue on failure" mark.
- The trigger in the file is manual or a schedule.
- The file holds no run, no version, no chat, no key, no secret and no result of a check. Text in
  the file that looks like a secret is hidden, as in an export (see 014).
- The file holds at most 20 workflows and is at most 10 MB. A file with two workflows of one name
  is refused.
- Import makes new workflows only. It never changes a workflow that exists. A name that is taken
  gets a number, ignoring case, inside the length limit.
- Every imported workflow is off: its schedule does not fire until the user turns it on. Import
  makes no agent and no routine.
- An agent step is linked to the agent that has the same name, ignoring case, and is not
  archived. If there is none, the step has no agent. It shows "Pick an agent", and a run fails at
  that step with the reason "No agent".
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
- A notify step is not written. The connections go around it, so the steps before and after it
  stay joined.
- Notes, the trigger, the agent of a step, the effort of a step and the mark "Continue on failure"
  have no place in that tool, so the app does not write them.
- A text that is longer than the limit of that tool is cut.
- Text that looks like a secret is hidden, as in a ROBot file (see 014).
- When the write is done, the app lists under "Not exported" what the file does not hold: each
  step that is not written, the trigger when it is not "manual", the count of notes, the count of
  steps that lost an agent, an effort or the mark "Continue on failure", and each cut text. If
  nothing is lost, the app shows no list.
- The file holds no run, no version, no chat, no key, no secret, no agent, no id of ROBot and no
  result of a check.
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

## Check

The check tries every way that a run of the workflow can go, by the rules of a run (see "Rules"),
and reports a way that goes wrong. It works as the public program TLC does for a TLA+ model, but
the app makes the model from the graph itself. It needs no agent, no model, no Java and no other
program. It starts no task and calls no model. It runs on this computer and sends nothing out.

### What the check reads

- The steps, their kinds, the connections and their branches.
- For a condition: its mode, and if its text is empty.
- For an agent step and a model step: if the prompt holds `{{input}}`.
- For an agent step: the mark "Continue on failure".

It does not read the agent of a step, the trigger, the notes or the places on the canvas.

### How the check sees a run

- A condition can take the branch "yes" or the branch "no". The check does not read the input. A
  condition in the mode "contains text" with an empty text always takes "yes", because every
  input contains an empty text. A condition in the mode "Ask a model" can also fail.
- An agent step and a model step can be done or fail.
- A wait for approval can be approved or rejected. "Reject" fails the step, so the run stops.
- A notify step is always done.
- Steps that run at the same time can end in any order.

### What the check finds

| Item | A problem is |
| --- | --- |
| Every run ends | A loop: a connection path that comes back to a step. Or a step that waits for an input that never ends. A workflow has no loop step and no loop limit in this version, so every loop is a problem. |
| Each wait has a way out | A wait for approval with no way out. "Reject" is a way out, and every wait for approval has it in this version, so this item always passes now. A run that waits also ends with Stop, and at a restart of the app (see "Rules"). |
| Each step and each branch can run | A step that is skipped in every run. A branch of a condition with no step is not a problem: a run that takes it ends there, as a filter does. |
| No step reads a result that was not made | A path on which a step gets no result from the steps before it, and the step uses one. A step uses a result when it is a condition, or an agent step or model step whose prompt holds `{{input}}`. It gets none when it has no input, or when each input that passes on is a failed agent step with "Continue on failure". A wait for approval, a notify step and a condition pass their input on without a change, so an empty result goes through them. |

### States

The control "Check" is in the editor, beside "Diagram". A press checks the graph that is open,
including a change that is not saved. The control shows the state of the check of that graph. It
works while the workflow is read-only.

| State | What the user sees |
| --- | --- |
| Not checked | A muted "Not checked" ("검사 안 함"). This is the state after a change of the graph, after an import, and for a new workflow. |
| Checking | A spinner and "Checking…" ("검사 중…"). The user can edit the graph. A change stops the check, and the state goes back to "Not checked". |
| Passed | "Passed" (통과) and the line "No problem found in the steps and connections." ("단계와 연결에서 문제를 찾지 못했어요.") |
| Problem found | "Problem found" ("문제 발견"), the message of the problem and the path (see "Result"). |
| Could not check | "Could not check" ("검사할 수 없음") and the message of the limit (see "Limits of the check"). |

A change of the graph is a change of a step, of a connection, of a branch, or of a field that the
check reads. A change of a note, of a name, of a place on the canvas or of the agent of a step is
not a change of the graph for the check.

### Result

- **Passed**: a panel lists the four items, each with "Passed" ("통과"), and the text of "What the check
  cannot prove". The items are: "Every run ends" ("모든 실행이 끝남"), "Each wait has a way out"
  ("모든 대기에 빠져나갈 길이 있음"), "Each step can run" ("모든 단계가 실행될 수 있음") and "No step reads a
  result that was not made" ("만들어지지 않은 결과를 읽는 단계 없음").
- **Problem found**: the panel shows one problem: the first problem in the order of the table
  above, with the shortest path to it. It shows the message and the path. The path is a numbered
  list. Each line is one step of the path, in order, with what happens at it. The canvas marks each
  step of the path with its line number. It marks the step of the problem with the danger colour
  and an icon, so the mark does not use colour alone. A click on a line selects its step. After a
  fix, the user checks again to find the next problem.
- The marks go away when the user closes the panel or changes the graph.
- The texts follow the language of the interface. The words `yes`, `no` and `{{input}}` stay
  English, because they are the branch values and the template of the file.

Messages (`<n>` and `<m>` are node numbers, `<name>` is the name of a step):

| Problem | English | Korean |
| --- | --- | --- |
| Loop | Steps `<list>` make a loop. A run can never leave it. | `<list>`단계가 반복 고리를 만들어요. 실행이 이 고리를 벗어날 수 없어요. |
| Waits forever | Step `<n>` "`<name>`" waits for step `<m>`, and step `<m>` never ends on this path. | `<n>`단계 "`<name>`"이(가) `<m>`단계를 기다리지만, 이 경로에서 `<m>`단계가 끝나지 않아요. |
| Never runs | Step `<n>` "`<name>`" never runs. On every path, step `<m>` "`<name>`" takes the branch `<yes or no>`. | `<n>`단계 "`<name>`"은(는) 실행되지 않아요. 모든 경로에서 `<m>`단계 "`<name>`"이(가) `<yes or no>` 분기로 가요. |
| No result | Step `<n>` "`<name>`" uses the result of the steps before it, but on this path it gets none. | `<n>`단계 "`<name>`"은(는) 이전 단계의 결과를 쓰지만, 이 경로에서는 받는 결과가 없어요. |

Lines of the path:

| What happens | English | Korean |
| --- | --- | --- |
| The run starts the step | Step `<n>` "`<name>`" starts. | `<n>`단계 "`<name>`" 시작 |
| The step is done | Step `<n>` "`<name>`" is done. | `<n>`단계 "`<name>`" 완료 |
| The step fails | Step `<n>` "`<name>`" fails. | `<n>`단계 "`<name>`" 실패 |
| The step fails, and the run goes on | Step `<n>` "`<name>`" fails, and the run goes on. | `<n>`단계 "`<name>`" 실패, 실행 계속 |
| A condition takes a branch | Step `<n>` "`<name>`" takes the branch `<yes or no>`. | `<n>`단계 "`<name>`" `<yes or no>` 분기로 이동 |
| A wait for approval | Step `<n>` "`<name>`" waits for approval. | `<n>`단계 "`<name>`" 승인 대기 |
| The step is skipped | Step `<n>` "`<name>`" is skipped. | `<n>`단계 "`<name>`" 건너뜀 |

### Check before a run

- Each workflow has the switch "Check before a run". It is on for a new workflow and for an
  imported workflow. It is in the editor, beside the trigger.
- When a run is about to start, the switch is on, and the saved graph is "Not checked", the app
  checks the saved graph first. This holds for every way that a run starts: Run in the editor, a
  schedule, a web hook, and the tool of the assistant.
- "Passed" or "Could not check": the run starts.
- "Problem found" in the item "No step reads a result that was not made": the run starts. The editor
  shows the problem. A step with an empty input is the choice of the user.
- Any other "Problem found": the run does not run a step. It fails at once with the reason "The check found
  a problem. Open the workflow to see it." ("검사에서 문제를 찾았어요. 워크플로우를 열어 확인하세요.") The editor shows the problem.
- The app keeps the result for the saved graph. The next run of the same graph uses that result
  and does not check again. So a workflow with "Problem found" fails each run until the user
  changes the graph or turns the switch off.
- A web hook still answers 202 at once (see "Web hook"). The check is part of the run.
- With the switch off, the app does not check before a run. The user can still press "Check".

### Limits of the check

- The check stops when it has looked at 1,000,000 states of a run, or after 60 seconds. The state
  is then "Could not check".
- Message, English: "This workflow has too many ways to run. The check stops at 1,000,000 states
  or after 60 seconds. Split the workflow, or let fewer steps run at the same time."
- Message, Korean: "이 워크플로우는 실행 경로가 너무 많아요. 검사는 상태 1,000,000개 또는 60초에서
  멈춰요. 워크플로우를 나누거나 동시에 실행되는 단계를 줄이세요."
- A workflow with no steps passes.

### What the check cannot prove

The check reads the shape of the graph. It does not read what an agent does inside a step. So it
cannot say:

- what a step writes, or if a result is good,
- which branch a condition takes for a given input,
- if an agent asks the user a question and waits (see 005), or how long a step takes,
- if a provider, a tool or a web hook works.

No text of the check says that a workflow is proven, verified, correct or safe. A pass says "No
problem found in the steps and connections." The panel of a pass also shows this line:

- English: "The check reads the steps and connections. It does not read what an agent does inside
  a step."
- Korean: "검사는 단계와 연결만 읽어요. 에이전트가 단계 안에서 하는 일은 읽지 않아요."

### Surfaces

- **Ways in**: the control "Check" in the editor, and the switch "Check before a run". Not in this
  version: the search field, a key, a command of the message box, a tool of the assistant.
- **Devices**: a linked client (012) that opens the editor has the control and sees the result. The
  server does the check. The client changes the switch only with the switch "Can create and change
  agents". The phone has no editor, so it has no control. It shows the reason of a run that the
  check stopped. A second profile (022) checks its own workflows.
- **Runtimes**: nothing changes. The check reads no agent.
- **Ways out**: close the panel. Turn the switch off. A check that runs stops at a change of the
  graph.
- **Seeing the state**: the control in the editor, and the reason of a run in the run list. The
  result of the saved graph stays after a restart.
- **Data**: the result of a check stays on this computer. It does not sync (019), and a workflow
  file and a CC Workflow Studio file do not hold it. The switch syncs with the workflow and is in
  the export of the data (014). A workflow file does not hold the switch.
- **Words**: "Check" is in the glossary.

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
- **File**: the workflow file writes a web hook as the trigger "manual", with no secret
  (`docs/workflow-file-format.md`).
- A trigger from a chat service (Discord, Slack and so on) is not in this version.

## Assistant

- The agent has tools to read and to change the open workflow, and tools to list workflows,
  run one, and read the state of a run (see 007, "Tools").
- **Make a workflow** is a manage tool (037). The main agent and an outside program with the access
  "Read, send work and manage" have it. It makes a change request, and the user allows it on a
  card (037). It takes a name and, optionally, a list of steps that the app joins in a line, in
  that order. A step is an agent step (an agent and a prompt), a wait for approval (a message), or
  a notify step (a title). The workflow has the trigger "manual", no owner, and the other starting
  values of the dialog of a new workflow. If the name is in use, the app adds a number, as for an
  import. If a workflow takes the name between the card and the Allow, the number is added then.
  A step that names an agent that does not exist or is archived, an unknown kind, or more than the
  limit of steps fails the check at once and makes no request. The user adds conditions and
  triggers on the canvas.
- When the user asks an agent for a workflow, the agent makes a ROBot workflow with this tool. A
  workflow feature of a vendor program (006) is not for this. The app turns such a feature off for
  the agents of this app.
- Read gives the nodes with their numbers, the connections, the triggers and a revision number.
- Change takes one batch. The batch names the revision that the agent read. If the workflow
  changed since, the app refuses the batch and the agent reads again. A batch can add, edit and
  remove nodes and connections and can clear a field. It can set the effort of an agent step.
- A change may name only an agent that exists and is not archived.
- The agent cannot set a schedule or a web hook. It never sees the address or the secret of a web
  hook. When the user asks for one, the agent makes the rest of the change and tells the user to
  set that part on the canvas.
- A batch with a wrong shape is an error that the agent can read and correct. It is not a crash.
- Before the app saves a change, it keeps the earlier graph as a version. The agent tells the
  user when it did.
- The canvas shows a saved change at once. If the user opens another workflow while the agent
  works, the view of that workflow does not jump.
- Run takes a workflow and, optionally, a node to start from. The same call twice in one turn
  starts one run. The state of a run holds the status, the error and the status of each step. It
  holds no step outputs.
- These tools work only in a turn that the user started in the direct chat of the agent. A
  routine run and a message of another agent get a clear failure instead, because a run can
  message people or change things elsewhere.

## Rules

- The delete of a workflow, from its card, is a danger button that asks first. Its question names
  the workflow and says that its runs go with it (000, "Danger buttons").
- A step waits until each of its inputs has ended. Then it runs when at least one input passes on:
  a step that is done, an agent step that failed and has the mark "Continue on failure", or a
  condition that took the branch of the connection. Its input is the results of those steps. When
  no input passes on, the step is skipped. A step with no input runs when the run starts.
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

- A two-step workflow passes the first agent's result to the second.
- Set the owner of the workflow "Weekly" to the agent Ada: the agent list of a step shows Ada
  only. The card shows "Ada".
- A step of "Weekly" names Bo. Run it: the run fails at that step with "Not a participant", no
  task starts, and the node of the step shows "Not a participant". Set the owner to "None" and
  run again: the step works, and the step was not edited.
- Set the owner of "Weekly" to Ada again. Archive Ada: no agent is in the list, and a run fails at
  the agent step. Restore Ada: it works again.
- Open "Weekly" as the user: it opens, edits and runs although the user is no agent. Pick Bo as
  the assistant of "Weekly": the panel works.
- Filter the page by the owner "Ada": only the workflows of Ada show. Open the profile of Ada: the
  row "Workflows" lists them, and a click shows the card of one on the page.
- Delete Ada: the confirm says that one workflow then has no owner. After the delete, "Weekly"
  shows no owner, its runs stay, and its agent list shows every agent.
- Export "Weekly" to a file and import it: the new workflow is off and has no owner.
- Sync two computers: the owner of "Weekly" shows on both. A linked client without the switch
  "Can create and change agents" sees the field "Owner" read-only.
- Ask the assistant to add a step after step 2: the canvas shows a new node 3, and the version
  list holds the graph from before.
- Ask the assistant to run the workflow: one run starts, and the assistant reports its status.
- Ask the main agent, on each runtime, to make a workflow "Daily" with two agent steps: a card
  shows the name and every step in full. Press Allow: one workflow "Daily" with the trigger
  "manual" and the two steps, joined in a line, shows on the Workflows page, and no vendor workflow
  exists. Press Deny: nothing is made. Ask again for the same name after an Allow: the second
  workflow is named "Daily 2". Name an agent that does not exist: no card shows, and the agent gets
  the reason. Set the agent to "Read only": the step is refused.
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
- A workflow with the agent step "Draft", the condition "Polite?" and a notify step on each branch:
  press "Check". The state goes from "Checking…" to "Passed", and the panel lists the four items.
  No agent and no provider is used, and no task starts.
- Set the condition "Polite?" to the mode "contains text" with an empty text: "Check" shows
  "Problem found". The message says that the step on the branch `no` never runs. The path has the
  steps 1 and 2, and the canvas marks them with 1 and 2 and marks the step of the problem.
- Remove the connection of the branch `no`: "Check" shows "Passed". A run that takes the branch `no` ends there.
- An agent step with "Continue on failure", and after it an agent step whose prompt holds `{{input}}`:
  "Check" finds "No result". The path ends with "Step 1 "Draft" fails, and the run goes on." and
  the second agent step. With a notify step after the first step, "Check" shows "Passed".
- An agent step with "Continue on failure", then a wait for approval, then an agent step whose prompt
  holds `{{input}}`: "Check" finds "No result".
- An agent step with no input whose prompt holds `{{input}}`: "Check" finds "No result".
- Set the language to Korean: the state, the message and the lines of the path are Korean. `yes`
  and `no` stay English.
- Change a step after a pass: the state is "Not checked". Move a step or edit a note: the state
  stays "Passed".
- With the switch "Check before a run" on, make the graph of the "Never runs" case above (the
  condition with an empty text) and press Run: the run fails at once with "The check found a problem. Open the workflow to see it.",
  and no step runs. Run it again: the app does not check again, and the run fails with the same
  reason. Turn the switch off and run: the run starts.
- With the switch on, run the graph of the "No result" case: the run starts, and the editor shows the
  problem.
- A schedule fires for a workflow that is "Not checked" and has no problem: the app checks, and the
  run starts. The next run does not check again.
- A workflow of 30 agent steps with no connections, so that all 30 run at the same time: "Check"
  ends as "Could not check" with the message of the limit. With the switch on, a run of it starts.
- Export a checked workflow to a workflow file and to a CC Workflow Studio file: neither file holds
  the result. Import the file: the workflow is "Not checked" and the switch is on.
- Search all texts of the check, in English and Korean, for "proven", "verified", "correct" and
  "safe", and for "증명", "검증됨", "정확", "안전": none appear.
- A linked client that opens the editor presses "Check" and sees the result. Without the switch
  "Can create and change agents", the switch "Check before a run" is read-only.
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
