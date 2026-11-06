# 010 Workflows

## Purpose

The user builds a workflow. A workflow is the main object of ROBot: a graph of nodes that a model
runs in a fixed order. Each workflow has one responsible document, one chat and one memory. The
user can read, edit and check the whole workflow.

## Concepts

- **Workflow**: a name, a trigger, a graph of nodes on a canvas, one responsible document, one
  chat, one memory, one folder and one permission level (see "Folder and permission level"). The
  Workflows button on the rail opens the workflow list (001).
- **Responsible document**: a text, in the form of a skill (017). It says who answers for the
  workflow, its character and its limits. A workflow has one responsible document. A responsible
  document belongs to one workflow. The user edits it. The user cannot pick another responsible
  document. It changes only by a proposal that the user accepts (see "Self-improvement").
- **Node**: one step of the graph. The word covers two kinds: a text node and a decision node. Each
  node has a name and a number. The number is the place of the node in the list of nodes, counted
  from 1. Moving a node on the canvas does not change its number. A node has no agent.
- **Text node**: a node that writes text. It has a prompt, a provider, a model and a reasoning
  level (006). At run time it sends the responsible document and its own prompt to its model. Its
  prompt can include the text of a skill of the user (017). It can use tools (see "Folder and
  permission level" and "Tools").
- **Decision node**: a node that asks a decision model one question with a fixed list of options,
  and follows the option that wins (see "Decision node rules"). It takes its model from 013. It has
  no reasoning level. It uses no tools and writes no text.
- **Connection**: a line from the output of one node to the input of another node. A decision node
  has one output for each of its options.
- **Trigger**: what starts a run. The user can start a run by hand. A schedule is a trigger too
  (see "Trigger").
- **Chat**: the one chat of a workflow. The user talks to the workflow, and the responsible document
  answers. No other chat talks about the workflow.
- **Memory**: one scope for each workflow (008). The memory keeps what the workflow learns from its
  runs. The user can see and edit it.
- **Run**: one execution of a workflow, from its start to its end. To start a run means to begin
  an execution. A run holds the state and the result of each node. A run follows the graph as it
  is when the run starts. The graph does not change during a run. Who may start a run is in
  "Rules".
- **Task**: one execution of one node. A run is made of tasks (005).
- **Version**: the graph as it was before a change that was saved (see "Chat and edit").
- **TLA**: Temporal Logic of Actions. It is a formal language for models of systems. A TLA module
  describes the workflow (see "File" and "Check").
- **Check**: verifies the TLA form of the workflow (see "Check").

Points that the owner has not decided are not written in this spec. They are listed in
docs/spec-questions.md, in the rows for 010.

## Flows

1. New workflow: the user presses "New workflow" and types a name. The app makes the responsible
   document with a short default text. The user can edit it. The canvas opens with the chat beside
   it.
2. Chat and edit: the responsible document answers in the chat. It changes the graph with the tools
   of "Assistant". The user can also change the graph by hand. The user drags nodes onto the canvas,
   connects outputs to inputs, and edits each node in a side panel. A node or a connection is
   deleted with a danger button that asks first (000).
3. Every change passes the check before it saves. A change that fails the check shows the problem
   and the nodes on its path. It does not save (see "Check").
4. Versions: a change keeps the earlier graph as a version. The user opens a version in the editor
   and can restore it. A restore also keeps the current graph as a version.
5. Run: the user starts a run by hand, or a trigger starts it. The nodes show their state as they
   run. Each node execution is a task (005). The run view shows the state and the result of each
   node. A list shows the runs and their states.
   - Status question: while a run works or waits, or after it ends, the user asks the chat how far
     it has gone. The chat tells the state of each node, why the run stopped or waits, and the
     result of each node that has ended (see "Assistant").
   - Feedback: while a run works or waits, the user writes feedback on a result. The chat takes it
     and shows that it got it. The text nodes that start after it get it with their input (see
     "Assistant").
6. Decision node: the user writes the question, two or more options, and a threshold. The default
   threshold is 0.9.
   - The decision model is one of the choices of 013. The node uses the choice that the user saved
     in settings.
   - At run time the node sends the question, the options and its input to that model. The model
     gives a probability for each option.
   - The option with the highest probability wins, if that probability reaches the threshold. The
     run follows the connection of that option.
   - The run view shows the probability of each option.
   - An answer that names no option, or that gives a probability that is not between 0 and 1, is not
     decided (see the questions for 010).
   - If no option reaches the threshold, the model does not answer in 3 seconds, or the choice is
     off or has no key, the node asks the user to pick an option. It shows an approval card (007,
     "Ask when unsure"). The run waits for the answer.
   - A scheduled run has no user at that moment. It waits as a task that waits for the user (005).
   - The words of the input go to the service of the choice. The settings text of 013 says so.
   - The check sees a decision node as a branch with one state for each option.
7. Trigger: the user sets the trigger in the editor (see "Trigger").
8. Self-improvement: after a run, the workflow can propose a change (see "Self-improvement").
9. File: the workflow file is a TLA module that the user can edit (see "File").

## Node input and output

- A node waits until each of its inputs has ended.
- An input passes on when its node is done. It also passes on when its node failed and has the mark
  "Continue on failure", or when a decision node chose the connection to this node.
- The node runs when at least one input passes on. Its input is the results of the nodes that pass
  on. When no input passes on, the node is skipped. A node with no input runs when the run starts.
- `{{input}}` in a prompt is the joined result of the nodes before. `{{trigger}}` is the text that
  started the run. A prompt that does not hold `{{input}}` gets the input at its end.
- A failed node stops the run, unless the node has the mark "Continue on failure". The reason of the
  failure shows in the run view.

## Folder and permission level

- A workflow has one folder and one permission level (007). A new workflow gets an empty folder in
  the default workspace folder (013). It gets the default permission level, "Ask for risky steps"
  (007).
- A text node uses the folder and the permission level of its workflow. A text node can pick a
  stricter permission level than the workflow, never a looser one. A decision node uses neither.
- Only the user changes the folder and the permission levels of a workflow. A node cannot change
  them. A proposal for self-improvement cannot change them.

## Tools

- A text node can use shell commands, files, the browser and memory (007, 008), in the folder and at
  the permission level of the workflow.

## Assistant

- The responsible document has tools to read and change the open workflow, to list workflows, to
  run one, and to read the state and the results of a run (see 007, "Following a run in the chat").
- The chat can read the nodes with their numbers, the connections and the triggers.
- The chat can change the graph. It can add, edit and remove nodes and connections, and clear a
  field. It can set the model or the reasoning level of a node only to a value that the account of
  the node offers (006).
- If the user changes the workflow while the chat works, the app refuses the chat's change. The
  chat then reads the graph again and tells the user.
- A change in a wrong form is refused. The chat tells the user what is wrong. The graph does not
  change.
- The chat cannot set a schedule or a web hook. When the user asks for one, the chat makes the rest
  of the change and tells the user to set that part on the canvas (see the questions for 010).
- Before the app saves a change, it keeps the earlier graph as a version. The chat tells the user
  when it did.
- The canvas shows a saved change at once. If the user opens another workflow while the chat works,
  the view of that workflow does not jump.
- The chat can start a run, from the start or from a node that the user names. In one turn of the
  chat, the chat starts at most one run. The chat tells how far the run has gone, which node
  works, why the run stopped or waits, and the result of each node that has ended. It reads no
  result of a node that has not ended. It takes the feedback of the user while the run works.
- During a run the user can send feedback on the results so far. The chat takes it and shows that
  it got it.
  - The feedback goes with the input of the text nodes that start after it. It changes no node that
    has ended.
  - It does not change the graph, the prompts, the folder or the levels.
  - Only the literal words of the user are feedback. A message from an outside program (023) or
    from Teams (028) is never feedback.
  - What feedback does in every case is not decided (see the questions for 010).
- The tools of the chat work only in a turn that the user started in the chat of the workflow.
  They also work in a user turn about a run that a trigger started. A node of a run does not use
  them.

## Decision node rules

- A decision node needs at least two options. The editor refuses a decision node with fewer.
- A decision node uses no tools and writes no text. It takes its model from 013 and has no reasoning
  level.

## Trigger

- A run starts when the user presses "Run" in the editor, or when a trigger starts it.
- A schedule is a trigger of a workflow. The rules of the schedule are not decided (see the
  questions for 010).
- Other kinds of trigger are not decided (see the questions for 010).

## Check

- The check reads the TLA form of the workflow. It tries every way that a run can go. It reports a
  deadlock, a node that never runs, and a rule that a state breaks.
- The app writes three standard rules: no deadlock, every node can run, and every approval node
  (a node kind that is not decided, see the questions for 010) comes before its effect. The meaning of "effect" is not decided (see the questions for 010). The
  user adds more rules in the TLA module. The check reports a state that breaks them.
- The check needs no model and no other program. It starts no run and calls no model. It sends
  nothing out.
- The check runs on every change before the change saves (see "Flows", item 3).
- **Problem found**: the panel shows one problem, the first problem, with the shortest path to it.
  The path is a numbered list. Each line is one node on the path, in order, with what happens there.
  The canvas marks each node on the path with its line number. It marks the node of the problem with
  the danger colour and an icon, so the mark does not use colour alone. A click on a line selects its
  node.
- **Passed**: the panel says that the check found no problem in the nodes and connections.
- After a fix, the user changes the graph, and the check runs again.
- The check reads the shape of the workflow. It does not read what a model writes in a node, which
  option a decision node takes for a given input, or whether a tool works. No text of the check says
  that a workflow is proven, verified, correct or safe.
- The texts of the check follow the language of the interface. The words `{{input}}` and
  `{{trigger}}` stay English, because they are the template of the file.

## Self-improvement

1. After a run, the workflow can propose a change to its responsible document, to a node prompt, to
   the graph, or to its memory.
2. The user accepts or refuses each proposal. The user can undo an accepted proposal.
3. A change that fails the check cannot be accepted.
4. A proposal cannot change the folder or the permission level of the workflow (see "Folder and
   permission level").
5. The responsible document can make a proposal from the feedback of the user (see "Assistant").
   The proposal follows the same rules.

## File

- The workflow file is a TLA module. The user can edit it.
- The module holds the graph, the prompts as strings, and the rules of the check (decision 14). The
  app writes the standard rules. The user adds more. What else the module holds is not decided (see
  the questions for 010).
- The file holds no run, no version, no chat, no key and no secret. Text in the file that looks like
  a secret is hidden, as in an export (014).
- The file holds at most 20 workflows, and it is at most 10 MB. A file with two workflows of one name
  is refused. Whether one file holds one workflow or several is not decided (see the questions for
  010).
- An import shows the review screen (014) before the app makes anything. The user confirms the
  import.
- Import makes new workflows only. It never changes a workflow that exists. A name that is taken gets
  a number, ignoring case. The name stays inside the length limit, which is not decided (see the
  questions for 010).
- Every imported workflow is off. Its schedule does not fire until the user turns it on. Import makes
  nothing but the workflows of the file.
- If a workflow in the file breaks the rules of the graph, the app refuses the whole file. It names
  the workflow and the place of the fault. These are the rules of the graph:
  - A connection names a node that does not exist.
  - A connection joins a node to itself.
  - A decision node has fewer than two options, or an option with no connection.
  - The workflow has more than 30 nodes.
  A loop of nodes is not decided (see the questions for 010).

## Rules

- A workflow cannot be edited while it runs. The editor shows it read-only until the run ends.
- A text node uses its own provider, model and reasoning level (006). A node that names no provider
  takes the preferred provider, then the default one. Which provider is preferred, and which is the
  default, is not decided (see the questions for 010).
- A text node or a decision node that calls its model and gets a plain failure is tried again: 3
  tries, 2 seconds apart. A usage limit, a busy model and a shutdown end the call at once. Each retry,
  and a model call that gets no answer, gets one line in the workflows log (014).
- After an app restart, a run that was going is marked failed with the reason "The app stopped".
  This includes a run that waits for the user. Its tasks fail the same way (005).
- When two computers sync (019), a workflow runs on one computer only. The other computer shows
  "Runs on <name>".
- Who may start a run: the computer that holds the workflow executes the run. A linked client (012),
  such as a phone, can start and stop a run on that computer. A linked client does not execute any
  node.
- A linked client (012) sees the workflows of the server. It changes them only when the server allows
  it (012). The chat and the file stay on the server.

## Surfaces

- **Ways in**: "New workflow" on the workflow list, the card of a workflow, "Run" in the workflow
  view, and the trigger on the canvas.
- **Devices**: this computer shows and changes the workflow. A linked client (012) sees it and can
  start a run. The phone has no workflow editor (011).
- **Runtimes**: each text node uses the provider and the model that it names (006). A decision node
  uses the model of 013. The check reads no model.
- **Ways out**: the user can stop a run. A run that waits for the user ends with Stop too. The user
  can restore a version, undo an accepted proposal, and close the check panel. A delete asks first
  (000).
- **Seeing the state**: the card shows the state of the last run and the state of the check. The run
  view shows each node. After a restart, the state of a run stays (see "Rules").
- **Data**: a workflow syncs as a whole (019). The result of a check stays on this computer. It does
  not sync (019).

## Acceptance

- Press "New workflow" and type "Weekly": the canvas opens with the chat beside it, and the
  responsible document has a default text that the user can edit.
- A workflow with two text nodes: the second node's prompt holds `{{input}}`, and it gets the result
  of the first node.
- Ask the chat to add a node after node 2: the canvas shows a new node 3, and the version list holds
  the graph from before.
- Ask the chat to set a model that the account of the node does not offer: the change is refused,
  and the chat tells the user.
- Ask the chat to run the workflow: one run starts, and the chat reports its state.
- Ask the chat for a schedule: it tells the user to set the schedule on the canvas.
- Ask the chat "How far is the run?" while a run works: the chat names the node that works and
  lists the nodes that have ended with their results. It gives no result of a node that has not
  ended.
- A run waits for the user, or has failed: the chat says why, in plain words.
- Write feedback on node 2 while node 3 has not started: the chat shows that it got the feedback,
  and node 3 gets it with its input. Node 2 does not run again. The graph and the prompts do not
  change.
- A message from an outside program or from Teams during a run: it is not feedback.
- A trigger started a run: the user asks the chat about it in a turn, and the chat answers. A node
  of that run cannot use the tools of the chat.
- Set a text node to a permission level that is looser than its workflow: the app refuses it. Set
  it to a stricter level: it works.
- A decision node with two options and a threshold of 0.9: the run view shows the probability of
  each option, and the run follows the connection of the winning option.
- A decision node where no option reaches 0.9: an approval card asks the user to pick an option, the
  run waits, and it goes on after the answer.
- A decision node with one option: the editor refuses it.
- Make a change that leaves a node that no run can reach: the check shows "Problem found" with the
  path, and the change does not save.
- A rule that the user adds in the TLA module breaks a state: the check reports it.
- A proposal to change the permission level or the folder is not offered.
- Accept a proposal, then undo it: the earlier text is back. A proposal that fails the check cannot
  be accepted.
- While a run goes, the editor is read-only. Restart the app during the run: the run and its tasks
  end as failed with "The app stopped".
- Sync a workflow to a second computer: it runs on one computer only, and the other shows "Runs
  on <name>".
- A linked client without the right to change workflows sees the workflow and runs it, and cannot
  change it.
- Delete a workflow: a question names it and says that its runs go with it. "Keep it" changes
  nothing.
