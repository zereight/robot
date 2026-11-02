# 020 Today

## Purpose

The user opens one page and sees what waits for them, what went wrong, what ran today, and what
runs next.

## Concepts

- **Today page**: a page of the window. The page button "Today" opens it (see 001). It shows the
  data of this computer.
- **Group**: a block of rows on the page. There are four groups.
- **Row**: one thing in a group. It has an icon for its kind, the face of the agent if there is
  one, one line of text, the place or source, and the time.
- **Day**: from midnight to midnight in the time zone of this computer.

## Groups

The groups show in this order. A group with no rows is hidden. The exception is "Needs you": when
it is empty, it shows the muted line "Nothing waits for you."

1. **Needs you**: the same list as "Needs you" on the phone (see 011): approval cards, question
   cards, and failed channel parts. It also lists the approvals and questions of tasks that run on
   the computer that this one syncs with (019), with the name of that computer and without
   "Always allow" (015). The oldest row is first. A click opens the place at the card.
2. **Went wrong**: newest first.
   - A task that failed today (chat, channel part, routine run, workflow run). A click opens the
     task on the Tasks page. The row leaves the group when the user retries the task (005).
   - A routine that paused itself after failed runs (009). The row stays while the routine is
     paused, also when it paused on an earlier day. A click opens the routine.
   - A model account that needs the user: the sign-in is lost, or the plan limit is reached (006).
     The row stays while the problem holds. For a limit, the row gives the time it resets, if
     known. A click opens Settings at that account.
3. **Done today**: one row for each routine and each workflow that had at least one run end as
   done today. The row gives the count of runs and the time of the last one. Newest first. Tasks
   of chats are not listed.
4. **Next 24 hours**: the runs of routines and the scheduled runs of workflows that are due
   within the next 24 hours, soonest first. A paused routine does not show.

## Rules

- A group shows at most 20 rows. If more exist, the last line says how many more there are.
- A row line is the same text as the card or the task shows, and at most 90 characters. It never
  shows the content of a file.
- The page changes within 1 second after something changes. The user does not reload it. The
  groups "Went wrong" and "Done today" start again at midnight, and the page follows a change of
  the time zone.
- Opening the page starts no turn of an agent and sends nothing off the computer.
- A source that the app cannot read does not show as empty. The group shows the muted line "Could
  not read this group." in its place.
- The page makes no notification. The notifications of 015 are the same as before.
- The badge of the page button counts the rows of "Needs you" (see 001).
- A linked server (012) has no Today page in this version. The page shows the muted line "Open this
  on <server name>." The phone keeps its own list "Needs you" (011).
- Text on the page comes from the translation catalogue, in English and Korean (013).

## Out of scope

- Mail and calendar items of outside services.
- Deadlines of tasks. A task has none in this version.
- Answering an approval inside the row. The user answers it on its card.

## Acceptance

- A new app with no work: the page shows only "Needs you" with "Nothing waits for you."
- An agent asks for an approval: within 1 second the row shows in "Needs you", and the badge on
  the page button shows 1. Allow the step on the card: the row and the badge leave.
- A task fails today: a row shows in "Went wrong". Retry the task: the old row leaves.
- A routine fails 3 runs in a row: it pauses, and a row shows in "Went wrong". Resume it: the row
  leaves.
- A stand-in model account reports that its plan limit is reached: a row with the reset time
  shows. The account works again: the row leaves.
- A routine runs twice today and ends as done both times: "Done today" has one row with the count
  2.
- A routine is due in 3 hours: "Next 24 hours" shows it. Pause it: the row leaves.
- Two computers sync and a task on the other computer waits for an approval: "Needs you" shows
  the row with the name of the other computer and no "Always allow".
- Open a linked server on the rail and press "Today": the page shows the line "Open this on
  <server name>."
- Make the read of one group fail: the group shows the line "Could not read this group." and not
  an empty list.
- Change the language to Korean: the page has no English text except names.
