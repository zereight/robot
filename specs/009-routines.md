# 009 Routines

## Purpose

Agents do repeat work on a schedule without the user starting it.

## Concepts

- **Routine**: agent, prompt, one trigger, on/off, and a model and effort. Results post in the
  chat of the agent. The model and effort are "Same as the agent" by default. The user can pick
  another model and effort for the routine only, for example a cheaper model for a simple check. A
  routine can also have a token limit for each run (see "Limits and safeguards").
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

1. Create: from the agent profile or the routines list, the user sets prompt, trigger, and if
   wanted a model and effort. For a schedule, the app shows the next three run times in words.
2. Calendar: a week and a month view show past runs (done or failed) and future runs.
3. Run now: starts a run at once, outside the schedule.
4. Pause and resume: a paused routine keeps its settings and does not run.
5. Delete: the routine goes with its runs. The button is a danger button and asks first (000,
   "Danger buttons").
6. Check where this goes: the form of a trigger has the button "Check where this goes". It makes
   one test event that starts nothing, and the tab "Events" (038) shows its result. See 038,
   "Check where this goes".
7. Check: the user presses "Check" in the detail of a routine. The app shows "Passed", or the
   problem and the routines on its path (see "Check").

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
  change posts one muted line in the chat of the agent. No task is made for it.
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

## Check

The check of a routine tries every way that the routines can start runs in the next 7 days, by the
rules of this spec and of the queue (005), and reports a way that goes wrong. It works as the check
of a workflow does (010, "Check"): it needs no agent, no model, no Java and no other program,
starts no task, and sends nothing out.

In this section, "check" means this check. The check of a watch (see "Watch") is a different thing.

### What the check reads

- The routine that the user checks, also when it is paused, and each other routine of the profile
  that is not paused.
- The trigger of each routine: the times of a schedule in the next 7 days from the time of the
  check, in the user's time zone, or the path or the kind of a watch.
- The agent of each routine, its workspace folder (007) and its permission level.
- The settings "Agents working at once" (005, 013) and the silent limit (005, 013).

It does not read the prompt, and it does not run a watch.

### How the check sees a run

- A schedule starts a run at each of its times. A watch can start a run at each of its checks.
  The time of a check of a watch is not fixed, so the check counts a watch as due at any minute.
- A run takes an unknown time. It can end at any time, or go on until a limit of 005 stops it.
- The runs of one agent wait for each other in the queue of the agent (005). A run of a routine
  that is still going, or still queued, when the next run of the same routine is due, makes that
  run Skipped (see "Rules").
- A run whose agent can change files (its permission level is not "Read only") can change any file
  in the workspace folder of its agent. A change of a watched file or folder can start the watch
  routine.

### What the check finds

| Item | A problem is |
| --- | --- |
| Runs do not overlap | Two routines of one agent that can be due in the same minute. One run then waits for the other, and it can be Skipped. A schedule and a watch of one agent are always such a pair. |
| Every run ends | The silent limit is "Never". Then a run that shows no sign of life never ends, and each later run of the routine is Skipped. A run that waits for the user is not a problem: the user answers it or stops it. |
| No loop of routines | A watch routine that watches a file or a folder that a run of the same routine can change. Or two or more watch routines in a ring, in which a run of each one can change what the next one watches. |
| Runs at once stay in the limit | A minute in which more routines of different agents can be due than "Agents working at once" allows. The other runs then wait for a free slot, and they can be Skipped. |

### States and result

- The detail of a routine has the control "Check". It shows the states of a workflow check: "Not
  checked", "Checking…", "Passed", "Problem found" and "Could not check" (010, "Check").
- **Passed**: the line "No problem found in the triggers of the routines.", the four items with
  "Passed", and the text of "What the check cannot prove".
- **Problem found**: one problem: the first in the order of the table above, with the shortest
  path to it. The detail shows the message and the path. The path is a numbered list. Each line
  has a time and one routine, with what happens. The routines list marks each routine of the path
  with a mark, and the routine of the problem with the danger colour and an icon. The marks go
  away at the next check, or when the result is "Not checked".
- The result shows the time of the check, because the next 7 days move on.
- The app checks the routine by itself after the user saves its form, and after Resume. A result
  never stops a save, a resume or a run.
- A change of any routine, of the workspace folder or the permission level of the agent of a
  routine, of "Agents working at once" or of the silent limit sets the result of each routine to
  "Not checked".
- The texts follow the language of the interface.

Messages (`<A>` and `<B>` are names of routines, `<agent>` is the name of an agent, `<time>` is a
day and a time, or "any check" for a watch):

| Problem | English | Korean |
| --- | --- | --- |
| Overlap | "`<A>`" and "`<B>`" can start runs of `<agent>` at the same time (`<time>`). One run waits for the other. | "`<A>`"와(과) "`<B>`"가 같은 시간(`<time>`)에 `<agent>`의 실행을 시작할 수 있어요. 한 실행은 다른 실행을 기다려요. |
| Never ends | The silent limit is "Never". A run of "`<A>`" that shows no sign of life never ends, and each later run is Skipped. | 응답 없는 작업을 멈추는 시간이 "안 함"이에요. 응답이 없는 "`<A>`" 실행은 끝나지 않고, 이후 실행은 모두 건너뛰어요. |
| Loop | "`<A>`" can change `<path>`, which "`<B>`" watches. The routines `<list>` can start each other with no end. | "`<A>`"이(가) "`<B>`"가 지켜보는 `<path>`을(를) 바꿀 수 있어요. 루틴 `<list>`이(가) 끝없이 서로를 시작할 수 있어요. |
| Too many at once | At `<time>`, `<N>` routines can start runs, and only `<M>` agents work at once. `<N − M>` runs wait for a free slot. | `<time>`에 루틴 `<N>`개가 실행을 시작할 수 있지만, 동시에 일하는 에이전트는 `<M>`개예요. 실행 `<N − M>`개가 빈자리를 기다려요. |

Lines of the path:

| What happens | English | Korean |
| --- | --- | --- |
| A run starts | `<time>`: "`<A>`" starts a run of `<agent>`. | `<time>`: "`<A>`"이(가) `<agent>` 실행 시작 |
| A run waits | `<time>`: a run of "`<A>`" waits for `<agent>`. | `<time>`: "`<A>`" 실행이 `<agent>`을(를) 기다림 |
| A run waits for a slot | `<time>`: a run of "`<A>`" waits for a free slot. | `<time>`: "`<A>`" 실행이 빈자리를 기다림 |
| A run is Skipped | `<time>`: a run of "`<A>`" is Skipped. | `<time>`: "`<A>`" 실행 건너뜀 |
| A run changes a watched path | "`<A>`" changes `<path>`. | "`<A>`"이(가) `<path>` 변경 |
| A watch starts a run | "`<B>`" sees the change and starts a run. | "`<B>`"이(가) 변경을 보고 실행 시작 |

### Limits of the check

- The check stops when it has looked at 1,000,000 states, or after 60 seconds. The state is then
  "Could not check".
- Message, English: "These routines have too many ways to run. The check stops at 1,000,000
  states or after 60 seconds."
- Message, Korean: "루틴의 실행 경로가 너무 많아요. 검사는 상태 1,000,000개 또는 60초에서
  멈춰요."

### What the check cannot prove

The check reads the triggers and the settings. It does not read what an agent does in a run. So it
cannot say how long a run takes, if a run changes a file, if a command or a tool of a watch gives
a new result, or if an agent changes files outside its workspace folder. A watch on a command or
a tool is not part of a loop for the check.

No text of the check says that a routine is proven, verified, correct or safe. A pass also shows
this line:

- English: "The check reads the triggers and the settings. It does not read what an agent does in
  a run."
- Korean: "검사는 트리거와 설정만 읽어요. 에이전트가 실행 중에 하는 일은 읽지 않아요."

### Surfaces

- **Ways in**: the control "Check" in the detail of a routine, and the check after a save and
  after Resume. Not in this version: the search field, a key, a command of the message box, a
  manage tool (037).
- **Devices**: a linked computer has no routines page (012), and the phone has none (011). So
  neither has the check. A second profile (022) checks its own routines.
- **Runtimes**: nothing changes. The check reads no agent turn.
- **Ways out**: the check changes nothing, so it needs no undo. The marks go at the next check.
- **Seeing the state**: the control in the detail of a routine, and the marks in the routines
  list. The result stays after a restart.
- **Data**: the result stays on this computer. It does not sync (019), and an agent file (002) does
  not hold it.
- **Words**: "Check" is in the glossary.

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
  - Resume, and any edit of the prompt, the trigger or the agent, sets the count to 0.
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
- Two routines of the agent Ada, one daily at 09:00 and one weekly on Monday at 09:00: "Check"
  shows "Problem found" with the message "Overlap" and the time Monday 09:00. Both routines have a
  mark in the routines list. No agent and no provider is used, and no task starts.
- Move one routine to 10:00: "Check" shows "Passed".
- A watch routine of Ada on a folder inside the workspace folder of Ada, with Ada at "Ask for risky steps":
  "Check" finds "Loop". Set Ada to "Read only": the loop is gone.
- Set the silent limit to "Never": "Check" finds "Never ends". Set it back: the problem is gone.
- Set "Agents working at once" to 1, with two routines of two agents at 09:00: "Check" finds "Too
  many at once" at 09:00.
- Save the form of a routine: the app checks it by itself, and the save works also when it finds a
  problem.
- Change "Agents working at once" after a pass: the result is "Not checked".
- Set the language to Korean: the state, the message and the lines of the path are Korean.
- Search all texts of the check, in English and Korean, for "proven", "verified", "correct" and
  "safe", and for "증명", "검증됨", "정확", "안전": none appear.
