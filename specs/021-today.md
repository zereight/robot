# 021 Today

## Purpose

The user opens one page and sees what waits for them, what went wrong, what ran today, and what
runs next.

## Concepts

- **Today page**: a page of the window. The page button "Today" opens it (see 001). It shows the
  work of this computer.
- **Group**: a block of rows on the page. There are four groups.
- **Row**: one thing in a group. It has an icon for its kind, the face of the agent if there is
  one, one line of text, the place or source, and the time.
- **Day**: from midnight to midnight in the time zone of this computer.

## Groups

The groups show in this order. A group with no rows is hidden. The exception is "Needs you": when
it is empty, it shows the muted line "Nothing waits for you."

1. **Needs you**: the oldest row is first. A click opens the place at the card. It lists:
   - the items of "Needs you" on the phone (see 011): approval cards, question cards, and failed
     channel parts. A question of a member that is with the lead (004) is not listed until it
     passes to the user;
   - parts of a channel job that wait for the review of the user (004, 005);
   - the approvals and questions of tasks that run on the computer that this one syncs with (019).
     These rows show the name of that computer and have no "Always allow" (015).
2. **Went wrong**: newest first. It lists:
   - A task that failed today, or ended as Blocked (005). A click opens the task on the Tasks
     page. The row leaves the
     group when the user retries the task (005). A failed part of a channel job and a failed run
     of a routine are not listed here as tasks.
   - A routine with a failed run today, or a routine that is paused after failed runs (009). The
     routine has one row. The text names the last failure, and says "Paused" when the routine is
     paused. A paused routine keeps its row until the user resumes it, also from an earlier day.
     A click opens the routine.
   - The Teams link, when it is signed out or paused (028). A click opens Settings, Teams. The row
     stays until the state changes.
   - A model account with a problem (see "Model account problem"). A click opens Settings at
     that account.
3. **Done today**: one row for each routine and each workflow that had at least one run end as
   done today. The row gives the count of runs and the time of the last one. Newest first. Tasks
   of chats are not listed.
4. **Next 24 hours**: the runs of routines and the scheduled runs of workflows that are due
   within the next 24 hours, soonest first. A routine or workflow that is paused or off does not
   show. The follow-ups of agents that are due in that time show too (005, "Follow-up"), with the
   agent and the reason.

### Model account problem

An account has a problem when its last turn failed because the sign-in is not valid, or because
the plan limit is reached (006). The row stays until a turn of that account succeeds. For a
limit, it also ends when the reset time has passed. When the user disconnects an account, it shows
no row.

## Filter by organization

- The header of the page has one choice, "Organization", with "All" first and then the
  organizations of this computer in the order of their names, ignoring case.
- The filter keeps the rows whose agent is a member of that organization. A row with no agent leaves
  the page under a filter: a model account with a problem, the Teams link, and a routine or a
  workflow that names no agent. A row whose agent is in the organization stays, also when its task
  ran in a channel.
- The groups do not change: the same four groups, in the same order, with the same rows otherwise.
  An empty group hides as it does without a filter, and "Needs you" shows the muted line.
- The badge of the page button and the count of "Needs you" do not change with the filter: they
  count what waits for the user on this computer, not what the filter shows (see "Rules").
- The choice belongs to this device, as the view of the place list does (001). A restart keeps it.
  A linked server has no page, so it has no filter.
- With a filter that keeps no row at all, the page shows one muted line "Nothing in <organization>."

## Rules

- "Went wrong", "Done today" and "Next 24 hours" list only work that ran, or will run, on this
  computer. Work of the other computer of a sync pair shows on that computer.
- A group shows 20 rows. If more exist, the last row is "Show more", which shows 20 more rows.
- A row line is the text that the card or the task shows. A row without a card has a text that
  names the item: the routine and "paused after 3 failed runs", the account and "sign-in lost" or
  "plan limit reached, resets at <time>", or the routine and its due time. A line has at most 90
  characters. A longer line ends with "…". It never shows the content of a file.
- The page changes within 1 second after something changes. The user does not reload it. The
  groups "Went wrong" and "Done today" start again at midnight, and the page follows a change of
  the time zone.
- Opening the page starts no turn of an agent and sends nothing off the computer.
- A source that the app cannot read does not show as empty. The group shows the muted line "Could
  not read this group." in its place.
- The page makes no notification. The notifications of 015 are the same as before.
- The badge of the page button counts all items of "Needs you" on this computer, not only the rows
  that show (see 001).
- A linked server (012) has no Today page in this version. When a linked server is on the screen,
  the page shows the muted line "Open this on <server name>.", and the badge hides. The phone
  keeps its own list "Needs you" (011).
- Text on the page comes from the translation catalogue, in English and Korean (013).

## Out of scope

- Mail and calendar items of outside services.
- Deadlines of tasks. A task has none in this version.
- Answering an approval inside the row. The user answers it on its card.

## Acceptance

- A new app with no work: the page shows only "Needs you" with "Nothing waits for you."
- An agent asks for an approval: within 1 second the row shows in "Needs you", and the badge on
  the page button shows 1. Allow the step on the card: the row and the badge leave.
- A part of a channel job waits for review: a row shows in "Needs you". Accept the part: the row
  leaves.
- 21 approvals wait: "Needs you" shows 20 rows and "Show more", and the badge shows 21. "Show
  more" shows the 21st row.
- A task of a chat fails today: a row shows in "Went wrong". Retry the task: the old row leaves.
- A routine fails 3 runs in a row: it pauses, and "Went wrong" has one row for the routine, with
  the word "Paused". Resume it: the row leaves.
- A stand-in model account reports that its plan limit is reached: a row with the reset time
  shows. A turn of that account then succeeds: the row leaves.
- A routine runs twice today and ends as done both times: "Done today" has one row with the count
  2.
- A routine is due in 3 hours: "Next 24 hours" shows it. Pause it: the row leaves.
- Two computers sync and a task on the other computer waits for an approval: "Needs you" shows
  the row with the name of the other computer and no "Always allow". A routine that runs on the
  other computer does not show in "Next 24 hours".
- Open a linked server on the rail and press "Today": the page shows the line "Open this on
  <server name>.", and the badge is hidden.
- Change the day (the clock passes midnight): "Done today" and the day rows of "Went wrong" are
  empty, and the paused routine keeps its row.
- Change the language to Korean: the page has no English text except names.
