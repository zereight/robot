# 005 Tasks and plan steps

## Purpose

Every piece of agent work is a task the user can see, stop and retry, in chats, channels, routines
and workflows.

## Concepts

- **Task**: who does it (agent), what (prompt), where it came from (chat, channel, routine,
  workflow, or another agent), its parent task if any, its state, start and end time, and its
  result or error.
- **States**: queued → running → (waiting for user ↔ running) → done | failed | cancelled.

## Tasks page

- A table of tasks, newest first: agent face and name, label, source, state, duration.
- Filters: state, agent, source. Search by label.
- A row opens the task: its prompt, its steps, its messages, and its child tasks as a tree.
- Actions: stop (queued, running or waiting), retry (failed or cancelled), open source place.
- A task of a channel (see 004) also has "End the request", which cancels the whole request.
- A queued task shows what it waits behind: the work that its agent runs now, with the place of
  that work. If the agent is busy in its own chat, the line says so.

## Rules

- One agent runs one task at a time. Other tasks for it wait in its queue in order.
- A task waiting for the user (an approval or a question) does not block other agents.
- Stopping a parent stops its children.
- A parent task waits for the tasks it gave out. So the cancel of one child alone would leave the
  parent waiting for ever. "End the request" finds the first task of the request and cancels
  every task of that request that is not final. It clears their errors and stops the turns that
  still run. A task that is done keeps its result. After the cancel, no task of the request starts
  again by itself. Retry still makes a new task.
- A routine run whose tasks are all cancelled shows as cancelled, not as done (see 009).
- Retry makes a new task with the same prompt and links it to the old one.
- After an app restart, a task that waits for an approval or a question still waits. The card
  shows again (see 007). This holds only when the task has no parent task, is not part of a
  workflow run (see 010), and does not use a vendor agent runtime (see 006).
- A task that waited through a restart keeps the place of its agent. Other tasks for that agent
  wait behind it, as before the restart. It does not block other agents. It has no time limit.
  The user can stop it at any time.
- After an app restart, every other task that was running or queued is marked failed with the
  reason "The app stopped", and the user can retry it. This includes a task that waits for the
  user for any other reason, for example while the user holds the browser.

## Acceptance

- Start two tasks for one agent: the second waits until the first ends.
- Restart during a task: it shows as failed with the restart reason and can be retried.
- A task waits for an approval. Restart the app: the task is still waiting, and its card shows
  again. Allow the step: the task goes on.
- A task waits for an approval, and a second task for the same agent is queued. Restart the app:
  the first task still waits. The second task shows as failed with the restart reason.
- A channel request has a parent and two child tasks. One child fails. "End the request" cancels
  the other child and the parent. A child that is done stays done.
