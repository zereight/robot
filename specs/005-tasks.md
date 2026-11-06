# 005 Tasks

## Purpose

Every run of a node is a task. The user can see, stop and retry a task, and can see why it waits,
stopped or failed, and what it made.

## Concepts

- **Task**: one execution of one node of a workflow (010). A run is made of tasks. A task has the
  node (its name and number), the run, the trigger that started the run (by hand, the chat, or a
  schedule; see 010, "Trigger"), the input of the node, its state, start and end time, and its
  result or error. A node that is skipped, or that the run has not reached, makes no task
  (see "States and reasons").
- **Run**: one execution of a workflow (010). The state of a run follows its tasks: it waits for
  the user while one of its tasks waits for the user. It stops when a node fails, unless the node
  has the mark "Continue on failure" (010). Stop ends it. The list of runs (010) shows the states.
  The names of the states of a run are not decided (see the questions for 005).
- **Turn**: one request to a model, and the work that follows until the reply ends. A task has one
  turn or more (see "Keep going"). The chat of the workflow has turns too (003). They are not
  tasks.
- **States**: queued, running, waiting for the user, done, failed, blocked, or cancelled. A task
  goes queued → running → (waiting for the user ↔ running) → done, failed, blocked or cancelled.
  "Blocked" is not in 000 (see the questions for 005). A node also shows as "skipped" or as "not
  reached" (see "States and reasons"). Other specs and the chat use these words.
- **Reason**: every state that is not done and not running has a reason in words. See "States and
  reasons".
- **Result**: what a node made. A task keeps its result when it ends. A done task keeps the
  result. A failed or cancelled task keeps the part that it made before it ended. The result is
  an intermediate result of the run until the run ends.
- **Times**: each task keeps three times, in seconds.
  - **Wait**: from the moment the task is made to the moment it starts.
  - **First reply**: from the moment the task is made to the first part of the reply that the app
    stores and the user can see. Reply text counts, and so do a question card and an approval
    card. Thinking, the working line and tool cards do not count.
  - **Total**: from the moment the task is made to the end of the task. It includes the time that
    the task waited for the user.
  - A time that is not known is shown as "—", never as 0. A restart keeps the times that are
    known. Retry makes a new task with its own times.
- **Progress**: how far the turn of a task went. See "How far a turn went".
- **Usage**: the tokens that the turns of the task used, as the provider reports them. See "Usage
  of a task".

The responsible document reports these states and reasons in the chat of the workflow, and the
results of ended tasks (003).

## States and reasons

- **Queued**: the task waits to start. The reason is one of these.
  - "Waits for a free slot", with the number of slots (see "Queue").
  - "Waits behind <node>": the workflow runs another task now. The line names that node and its
    run.
- **Running**: the node works. The working line shows. While the turn is quiet, the quiet line
  shows (see "Quiet line").
- **Waiting for the user**: the task waits for an answer. The reason is one of these.
  - "Waits for your approval": an approval card (007).
  - "Waits for your answer": a question card.
  - "Waits for your pick": a decision node found no winner. It asks the user to pick an option
    (010, "Flows", item 6).
  A scheduled run has no user at that moment. Its task keeps waiting as a task that waits for the
  user. It has no time limit. The user answers it, or stops it.
- **Done**: the node ended with no error. The result is kept.
- **Failed**: the node ended with an error. The reason is the text of the error. Some reasons are
  fixed texts: "The app stopped", "No answer for N minutes.", "Step limit reached (N).", and the
  reason of the queue. A failed task keeps the part of the result that it made.
- **Blocked**: the node could not do its work (see "Blocked"). The reason is the text after
  "Blocked:".
- **Cancelled**: the user stopped the task, or stopped its run. The reason is "Stopped by you". A
  task that was queued when the user stopped its run shows "The run was stopped".
- **Skipped**: no input passed to the node (010, "Node input and output"). A skipped node makes no
  task. The run view shows the node as skipped.
- **Not reached**: not a state of a task. The run has not reached the node yet, so the node has no
  task. The run view and the chat show the node as not reached.

## Tasks page

- A table of tasks, newest first: workflow name, node name, source, state, duration.
- The page holds two tabs at the top of its header line: "Tasks" and "Events" (038). The tab
  "Events" holds the list of the events of this computer. Nothing else on the page changes.
- Filters: state, workflow, source. What the search matches is not decided (see the questions for
  005).
- The source of a task is the trigger of its run: "By hand", "From the chat", or "Schedule".
  Other triggers are not decided (see the questions for 010).
- A row opens the task: its node, its input, its steps, its result, and its three times. It shows
  a list of moments too (see "Moments").
- Actions: stop (queued, running or waiting), retry (failed, blocked or cancelled), run next
  (queued; see "Queue"), and open the run.
- A queued task shows its reason (see "States and reasons").

## Usage of a task

The usage page (006) shows usage. The user must see what one run used.

- Each task keeps the tokens that its turns used, as the provider reports them: input, output, and
  cached input when the provider reports it. When the provider reports a cost, the task keeps the
  cost too. A number that the provider does not report shows as "—", never as 0.
- A decision node uses no reasoning level and writes no text. Its task shows the tokens that the
  decision model reports, or "—" when it reports none.
- The task view shows the usage of the task. The run view shows the total of the run and one line
  for each node with its share. The lines are in the order of the largest total first.
- The cached share is cached input divided by all input, in percent. It shows only when the
  provider reports cached input.
- A node on a vendor runtime (006) reports usage at the end of each turn. Its share changes only
  then. A runtime that reports no usage adds nothing, and its line shows "—".
- The numbers hold no message text. They sync with the task (019) and an export holds them (014).
  The phone and a linked device show them in the task view (011, 012).
- What the usage page groups by is not decided (see the questions for 005).

## Moments

- The task view lists the moments of the task, each with its clock time. A moment that did not
  happen does not show.
  1. Given: the task was made, and by which run and trigger.
  2. Started: the node began its turn.
  3. Ended: the turn ended. The line says how: done, failed, blocked or cancelled.
  4. Closed: the task reached a final state.
- The three times (see "Times") keep their own meaning. The moments only add the clock time of
  each event.
- The list is plain text. It never shows the thinking of the model.

## Limits of a task

These limits stop a task that runs without progress. They are not a cap on the total cost of many
tasks.

- **Steps.** One tool call is one step. For a node on a vendor runtime (006), one tool card is one
  step. A task that reaches the step limit stops at once and ends as Failed with the reason "Step
  limit reached (N)." The reply that streamed stays and is marked as stopped. The limit is a
  setting (013). The default is 300 steps.
- **Repeated reads.** In the turn of a text node that uses the tools of the app, a step that reads
  a file or fetches a web page is refused when two earlier steps of the same turn had the same
  target and the same result. The step fails with a short text that tells the model to use the
  result it already has. The turn goes on. A read that gives a new result is not refused.

## Blocked

- A text node tells its model this: if you could not do the work, end the reply with a last line
  that starts with "Blocked:" and gives the reason in one sentence. Write that line in no other
  case. A reply in the chat gets no such text, because the user reads the reply there (003).
- When a turn ends with no error, the app reads the last line of the reply that has text. If it
  starts with "Blocked:" (in any letter case), the task ends as Blocked. Its reason is the text
  after the colon, cut at 200 characters. The line stays in the result.
- A turn that ends with an error is Failed, not Blocked. A turn that the user stops is
  Cancelled.
- Blocked is a final state. Retry works as for a failed task. A blocked task counts as a failed
  one for the mark "Continue on failure" and for the stop of a run (010), and for the notice "task
  failed" (015). The Tasks page shows it with its own label and icon.

## Keep going

A model can end a turn before its work is done and leave steps open. The app can ask it to go on,
so the user does not need to sit by it.

- A setting in General (013), "Keep going on open steps", is on by default.
- This holds for a text node whose program or runtime reports a list of steps (a plan) to the app
  (006). A node that reports no list has no step that can be open, so nothing goes on by itself.
- The app decides from the list, not from the words of a reply. The only line of a reply that the
  app reads is the last line "Blocked:" (see "Blocked").
- A turn goes on when it ends with no error, no Stop, no "Blocked:" line and no waiting card, and
  the last list holds at least one step that is not done. The app sends one short message. It asks
  the model to go on with the open steps, and to ask the user with a question card when it needs
  a decision. It is not a message of the user. The run view shows a muted line, "Kept going (1 of
  8)".
- It is the same task. The steps add to the step limit and to the usage of the task. The silent
  limit and Stop work as before.
- A task can go on at most 8 times.
- The continuations stop earlier when the open steps are the same as before the last
  continuation: the same count and the same labels. The task then ends as it does without Keep
  going: Done, when the last turn ended with no error. The run view shows no line for this stop.
- A question card is a wait, not an end, so no continuation starts while it shows. A question
  in the plain text of a reply makes no card. The go-on message does not answer it. The app
  never answers a question of the model for the user.
- A turn that a continuation follows makes no notification, no result card and no sound for its
  end (015). They come when the task ends.
- A task that is cancelled, failed or blocked does not go on.
- The muted line is stored with the run and syncs with it (019). A linked device and the phone
  show it. The setting is local to the computer (013).

## Retry note

A step that may change things is a file write, a shell command, or a tool of a connection (007)
that the action log lists with the result Ran, Failed or Stopped. A step that failed or stopped
may have run in part.

- The user can press Retry on a failed, blocked or cancelled task. If the earlier try has at
  least one step that may change things, a note shows first and the new try waits. If it has
  none, the retry starts at once.
- The note says that the first try ran steps that may have changed things, that Failed, Blocked
  and Cancelled do not undo them, and that the user should check the state before another try.
  It lists at most 5 of these steps, newest first, with the kind, the target and the result. If
  more exist, it ends with "and N more".
- Two buttons: "Retry anyway" and "Back". Back changes nothing.
- When the log of the first try is not on this computer, the note has the same text and no list.
  It names the computer where the task ran. This holds for a task of the other computer of a sync
  pair (019) and for a client of a linked server (012).
- A model call that the app tries again by itself (see "Rules") shows no note. The note belongs to
  the Retry button.
- What Retry does to the run of the task is not decided (see the questions for 005).

## How far a turn went

Each turn has a progress:

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
- Sent: "The model may have started. Check the folder before you try again."
- Started: "The node had started to work. Some steps may have run. Check the folder before you
  try again."

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
  (015).
- The limit holds for every turn: a turn of a node and a turn of the chat.

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
  account, or of the vendor program for a node on a vendor runtime (006). The time is the time
  on the quiet clock, so it starts at the quiet time. It reads m:ss, and h:mm:ss after one hour,
  and changes once each second.
- The places are: the working line of the chat (003), the row of the task on the Tasks page (as
  the state text), the live run state of a workflow (010), the row of the workflow in the detail
  card of the status island (015), and the same places on a phone and on a linked device (011,
  012).
- Each place keeps its own elapsed time of the turn. The quiet line replaces only the text.
- The quiet line does not stop the turn. Stop stays where it was. The user can stop the turn, or
  wait.
- At the next sign of life, the quiet line goes away at once, and the place shows its working
  text again. The quiet clock starts again at 0.
- The quiet line makes no notification, no sound, and no entry in the action log. A turn that
  becomes quiet more than once shows the line each time.
- When the silent limit is reached, the turn fails as before. The failed row replaces the quiet
  line.
- The quiet line is not stored. It does not sync (019), an export (014) does not hold it, and the
  cache of a phone or a linked device (012) does not keep it. After a restart, a running turn has
  failed (see "Rules"), so no quiet line is left.
- A profile that is not open (022) shows nothing on the computer, as for other work. When the user
  opens it, its places show the quiet line of a turn that is still quiet.
- The quiet line has no way in and no way out of its own: it starts and ends with the turn, and
  Stop is the way to end the turn. It has no setting apart from the silent limit.
- The quiet line is the same for a node that uses the tools of the app and for a node on a vendor
  runtime. For a vendor runtime, a sign of life is what the program reports to the app.

## Queue

- Each workflow has one queue. A task joins it when the app makes the task. The rules of this
  section are the same for every runtime (006).
- The queue of a workflow holds at most 20 queued tasks. A task that waits for the user is not
  queued and does not count. The reason for a task over the limit is "<name> has 20 tasks that
  wait. Try again later." The name is the name of the workflow. What happens:
  - A run that the user starts by hand or from the chat: the app makes no task, and shows the
    reason.
  - A run that a schedule starts: the app makes no task, and the run is Failed.
  - A later node of a run: the app makes no task, and the node fails (010).
  - Retry follows the rule of its source.
  - A memory check (008) is not added. The app adds it after the next task that ends as done.
  - A start by an outside program (023) or by a message from Teams (028) is not decided (see the
    questions for 005).
- **Order**: the tasks that wait start in this order. It holds for the queue of one workflow and
  for the slots described below.
  1. The tasks that the user picked with "Run next", the latest pick first.
  2. The tasks of runs that the user started, by hand or from the chat, the oldest first.
  3. The tasks of runs that a trigger started, the oldest first.
  4. A memory check. It starts only when its workflow has no other task that runs or waits (008).
- A new task never stops a task that runs. It only takes its place in the order. A task of a run
  that a trigger started has no time limit in the queue. What happens when a trigger fires while
  a run of the workflow still goes is not decided (see the questions for 010).
- **Run next**: on a queued task, the user picks "Run next" on the Tasks page or on the line of the
  queued task. The task goes to the front of the order. It does not stop the task that runs. It
  cannot start a task before a task of its workflow that waits for the user. It is off for a task
  that is not queued. It has no undo: the position matters only until the task starts. A linked
  computer and the phone do not have it in this version (011, 012).
- **Tasks at once**: a setting in General (013), "Agents working at once". It is a whole number
  from 1 to 8. The default is 4. The name of the setting still says "agents" (see the questions
  for 005). The word "slot" means one of the tasks that can run at the same time.
  - At most that many tasks run at the same time in one profile (022). Each profile uses its own
    number, also when it is not open. Each task that runs uses one slot.
  - A task that waits for the user (an approval or a question) uses no slot.
  - When the user answers, the task needs a slot again. If none is free, it waits as queued at the
    front of the order, before the "Run next" picks. Its workflow stays held, so no other task of
    that workflow starts.
  - A task that cannot start because all slots are in use waits as queued. Its line says "Waits
    for a free slot". When a slot is free, the first task in the order whose workflow is not busy
    starts. The tasks of a busy workflow keep their place in the order.
  - A new number applies at once to the tasks that wait. A task that runs is never stopped for it.
    Stop of a task frees its slot at once.
  - The number is a setting of the profile (013).
- When two computers sync (019), a workflow runs on one computer only (010). That computer counts
  and orders its tasks. "Run next" is on only on that computer. A pick does not sync.

## Rules

- One workflow runs one task at a time. Other tasks for it wait in its queue, in the order of
  "Queue". Whether tasks of parallel branches may run at the same time is not decided (see the
  questions for 005).
- A task waiting for the user (an approval or a question) does not block other workflows.
- Stopping a run stops its tasks. A run whose tasks are all cancelled shows as cancelled, not as
  done.
- A model call that gets a plain failure is tried again: 3 tries, 2 seconds apart. A usage limit,
  a busy model and a shutdown end the call at once (010). This holds for a text node and for a
  decision node. The task is Failed after the last try.
- A failed node stops the run, unless the node has the mark "Continue on failure" (010).
- A decision node that finds no winner waits as a task that waits for the user (see "States and
  reasons").
- The times are stored in the local database with the task. They hold no message text.
- Retry makes a new task of the same node with the same input and links it to the old one.
- After an app restart, a run that was going is marked failed with the reason "The app stopped"
  (010). Its tasks fail the same way. This includes a task that waits for the user, and a task
  that waits while the user holds the browser. The user can retry a task. The progress that the
  turn had reached stays, and the failed task shows its line.
- When two computers sync (019), the progress of a task syncs with the task.

## Surfaces

- **Ways in**: the Tasks page, the run view of a workflow (010), and the chat of the workflow
  (003).
- **Devices**: the computer shows and changes tasks. A linked computer and the phone show the
  states, the reasons, the usage and the results, and can stop a run (010, 011, 012).
- **Ways out**: Stop for a task or a run, Retry for a failed, blocked or cancelled task.
- **Seeing the state**: the Tasks page, the run view, and the chat. After a restart, the state of
  a task stays (see "Rules").
- **Data**: tasks, times and usage sync with the workflow (019) and an export holds them (014).

## Out of scope

- A parent task, a child task, and split work. A task has no child (see the questions for 005).

## Acceptance

- A node fails: its task shows Failed with the text of the error. The responsible document tells
  the user the reason in the chat when asked (003).
- A workflow with a queued task and a running task: the queued task shows "Waits behind <node>".
- Two runs of one workflow start: the second run waits until the first ends.
- A run that a schedule started and a run that the user started by hand wait for one workflow. The
  run of the user starts first, although the run of the schedule came first. Two runs of the
  schedule start in the order they were made. A memory check waits behind both.
- Three tasks wait for one workflow. Pick "Run next" on the third: it starts first when the
  running task ends. Pick it on the second afterwards: the second starts before the third.
- The queue of a workflow holds 20 queued tasks. The 21st start by hand makes no task, and the
  page shows "<name> has 20 tasks that wait. Try again later." A run that a schedule starts in
  the same state is a failed run with that reason.
- Set "Agents working at once" to 2 and let three workflows have a task each. Two tasks run. The
  third shows "Waits for a free slot". Stop one running task: the third starts at once. Raise the
  number to 3 while one waits: it starts at once and the tasks that run go on.
- The number is 2 and three tasks wait. The workflow of the first task is busy. When a slot is
  free, the second task starts and the first keeps its place in the order.
- A task waits for an approval, and the number is 1. A task of another workflow starts and runs. A
  second task of the first workflow stays queued.
- The number is 1. Task A waits for an approval, and the task of another workflow runs and takes
  the slot. The user allows the step of A: A waits as queued, with its workflow held, and runs when
  the slot is free.
- A decision node finds no winner in a scheduled run: its task shows "Waits for your pick". No user
  is there, and the task keeps waiting. The user opens the task and picks an option: the run goes
  on.
- Restart during a run: its tasks show Failed with "The app stopped", also a task that waited for
  an approval, and the user can retry a task.
- A fake provider waits 2 seconds, then streams a reply. The task shows a "First reply" time of
  2 seconds or a little more. A task that failed before any reply shows "—" for "First reply".
- A task ends as done: its result stays in the task view, and the chat shows it as an intermediate
  result while the run goes on (003).
- A node has the mark "Continue on failure" and fails: the next node runs. Without the mark, the
  run stops.
- A stand-in provider fails twice with a plain failure and then answers: the task ends as Done. It
  fails three times: the tries are 2 seconds apart, and the task is Failed after the third try. A
  usage limit fails the task at once.
- Two nodes use a stand-in provider. The stand-ins report 1000 input and 200 output tokens for the
  first node, and 3000 and 500 for the second. The run view shows a total of 4000 input and 700
  output tokens, with one line for each node, largest first.
- The same with a stand-in for the second node that reports no usage: its line shows "—", and the
  total counts the first node only.
- A stand-in reports 8000 input tokens with 6000 of them cached: the task view shows a cached
  share of 75%. A stand-in that reports no cached input shows no cached share.
- Set the step limit to 20. A stand-in provider calls a tool in every turn without end. The task
  ends as Failed at step 20 with the reason "Step limit reached (20)." The streamed reply stays.
- A stand-in provider reads the same unchanged file three times in one turn. The third step
  fails with the short text. After the file changes, a read of it works.
- A text node: the model ends its reply with the line "Blocked: no access to the folder". The
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
  seconds, then the rest of the reply. 90 seconds after the first part, the working line reads
  "No answer from <account name> for 1:30", and the Tasks page row and the island detail card show
  the same text. No notification shows. When the next part arrives, the working line shows
  again, and the turn ends as done.
- The silent limit is 1 minute. A stand-in model sends nothing: the quiet line shows at about 30
  seconds, and the turn fails at about 60 seconds.
- A turn waits for an approval for 3 minutes: no quiet line shows. The user allows the step, and
  the stand-in model then sends nothing: the quiet line shows 90 seconds after the allow, not
  before.
- A stand-in model starts to send a reply, and the app ends at once. After the restart, the failed
  task shows the line for "Started". A task that was only queued shows the line for "Not sent".
- Retry a task whose line said "Started": the new task runs, and its progress starts at "Not
  sent".
- A task ends: its view shows the moments Given, Started, Ended and Closed, with times.
- A stand-in runtime ends its turn with a list of two open steps: the app sends the short message,
  the run view shows "Kept going (1 of 8)". The stand-in closes both steps and ends: one task,
  ended Done once, with the usage of both turns.
- A stand-in runtime never changes its list of open steps: the app asks once, sees the same list,
  and the task ends. A stand-in runtime that opens a new step at each end: the app asks 8 times and
  the task ends.
- Turn "Keep going on open steps" off: the first end of the turn ends the task.
- A reply ends with the text "Shall I continue?" and the list has no open step: the task ends and
  nothing is sent. The same reply with one open step: the go-on message is sent, and it tells the
  model to use a question card. The app sends no "yes". A node that reports no list: nothing is
  sent.
- A stand-in runtime ends with open steps and a last line "Blocked: no access": the task ends as
  Blocked and nothing is sent.
- Stop a run that has a running task and a queued task: the running task is Cancelled with "Stopped
  by you", and the queued task is Cancelled with "The run was stopped".
