# 005 Tasks and plan steps

## Purpose

Every piece of agent work is a task the user can see, stop and retry, in chats, channels, routines
and workflows.

## Concepts

- **Task**: who does it (agent), what (prompt), where it came from (chat, channel, routine,
  workflow, or another agent), its parent task if any, its state, start and end time, and its
  result or error.
- **Depth**: a number. A task that the user, a routine or a workflow starts has depth 0. See
  "Limits of a task".
- **States**: queued → running → (waiting for user ↔ running) → done | failed | blocked |
  cancelled. A part of a channel that asks for review has one more state, in review, before done
  (see "Review").
- **Times**: each task keeps three times, in seconds.
  - **Wait**: from the moment the task is made to the moment it starts.
  - **First reply**: from the message that started the task to the first part of the reply that
    the app stores and the user can see. When no message started the task (a routine or a
    workflow), the time counts from the moment the task is made. Reply text counts, and so do a
    question card and an approval card. Thinking, the working line and tool cards do not count.
  - **Total**: from the message that started the task, or from the moment the task is made, to
    the end of the task. It includes the time that the task waited for the user.
  - A time that is not known is shown as "—", never as 0. A restart keeps the times that are
    known. Retry makes a new task with its own times.

## Tasks page

- A table of tasks, newest first: agent face and name, label, source, state, duration.
- Filters: state, agent, source. Search by label.
- A row opens the task: its prompt, its steps, its messages, its child tasks as a tree, and its
  three times. The messages that joined the task during its turn (see 003) are listed under the
  prompt, with their times.
- Actions: stop (queued, running or waiting), retry (failed, blocked or cancelled), accept or
  request changes (in review; see "Review"), open source place.
- A task of a channel (see 004) also has "End the request", which cancels the whole request.
- A queued task shows what it waits behind: the work that its agent runs now, with the place of
  that work. If the agent is busy in its own chat, the line says so.

## Limits of a task

These limits stop a chain or a task that runs without progress. They are not a cap on the total
cost of many tasks.

- **Message chain.** A task that starts because another agent sent a message (007), or because
  the reply to such a message came back, has the depth of the task that caused it, plus 1. A part
  of a plan (004), a nudge and a retry keep the depth of the task that made them.
- The tool "send message" fails when the task that sends has depth 8 or more. No task starts.
  The step shows the reason "The chain of agent messages is at its limit (8)." The sender gets
  the same reason as a failed step, and its turn goes on. A reply that comes back always starts
  its task, also at depth 9 or more. A task at that depth cannot send a message.
- **Steps.** One tool call is one step. For an agent on a vendor runtime (006), one tool card is
  one step. A task that reaches the step limit stops at once and ends as Failed with the reason
  "Step limit reached (N)." The reply that streamed stays and is marked as stopped. The limit is
  a setting (013). The default is 300 steps.
- **Repeated reads.** In the turn of an agent that uses the tools of the app, a step that reads
  a file or fetches a web page is refused when two earlier steps of the same turn had the same
  target and the same result. The step fails with a short text that tells the agent to use the
  result it already has. The turn goes on. A read that gives a new result is not refused.

## Blocked

- A task from a part of a plan, a message of another agent, a routine or a workflow tells its
  agent this: if you could not do the work, end the reply with a last line that starts with
  "Blocked:" and gives the reason in one sentence. Write that line in no other case. A task from
  a direct chat gets no such text, because the user reads the reply there.
- When a turn ends with no error, the app reads the last line of the reply that has text. If it
  starts with "Blocked:" (in any letter case), the task ends as Blocked. Its reason is the text
  after the colon, cut at 200 characters. The line stays in the reply.
- A turn that ends with an error is Failed, not Blocked. A turn that the user stops is
  Cancelled.
- Blocked is a final state. A parent that waits for the task goes on. Retry works as for a
  failed task. A blocked task counts as a failed one for the lead and the main agent (004, 007),
  the pause of a routine (009), a workflow step (010) and the notice "task failed" (015). The
  Tasks page and the plan steps show it with its own label and icon.

## Review

A channel can ask for the review of its parts (004, "Review of parts").

- **In review**: the turn of a part ended with no error and no "Blocked:" line, and the result
  waits for the user. The state is not final, so the parent keeps waiting.
- A task in review does not hold the place of its agent. The agent can run other tasks.
- The user decides. **Accept** ends the task as Done. **Request changes** needs a text of 1 to
  2000 characters. It ends the task as Done and starts a new part for the same member, with that
  text as its prompt. The new part links to the old one, as after Retry, and belongs to the same
  request. It can go to review again.
- The user decides on the computer that owns the task. The other computer of a sync pair, and a
  client of a linked server, show the state and a muted line "Decide on <name>" (012, 019).
- A task in review stays in review after an app restart. It has no time limit.
- "End the request" cancels a task in review. "Stop" does not change it.

## Retry note

A step that may change things is a file write, a shell command, or a tool of a connection (007)
that the action log lists with the result Ran, Failed or Stopped. A step that failed or stopped
may have run in part.

- The user can press Retry on a failed, blocked or cancelled task, here and in 003 and 004. If the
  earlier try has at least one step that may change things, a note shows first and the new try
  waits. If it has none, the retry starts at once.
- The note says that the first try ran steps that may have changed things, that Failed, Blocked
  and Cancelled do not undo them, and that the user should check the state before another try.
  It lists at most 5 of these steps, newest first, with the kind, the target and the result. If
  more exist, it ends with "and N more".
- Two buttons: "Retry anyway" and "Back". Back changes nothing.
- When the log of the first try is not on this computer, the note has the same text and no list.
  It names the computer where the task ran. This holds for a task of the other computer of a sync
  pair (019) and for a client of a linked server (012).
- A routine or a workflow that tries again by itself shows no note. The note belongs to the Retry
  button.

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
- A message that joins a running turn (see 003) belongs to the task of that turn. It does not
  make a new task. The prompt of the task stays the message that started it.
- The usage page (see 006) shows, for each agent and day, the median "First reply" time of the
  chat tasks that ended as done.
- The times are stored in the local database with the task. They hold no message text.
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
- A fake provider waits 2 seconds, then streams a reply. The task shows a "First reply" time of
  2 seconds or a little more. A task that failed before any reply shows "—" for "First reply".
- A message joins a running turn: the tasks page shows one task, and its detail lists the
  message under the prompt.
- A task waits for an approval. Restart the app: the task is still waiting, and its card shows
  again. Allow the step: the task goes on.
- A task waits for an approval, and a second task for the same agent is queued. Restart the app:
  the first task still waits. The second task shows as failed with the restart reason.
- A channel request has a parent and two child tasks. One child fails. "End the request" cancels
  the other child and the parent. A child that is done stays done.
- A stand-in provider makes agent A send a message to agent B, and B send one back, without end.
  The send of the task at depth 8 fails with the reason of the chain limit and the step shows it.
  No more task starts from a send. The reply that was due still comes back.
- Set the step limit to 20. A stand-in provider calls a tool in every turn without end. The task
  ends as Failed at step 20 with the reason "Step limit reached (20)." The streamed reply stays.
- A stand-in provider reads the same unchanged file three times in one turn. The third step
  fails with the short text. After the file changes, a read of it works.
- A routine run: the agent ends its reply with the line "Blocked: no access to the folder". The
  task ends as Blocked with that reason. A reply with no such line ends as Done.
- A task wrote a file and then failed. Retry shows the retry note with the write step. Back
  starts nothing. Retry anyway starts a new task. A task that only read files starts at once on
  Retry.
