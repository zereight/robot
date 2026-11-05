# 009 Routines

## Purpose

Agents do repeat work on a schedule without the user starting it.

## Concepts

- **Routine**: agent, prompt, one trigger, on/off, the place where results post (the agent's chat
  or a channel), and a model and effort. The model and effort are "Same as the agent" by default.
  The user can pick another model and effort for the routine only, for example a cheaper model
  for a simple check. A routine can also have a token limit for each run (see "Limits and
  safeguards").
- **Routines page**: the list of routines. The Routines button on the rail opens it (001). The
  page does not show workflows. A linked computer shows the button, and the page says to open
  the list on the server (012). The phone has no routines page in this version (011).
- A routine from an agent file (002) shows the muted line "Checked steps of this routine ask until
  you save it once." in its form, until the user saves the form (007, "Ask when unsure"). This
  state syncs with the routine (019).
- **Trigger**: a schedule, or a watch. A routine has one trigger, never both.
- **Schedule**: once at a time; every N minutes or hours; daily at times; weekly on days at a time;
  or a cron expression for advanced users. All in the user's time zone.
- **Watch**: the routine checks one thing at a fixed interval and runs only when it changed. See
  "Watch".

## Flows

1. Create: from the agent profile or the routines list, the user sets prompt, trigger, place, and
   if wanted a model and effort. For a schedule, the app shows the next three run times in words.
2. Calendar: a week and a month view show past runs (done or failed) and future runs.
3. Run now: starts a run at once, outside the schedule.
4. Pause and resume: a paused routine keeps its settings and does not run.
5. Delete: the routine goes with its runs. The button is a danger button and asks first (000,
   "Danger buttons").

## Watch

- The interval is one of: 5, 15 or 30 minutes, 1, 6 or 12 hours, or 1 day.
- What to watch is one of:
  - **A file or a folder**: a path. For a file, the app compares its size, its change time and
    its content. For a folder, it compares the names, sizes and change times of the files inside
    it, also in the folders inside it, up to 2000 files.
  - **The output of a command**: a shell command that runs in the agent workspace. The app
    compares its output and its exit code.
  - **A tool of a connection** (see 018): the connection, the tool and its arguments. The app
    compares the result.
- When the user saves a watch on a command or a tool, the form shows the full command, or the
  connection, the tool and the arguments, and says that it runs at each check without a question.
  The user must confirm to save. A Deny rule (007) that matches the check refuses it at each
  check.
- The first check keeps the result and does not run the routine. Each later check compares with
  the last result. When it differs, the routine runs, and the result becomes the new one to
  compare with.
- A run of a watch gets the prompt and a short text of the change:
  - for a file or a folder: the files that were added, removed and changed, at most 200 lines,
  - for a command or a tool: the old and the new result, each cut to 20000 characters.
  The change text is outside content (see 007).
- A switch "Post when nothing changed" is off by default. When it is on, each check with no
  change posts one muted line in the place of the routine. No task is made for it.
- A check has a time limit of 60 seconds and keeps at most 1 MB of output. A check that fails
  (a missing path, a time limit, a failed tool call, a refusal by a rule) counts as a failed run
  for "Repeated failure". It shows as Failed in the calendar, with the reason. A command that
  ends with an exit code that is not 0 is not a failure: the code is part of the result.
- The detail of a watch routine shows "Checks every N" and the time of the next check. The
  calendar shows its past runs and failed checks, and no future runs.
- While the computer is off or asleep, no check runs. On wake, one check runs at once. No check
  is "Missed".
- A watch with an interval of 5 minutes shows the note "This checks about 288 times a day.", in
  the same way as a short schedule. The note does not stop the save.
- When a check is due while the last run of the same routine still goes, the check waits until
  the run ends.

## Limits and safeguards

- A server holds at most 50 routines. A paused routine counts. The form for the 51st routine
  refuses to save, with the reason in words. Duplicating a routine follows the same limit.
- The smallest step of a schedule is one minute. A schedule that has less than 15 minutes between
  two runs shows a note under the next run times: "This runs about N times a day." N is the
  count for a full day. The note does not stop the save.
- **Token limit**: a routine can have a token limit for each run. It is off by default. The user
  sets a whole number from 1000 to 10000000 in the routine form. It counts the input and output
  tokens of all tasks of the run (005, "Usage of a task"). Cached input counts as input.
  - When a run reaches 80 percent of the limit, the run details show the muted line "80% of the
    token limit is used." It makes no notification.
  - When a run reaches the limit, the app stops the run in the same way as a Stop of the user. The
    run fails with the reason "Token limit reached (N)." It counts as a failed run for "Repeated
    failure".
  - A runtime that reports usage only at the end of a turn (006) is checked then. So a run can go
    over the limit by the size of one turn. The routine form says this for such an agent.
  - A runtime that reports no usage cannot use the limit. The field is off in the form for its
    agent, with the muted line "<program> does not report tokens."
- **Repeated failure**: a routine that fails 3 runs in a row pauses itself.
  - A run that ends as Done sets the count of failed runs to 0. A run that ends as Failed or
    Blocked adds 1. Cancelled, Skipped and Missed runs do not change the count.
  - A run started with Run now counts in the same way as a scheduled run.
  - The routine shows "Paused after 3 failed runs" in the routines list and in its detail, with
    the reason of the last failure. The calendar keeps all past runs.
  - The user gets one notification of the kind "routine failed" (see 015). Its text says that the
    routine is paused.
  - Resume, and any edit of the prompt, the trigger, the agent or the place, sets the count to 0.
    A restart of the app keeps the count.

## Rules

- A routine that the main agent or an outside program makes (037) starts paused, shows "Made by
  <caller>", and counts in the limit of 50. Resume is a separate request that the user allows.
- A starter (see 002) can make a routine for its new agent. The routine starts paused. It uses a
  schedule, posts in the chat of the agent, and counts in the limit of 50.
- Each run is a task (see 005) with the routine as its source. While a run works, the working
  line of the agent names the routine (see 003), because a run has no step text of its own.
- A run whose tasks are all cancelled by the user shows as "Cancelled" in the calendar and the
  run list, not as done.
- A run whose task ends as Blocked (see 005) shows as "Blocked" in the calendar and the run list,
  with the reason of the block. A blocked run counts as a failed run for the pause above.
- Missed runs while the computer was off or asleep: on wake, the app runs at most one missed run
  per routine, and only if it is less than 12 hours late. The others show as "Missed".
- A run that starts more than 15 minutes after its planned time gets both times, in the user's
  time zone, with the prompt. So the agent knows that it runs late and can adapt, for example
  when the prompt says "this morning".
- A run uses the model and effort of the routine. When the account of that model is not
  connected, the run fails with that reason. It does not use another model. When the model does
  not list the effort of the routine, the run uses the effort of the agent, as a workflow step
  does (010).
- A routine with its own model keeps it while the agent is on its backup model. A routine that
  follows the agent uses the backup model (006, "Backup model").
- A run does not start while the previous run of the same routine is still going; it is marked
  "Skipped".
- When two computers sync (019), a routine runs on one computer only. The other computer shows
  "Runs on <name>".

## Acceptance

- A routine every 2 minutes runs twice in 5 minutes and posts both results.
- Sleep through 3 runs, wake: one run starts and two show "Missed".
- Cancel the only task of a run: the run shows as "Cancelled".
- The agent of a routine ends its reply with "Blocked: no access to the folder" in 3 runs in a
  row: each run shows "Blocked" with that reason, and the routine is paused after the third.
- A routine whose agent has no connected provider fails 3 runs in a row: the routine is paused
  with the text "Paused after 3 failed runs", the fourth run does not start, and one
  notification says that the routine is paused. Resume starts the checks again.
- Two runs fail, one is Skipped, one fails: the routine is paused. Two runs fail, one is Done,
  one fails: the routine is not paused.
- With 50 routines, the form for one more refuses to save. Delete one: the save works.
- A schedule of every 5 minutes shows "This runs about 288 times a day." and can be saved.
- A watch on a folder, every 5 minutes: the first check does not run the routine. Add a file to
  the folder: the next check runs the routine, and the run gets the name of the new file. A
  check with no change makes no task.
- A watch on the command `cat missing.txt`: the exit code is not 0, the output is kept, and no
  failure is counted. A watch on a path that does not exist fails 3 checks in a row: the routine
  is paused with "Paused after 3 failed runs".
- A watch on a command needs the confirm before it saves.
- The computer sleeps through a planned run and wakes 40 minutes later: the run gets the planned
  time and the start time.
- A routine with its own model uses that model, while its agent uses another.
- A routine with a token limit of 5000. The stand-in provider reports 4100 tokens after the first
  call: the run details show "80% of the token limit is used." It reports 5200 after the next
  call: the run stops and fails with "Token limit reached (5000)." Three such runs in a row pause
  the routine.
- An agent on a stand-in runtime that reports no usage: the token limit field is off in the
  routine form, with the muted line "<program> does not report tokens."
