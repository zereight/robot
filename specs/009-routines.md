# 009 Routines

## Purpose

Agents do repeat work on a schedule without the user starting it.

## Concepts

- **Routine**: agent, prompt, schedule, on/off, and the place where results post (the agent's chat
  or a channel).
- **Schedule**: once at a time; every N minutes or hours; daily at times; weekly on days at a time;
  or a cron expression for advanced users. All in the user's time zone.

## Flows

1. Create: from the agent profile or the routines list, the user sets prompt, schedule and place.
   The app shows the next three run times in words.
2. Calendar: a week and a month view show past runs (done or failed) and future runs.
3. Run now: starts a run at once, outside the schedule.
4. Pause and resume: a paused routine keeps its settings and does not run.

## Limits and safeguards

- A server holds at most 50 routines. A paused routine counts. The form for the 51st routine
  refuses to save, with the reason in words. Duplicating a routine follows the same limit.
- The smallest step of a schedule is one minute. A schedule that has less than 15 minutes between
  two runs shows a note under the next run times: "This runs about N times a day." N is the
  count for a full day. The note does not stop the save.
- **Repeated failure**: a routine that fails 3 runs in a row pauses itself.
  - A run that ends as Done sets the count of failed runs to 0. A run that ends as Failed or
    Blocked adds 1. Cancelled, Skipped and Missed runs do not change the count.
  - A run started with Run now counts in the same way as a scheduled run.
  - The routine shows "Paused after 3 failed runs" in the routines list and in its detail, with
    the reason of the last failure. The calendar keeps all past runs.
  - The user gets one notification of the kind "routine failed" (see 015). Its text says that the
    routine is paused.
  - Resume, and any edit of the prompt, the schedule, the agent or the place, sets the count to 0.
    A restart of the app keeps the count.

## Rules

- Each run is a task (see 005) with the routine as its source. While a run works, the working
  line of the agent names the routine (see 003), because a run has no step text of its own.
- A run whose tasks are all cancelled by the user shows as "Cancelled" in the calendar and the
  run list, not as done.
- A run whose task ends as Blocked (see 005) shows as "Blocked" in the calendar and the run list,
  with the reason of the block. A blocked run counts as a failed run for the pause above.
- Missed runs while the computer was off or asleep: on wake, the app runs at most one missed run
  per routine, and only if it is less than 12 hours late. The others show as "Missed".
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
