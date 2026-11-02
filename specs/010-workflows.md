# 010 Workflows

## Purpose

The user connects steps into a reusable flow, for work that needs a fixed order or several agents.

## Concepts

- **Workflow**: a name, a trigger, and a graph of steps on a canvas.
- **Trigger**: manual, schedule (as in 009), or a message in a chosen channel that matches text.
- **Step kinds**: agent step (an agent and a prompt that can use earlier results), model step (a
  prompt for a model with no tools and no chat), condition (if/else on a result), wait for
  approval, and post message.
- **Condition modes**: "contains text" tests the input for a text, ignoring case. "Ask a model"
  asks a model a yes or no question about the input.
- **Node number**: every step on the canvas shows its number. The numbers are in the order of the
  graph and stay with the step.
- **Effort of a step**: an agent step can set its own reasoning effort, from low to max, or it can
  follow the effort of its agent (the default).
- **Version**: the graph as it was before a change that the assistant saved (see "Assistant").
- **Run**: one execution, with the state and result of each step.

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
- A failed step stops the run unless the step is marked "Continue on failure".
- A workflow cannot be edited while it runs; the editor shows it read-only until the run ends.
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
- A model step fails on the first try and works on the second: the run goes on, and the log holds
  one retry line.
- An agent step with effort "low" runs with low effort. The next chat turn of that agent uses
  the effort that the agent had before.
