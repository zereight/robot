# 005 Tasks and plan steps

## Purpose

Every piece of agent work is a task the user can see, stop and retry, in chats, channels, routines
and workflows.

## Concepts

- **Task**: who does it (agent), what (prompt), where it came from (chat, channel, routine,
  workflow, or another agent), its parent task if any, its state, start and end time, and its
  result or error.
- **States**: queued → running → (waiting for user ↔ running) → done | failed | cancelled.
- **Progress**: how far the turn of a task went. See "How far a turn went".

## Tasks page

- A table of tasks, newest first: agent face and name, label, source, state, duration.
- Filters: state, agent, source. Search by label.
- A row opens the task: its prompt, its steps, its messages, and its child tasks as a tree.
- Actions: stop (queued, running or waiting), retry (failed or cancelled), open source place.
- A task of a channel (see 004) also has "End the request", which cancels the whole request.
- A queued task shows what it waits behind: the work that its agent runs now, with the place of
  that work. If the agent is busy in its own chat, the line says so.

## How far a turn went

A turn is the work that one agent does for one task. Each turn has a progress:

- **Not sent**: the app has not given the request to the model or to the program of the vendor.
  A task that is queued has this progress.
- **Sent**: the app gave the request over, and nothing has come back.
- **Started**: something came back: a part of the reply, thinking, a tool step, an approval
  request, or a question.

The progress only goes up. It never goes back. A task that is retried makes a new turn, which
starts at "Not sent".

When a turn fails, because of an error, a restart, the silent limit, or any other reason except a
Stop by the user, the failed row (003) and the task show one line for the progress:

- Not sent: "The request did not reach the model. It is safe to try again."
- Sent: "The model may have started. Check the workspace before you try again."
- Started: "The agent had started to work. Some steps may have run. Check the workspace before
  you try again."

The line sits beside Retry. Retry works for every progress. A stop by the user shows no line,
because the user chose it.

## Silent turns

- A turn is silent when the model or the program shows no sign of life for the silent limit. The
  limit is 10 minutes. The user can change it in Settings (see 013).
- A sign of life is a new part of the reply, new thinking, a tool step that starts or ends, an
  approval request, or a question.
- The clock stops, and starts again at 0 afterwards, in these cases: the turn waits for the user
  (an approval or a question); the user holds the browser (007); a tool step runs, from its start
  to its end as the app sees it. Time while the computer sleeps does not count.
- When the limit is reached, the app stops the turn in the same way as a Stop of the user. The
  task fails with the reason "No answer for N minutes.", where N is the limit in minutes ("No
  answer for 1 minute." when N is 1). The failed row has Retry (003).
- A failed task by this rule is like any failed task: one notification of the kind "task failed"
  (015), and for a routine run the count of failed runs (009).
- The limit holds for every turn: a chat, a part of a channel job, a routine, a step of a
  workflow, and a message from another agent.

## Rules

- One agent runs one task at a time. Other tasks for it wait in its queue in order. When two
  computers sync (019) and both are online, this holds across both computers.
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
  user for any other reason, for example while the user holds the browser. The progress that the
  turn had reached stays, and the failed task shows its line.
- When two computers sync (019), the progress of a task syncs with the task.

## Acceptance

- Start two tasks for one agent: the second waits until the first ends.
- Restart during a task: it shows as failed with the restart reason and can be retried.
- A task waits for an approval. Restart the app: the task is still waiting, and its card shows
  again. Allow the step: the task goes on.
- A task waits for an approval, and a second task for the same agent is queued. Restart the app:
  the first task still waits. The second task shows as failed with the restart reason.
- A channel request has a parent and two child tasks. One child fails. "End the request" cancels
  the other child and the parent. A child that is done stays done.
- Set the silent limit to 1 minute. A stand-in model sends nothing for 90 seconds: at about 60
  seconds the turn stops and the task fails with "No answer for 1 minute.". The failed row has
  Retry, and one notification of the kind "task failed" shows.
- The silent limit is 1 minute. A turn waits for an approval for 2 minutes: it does not fail. The
  user allows the step, the stand-in model then sends nothing for 90 seconds: the turn fails.
- A stand-in model starts to send a reply, and the app ends at once. After the restart, the failed
  task shows the line for "Started". A task that was only queued shows the line for "Not sent".
- Retry a task whose line said "Started": the new task runs, and its progress starts at "Not
  sent".
