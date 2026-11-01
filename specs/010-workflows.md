# 010 Workflows

## Purpose

The user connects steps into a reusable flow, for work that needs a fixed order or several agents.

## Concepts

- **Workflow**: a name, a trigger, and a graph of steps on a canvas.
- **Trigger**: manual, schedule (as in 009), or a message in a chosen channel that matches text.
- **Step kinds**: agent step (an agent and a prompt that can use earlier results), condition
  (if/else on a result), wait for approval, and post message.
- **Run**: one execution, with the state and result of each step.

## Flows

1. Edit: the user drags steps onto the canvas, connects outputs to inputs, and edits each step in
   a side panel. Zoom and pan with the trackpad or mouse.
2. Run: manual trigger or the configured trigger. Steps light up as they run. Each agent step is a
   task (see 005).
3. History: a list of runs with their states; a run opens to show each step's input and result.

## Rules

- A step starts when all its inputs are done.
- A failed step stops the run unless the step is marked "Continue on failure".
- A workflow cannot be edited while it runs; the editor shows it read-only until the run ends.

## Acceptance

- A two-step workflow passes the first agent's result to the second and posts the final message.
