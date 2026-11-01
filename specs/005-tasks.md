# 005 Tasks and plan steps

## Purpose

Every piece of agent work is a task the user can see, stop and retry, in chats, channels, routines
and workflows.

## Concepts

- **Task**: who does it (agent), what (prompt), where it came from (chat, channel, routine,
  workflow), its parent task if any, its state, start and end time, and its result or error.
- **States**: queued → running → (waiting for user ↔ running) → done | failed | cancelled.

## Tasks page

- A table of tasks, newest first: agent face and name, label, source, state, duration.
- Filters: state, agent, source. Search by label.
- A row opens the task: its prompt, its steps, its messages, and its child tasks as a tree.
- Actions: stop (queued, running or waiting), retry (failed or cancelled), open source place.

## Rules

- One agent runs one task at a time. Other tasks for it wait in its queue in order.
- A task waiting for the user (an approval or a question) does not block other agents.
- Stopping a parent stops its children.
- Retry makes a new task with the same prompt and links it to the old one.
- After an app restart, tasks that were running are marked failed with the reason "The app
  stopped", and the user can retry them.

## Acceptance

- Start two tasks for one agent: the second waits until the first ends.
- Restart during a task: it shows as failed with the restart reason and can be retried.
