# 005 Tasks and plan steps

## Purpose

Every piece of agent work is a task the user can see, stop and retry, in chats, channels, routines
and workflows.

## Concepts

- **Task**: who does it (agent), what (prompt), where it came from (chat, channel, routine,
  workflow, another agent, a memory check (008), a card of the board (024), an outside program
  (023), or a handover (003)), its parent task if
  any, its state, start and end time, and its result or error.
- **Depth**: a number. A task that the user, a routine, a workflow, a memory check, a handover or
  an outside program starts has depth 0. See
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
- **Progress**: how far the turn of a task went. See "How far a turn went".
- **Usage**: the tokens that the turns of the task used, as the provider reports them. See "Usage
  of a task".
- **Done test** and **verdict**: a part of a channel (see 004) can have a done test. After the
  check of the lead it can have a verdict, "Met" or "Not met" with a reason. Both are fields of
  the task. The verdict is not a state: a part with a verdict is still Done.

## Tasks page

- A table of tasks, newest first: agent face and name, label, source, state, duration.
- Filters: state, agent, source. Search by label.
- A task that the user starts from a card (024) has the source "Board" and the title of the card as
  its label. Its view shows a link "Card #<number>" that opens the card, or the line "Card
  removed." when the user deleted the card.
- A row opens the task: its prompt, its steps, its messages, its child tasks as a tree, and its
  three times. The messages that joined the task during its turn (see 003) are listed under the
  prompt, with their times. For a part it also shows the done test and the verdict. It shows a
  list of moments too (see "Moments").
- Actions: stop (queued, running or waiting), retry (failed, blocked or cancelled), accept or
  request changes (in review; see "Review"), run next (queued; see "Queue"), open source place,
  make a skill (done; see 017, "Make a skill from work"). "Make a skill" is on the computer only.
- A task of a channel (see 004) also has "End the request", which cancels the whole request.
- A queued task shows what it waits behind: the work that its agent runs now, with the place of
  that work. If the agent is busy in its own chat, the line says so. If the agent is busy in
  another thread, the line says so. A task that waits for a free slot (see "Queue") says so and
  shows the number of slots.

## Usage of a task

The usage page (006) shows usage per agent and day. A job of a channel or a run of a routine can
use many agents. The user must see what one piece of work used.

- Each task keeps the tokens that its turns used, as the provider reports them: input, output, and
  cached input when the provider reports it. When the provider reports a cost, the task keeps the
  cost too. A number that the provider does not report shows as "—", never as 0.
- The task view shows the usage of the task. A task with child tasks also shows the total of the
  whole tree, and one line for each agent in the tree with its share. The lines are in the order of
  the largest total first.
- The cached share is cached input divided by all input, in percent. It shows only when the
  provider reports cached input.
- In a channel, the card of the lead in the activity panel (004) shows the total tokens of the job
  that runs. It changes when a turn of the job ends.
- A run of a routine (009) shows the total tokens of its tasks in the run details.
- An agent on a vendor runtime (006) reports usage at the end of each turn. Its share changes only
  then. A runtime that reports no usage adds nothing, and its line shows "—".
- The numbers hold no message text. They sync with the task (019) and an export holds them (014).
  The phone and a linked device show them in the task view (011, 012).

## Moments

- The task view lists the moments of the task, each with its clock time. A moment that did not
  happen does not show.
  1. Given: the task was made, and by whom (the source, the lead, or another agent).
  2. Started: the agent began the turn.
  3. Ended: the turn ended. The line says how: done, failed, blocked, cancelled, or waiting for
     review.
  4. Decided: the user accepted a part, or asked for changes. The line shows the text of the
     request for changes.
  5. Judged: the lead gave the verdict. The line shows the verdict and its reason.
  6. Closed: the task reached a final state.
- The three times (see "Times") keep their own meaning. The moments only add the clock time of
  each event.
- A task of a chat, a routine or a workflow has no "Decided" and no "Judged".
- The list is plain text. It never shows the thinking of the agent.

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

## How far a turn went

A turn is the work that one agent does for one task. Each turn has a progress:

- **Not sent**: the app has not given the request to the model or to the program of the vendor.
  A task that is queued has this progress.
- **Sent**: the app gave the request over, and nothing has come back.
- **Started**: something came back: a part of the reply, thinking, a tool step, an approval
  request, or a question.

The progress only goes up. It never goes back. A task that is retried makes a new turn, which
starts at "Not sent".

A turn can fail because of an error, a restart, or the silent limit. Then the failed row (003) and
the task show one line for the progress. A Stop by the user shows no line, because the user chose
it. The lines are:

- Not sent: "The request did not reach the model. It is safe to try again."
- Sent: "The model may have started. Check the workspace before you try again."
- Started: "The agent had started to work. Some steps may have run. Check the workspace before
  you try again."

The line sits beside Retry. Retry works for every progress. The retry note (see "Retry note") is a
separate check that shows when the user presses Retry. A turn that was Not sent ran no step, so
its Retry shows no retry note.

## Silent turns

- A turn is silent when the model or the program shows no sign of life for the silent limit. The
  limit is 10 minutes. The user can change it in Settings (see 013).
- A sign of life is a new part of the reply, new thinking, a tool step that starts or ends, an
  approval request, or a question.
- The clock starts when the app hands the request over. It stops, and starts again at 0 after
  the stop, in these cases: the turn waits for the user (an approval or a question); the user
  holds the browser (007); a tool step runs, from its start to its end as the app sees it. Time
  while the computer sleeps does not count.
- A tool step has no limit of its own in this version. The user ends a step that does not end
  with Stop.
- When the limit is reached, the app stops the turn in the same way as a Stop of the user. The
  task fails with the reason "No answer for N minutes.", where N is the limit in minutes ("No
  answer for 1 minute." when N is 1). The failed row has Retry (003).
- A failed task by this rule is like any failed task: one notification of the kind "task failed"
  (015), and for a routine run the count of failed runs (009).
- The limit holds for every turn: a chat, a part of a channel job, a routine, a step of a
  workflow, and a message from another agent.

### Quiet line

A turn can be quiet for a long time and still finish, for example while a model works on a long
answer and sends no part of it. The user must see that nothing arrives before the silent limit
stops the turn.

- A turn is quiet when it shows no sign of life for the quiet time. The quiet time is 90 seconds
  or half of the silent limit, whichever is shorter. With the silent limit Never, it is 90
  seconds.
- The quiet clock is the clock of the silent limit. It stops and starts again at 0 in the same
  cases.
- While a turn is quiet, every place that shows the turn as working shows the quiet line in place
  of its working text: "No answer from <name> for <time>". The name is the name of the model
  account, or of the vendor program for an agent on a vendor runtime (006). The time is the time
  on the quiet clock, so it starts at the quiet time. It reads m:ss, and h:mm:ss after one hour,
  and changes once each second.
- The places are: the working line of a chat (003), including a turn of a routine or a step of a
  workflow that shows there, the plan step of a part in the activity panel (004, as the text label
  of the running icon and its tooltip), the row of the task on the Tasks page (as the state text),
  the live run state of a workflow (010), the row of the agent in the detail card of the status
  island (015), and the same places on a phone and on a linked device (011, 012).
- Each place keeps its own elapsed time of the turn. The quiet line replaces only the text.
- The quiet line does not stop the turn. Stop stays where it was. The user can stop the turn, or
  wait.
- At the next sign of life, the quiet line goes away at once, and the place shows its working
  text again. The quiet clock starts again at 0.
- The quiet line makes no notification, no sound, no row on the Today page (021), and no entry
  in the action log. A turn that becomes quiet more than once shows the line each time.
- When the silent limit is reached, the turn fails as before. The failed row replaces the quiet
  line.
- The quiet line is not stored. It does not sync (019), an export (014) does not hold it, and the
  cache of a phone or a linked device (012) does not keep it. After a restart, a running turn has
  failed and a waiting turn has its clock stopped (see "Rules"), so no quiet line is left.
- A profile that is not open (022) shows nothing on the computer, as for other work. When the user
  opens it, its places show the quiet line of a turn that is still quiet.
- The quiet line has no way in and no way out of its own: it starts and ends with the turn, and
  Stop is the way to end the turn. It has no setting apart from the silent limit.
- The quiet line is the same for an agent that uses the tools of the app and for an agent on a
  vendor runtime. For a vendor runtime, a sign of life is what the program reports to the app.

## Queue

- Each agent has one queue. A task joins it when the app makes the task. All threads of the agent
  (003) share this queue. The rules of this section are the same for every runtime (006).
- The queue of an agent holds at most 20 queued tasks. A task that waits for the user, or for a
  task that it gave out, is not queued and does not count. The reason for a task over the limit is
  "<name> has 20 tasks that wait. Try again later." What happens:
  - A message of the user: the app makes no task. The box keeps its text and shows the reason. A
    queued message (003) that the app sends at the end of a turn stays in the message queue and
    shows the reason.
  - A run of a routine: the app makes no task, and the run is Failed (009).
  - A step of a workflow: the app makes no task, and the step fails (010).
  - A part of a channel job: the app makes the part in the state Failed, with the reason, so that
    the lead and Retry see it.
  - "Send message" (007) and an outside program (023): the call gets the reason. No task is made.
  - A reply that comes back (see "Limits of a task") always makes its task, also over the limit.
  - A memory check (008) is not added. The app adds it after the next turn that ends as done.
  - Retry, a nudge and a request for changes follow the rule of their source.
- **Order**: the tasks that wait start in this order. It holds for the queue of one agent and for
  the slots described below.
  1. The tasks that the user picked with "Run next", the latest pick first.
  2. The tasks of normal sources, the oldest first. These are a chat, a channel, another agent and
     an outside program.
  3. The tasks of background sources, the oldest first. These are a routine and a workflow.
  4. A memory check. It starts only when its agent has no other task that runs or waits (008).
- A new task never stops a task that runs. It only takes its place in the order. A task of a
  background source has no time limit in the queue. A run of a routine that is still queued when
  the next run is due counts as a run that is still going, so the next run is Skipped (009).
- **Run next**: on a queued task, the user picks "Run next" on the Tasks page or on the line of the
  queued task. The task goes to the front of the order. It does not stop the task that runs. It
  works for every queued task, also a part of a channel job and a workflow step. It cannot start a
  task before a task of its agent that waits for the user. It is off for a task that is not
  queued. It has no undo: the position matters only until the task starts. A linked computer and
  the phone do not have it in this version (011, 012).
- **Agents at once**: a setting in General (013), "Agents working at once". It is a whole number
  from 1 to 8. The default is 4. The word "slot" means one of the tasks that can run at the same
  time.
  - At most that many tasks run at the same time in one profile (022). Each profile uses its own
    number, also when it is not open. Each task that runs uses one slot.
  - A task that waits for the user (an approval or a question) uses no slot. A task that waits for
    a task that it gave out uses no slot either. So a parent task and its child cannot hold each
    other, also when the number is 1.
  - When the user answers, or when the last child ends, the task needs a slot again. If none is
    free, it waits as queued at the front of the order, before the "Run next" picks. Its agent
    stays held, so no other task of that agent starts.
  - A task that cannot start because all slots are in use waits as queued. Its line says "Waits
    for a free slot". When a slot is free, the first task in the order whose agent is not busy
    starts. The tasks of a busy agent keep their place in the order.
  - A new number applies at once to the tasks that wait. A task that runs is never stopped for it.
    Stop of a task frees its slot at once.
  - The number is a setting of the profile (013).
- When two computers sync (019), each computer counts and orders the tasks that it made. "Run
  next" is on only on the computer that made the task. A pick does not sync.

## Rules

- One agent runs one task at a time. Other tasks for it wait in its queue, in the order of
  "Queue". When two computers sync (019) and both are online, this holds across both computers.
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
  user for any other reason, for example while the user holds the browser. The progress that the
  turn had reached stays, and the failed task shows its line.
- When two computers sync (019), the progress of a task syncs with the task.

## Acceptance

- Start two tasks for one agent: the second waits until the first ends.
- An agent runs a long task. A routine task and then a chat task wait for the same agent. The chat
  task starts first, although the routine task came first. Two routine tasks start in the order
  they were made. A memory check waits behind both.
- Three tasks wait for one agent. Pick "Run next" on the third: it starts first when the running
  task ends. Pick it on the second afterwards: the second starts before the third.
- The queue of an agent holds 20 queued tasks. The 21st chat message is not made as a task, and the
  box keeps its text and shows "<name> has 20 tasks that wait. Try again later." A routine run in
  the same state is a failed run with that reason. A part of a channel job is made as Failed with
  that reason. A reply that comes back from another agent still starts its task.
- Set "Agents working at once" to 2 and give a task to each of three agents. Two tasks run. The
  third shows "Waits for a free slot". Stop one running task: the third starts at once. Raise the
  number to 3 while one waits: it starts at once and the tasks that run go on.
- The number is 2 and three tasks wait. The agent of the first task is busy in a chat. When a slot
  is free, the second task starts and the first keeps its place in the order.
- A task waits for an approval, and the number is 1. A task of another agent starts and runs. A
  second task of the first agent stays queued.
- The number is 1. Task A waits for an approval, and the task of another agent runs and takes the
  slot. The user allows the step of A: A waits as queued, with its agent held, and runs when the
  slot is free.
- The number is 1. Agent A gives a part to agent B and waits for its answer. B starts, and A holds
  no slot. The part ends and A goes on.
- Two tasks of one agent in two threads: the second waits, and its thread shows "Waits for another
  thread".
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
- A channel job with two parts. The stand-in providers report 1000 input and 200 output tokens for
  the lead, and 3000 and 500 for each part. The task view of the job shows a total of 7000 input
  and 1200 output tokens, with one line for each of the three agents, largest first. The card of
  the lead in the activity panel shows the same total.
- A channel job with three parts, where the third member uses a stand-in that reports no usage:
  its line shows "—", and the total counts the other agents only.
- A stand-in reports 8000 input tokens with 6000 of them cached: the task view shows a cached
  share of 75%. A stand-in that reports no cached input shows no cached share.
- A routine run with two tasks shows the total tokens of both in its run details.
- Set the step limit to 20. A stand-in provider calls a tool in every turn without end. The task
  ends as Failed at step 20 with the reason "Step limit reached (20)." The streamed reply stays.
- A stand-in provider reads the same unchanged file three times in one turn. The third step
  fails with the short text. After the file changes, a read of it works.
- A routine run: the agent ends its reply with the line "Blocked: no access to the folder". The
  task ends as Blocked with that reason. A reply with no such line ends as Done.
- A task wrote a file and then failed. Retry shows the retry note with the write step. Back
  starts nothing. Retry anyway starts a new task. A task that only read files starts at once on
  Retry.
- Set the silent limit to 1 minute. A stand-in model sends nothing for 90 seconds: at about 60
  seconds the turn stops and the task fails with "No answer for 1 minute.". The failed row has
  Retry, and one notification of the kind "task failed" shows.
- The silent limit is 1 minute. A turn waits for an approval for 2 minutes: it does not fail. The
  user allows the step, the stand-in model then sends nothing for 90 seconds: the turn fails.
- The silent limit is 10 minutes. A stand-in model sends one reply part, then nothing for 100
  seconds, then the rest of the reply. 90 seconds after the first part, the working line of the
  chat reads "No answer from <account name> for 1:30", and the Tasks page row and the island
  detail card show the same text. No notification shows. When the next part arrives, the working line shows again, and the
  turn ends as done.
- The silent limit is 1 minute. A stand-in model sends nothing: the quiet line shows at about 30
  seconds, and the turn fails at about 60 seconds.
- A turn waits for an approval for 3 minutes: no quiet line shows. The user allows the step, and
  the stand-in model then sends nothing: the quiet line shows 90 seconds after the allow, not
  before.
- A stand-in model starts to send a reply, and the app ends at once. After the restart, the failed
  task shows the line for "Started". A task that was only queued shows the line for "Not sent".
- Retry a task whose line said "Started": the new task runs, and its progress starts at "Not
  sent".
- A part with a done test ends, and the lead gives it "Not met". The task view shows the done test,
  the verdict "Not met" with its reason, and the moments Given, Started, Ended, Judged and Closed
  with times. The state of the part is still Done.
- Turn on "Review parts". A part ends and the user accepts it: the moments show Decided and no
  Judged, and the done test still shows.
- A task of a direct chat ends: its view shows Given, Started, Ended and Closed. It shows no done
  test, no verdict, no Decided and no Judged.
