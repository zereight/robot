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

## Rules

- Each run is a task (see 005) with the routine as its source.
- Missed runs while the computer was off or asleep: on wake, the app runs at most one missed run
  per routine, and only if it is less than 12 hours late. The others show as "Missed".
- A run does not start while the previous run of the same routine is still going; it is marked
  "Skipped".

## Acceptance

- A routine every 2 minutes runs twice in 5 minutes and posts both results.
- Sleep through 3 runs, wake: one run starts and two show "Missed".
