# 038 Events

## Purpose

Work arrives from outside a chat: a schedule, a watch, a web hook, another program, a message from
Teams. The user sees each piece that arrived, the place that took it, the result, and the reason
when the place did nothing.

## Concepts

- **Event**: one arrival at a place that the user made. It has:
  - a **source**: "Schedule" and "Watch" (009), "Web hook" (010), "Outside program" (023), "Teams"
    (028), and "Test" (see "Check where this goes");
  - a **type**: a short name that the source gives, for example "issue opened" or "change in the
    folder";
  - a **subject**: the thing that the event is about, when the source names one, for example the
    path of a file or the number of an issue;
  - an **id**: the name that the source gives to one call, when it gives one, so that the app
    finds a call that comes again;
  - a **summary line** of at most 200 characters, the **detail**, and a **link**;
  - the time that it arrived, and a **result**.
- **Place**: what took the event: a routine (009), a workflow (010), or the direct chat (003) of
  the agent that a message of an outside program or of Teams goes to.
- **Result**: what the app did with the event. The result is one of these.
  - **Routed**: a task started, or a run of a routine (009) or of a workflow (010) started. The
    result names the place and the task.
  - **Would go**: a test event. The place is ready. Nothing started.
  - **Duplicate**: a call with an id that the app already has. Nothing starts.
  - **Waits**: a message of an outside program whose subject has work that goes now. It starts
    when that work ends.
  - **Skipped**: the busy rule of a workflow (010) or a run of the same routine (009) still goes,
    or 3 messages of the same subject wait. Nothing starts.
  - **No rule**: the call reached the place, and the place does not take this kind of event. For a
    web hook this is a call that fails the filter of the preset, for example a kind that the user
    did not tick (010). The call gets 202 and starts nothing.
  - **Failed**: the work started and failed, or a check of a watch failed.
- The page shows the arrivals at a place that the user made. A call to an address that no workflow
  holds makes no event, because the app does not know the address (010, "Order of checks"). So
  every event has a place to name. A routine that is paused and a workflow that is off make no
  event, and the calendar of 009 and the run list of 010 show that state.
- **Events tab**: the tab "Events" of the Tasks page (005). It lists the events of this computer,
  newest first.

## The page

- The tasks page button opens the tab "Tasks" (005). The Tasks page holds two tabs at the top of
  its header line: "Tasks" and "Events". Nothing in the tab "Tasks" changes except that it shares
  its header line with the second tab. A click on "Events" shows the list of this spec. The choice
  of tab stays after a restart.
- A header line under the tabs: the title "Events", a search field, and a filter "Result" with
  "All" at the start.
- The rows are a table, newest first, as the tab "Tasks" has (005). The columns are: source, type
  and subject, the summary line, the time, and the result.
- A row shows the source with an icon and a word, the type, the subject when there is one, the
  summary line, the time, and the result with an icon and a word. Colour alone is not enough.
- A result of "Routed" shows the name of the place in its row.
- A result of "No rule", "Skipped", "Duplicate", "Would go" or "Failed" shows a muted line with its
  reason, under the row's text.
- A row shows at most one line of the summary line, cut at 200 characters with "…". It never shows
  the detail.
- A click on a row opens the detail of the event, for every result.
- The filter "Result" holds each result. A filter with no row shows the muted line "No event for
  this result."
- The search field looks in the summary line, the type, and the subject. It never searches the
  detail.
- The page shows 50 rows, then "Show more", which shows 50 more.
- An empty page shows the muted line "No event yet."
- The page changes within 1 second after an event arrives. The user does not reload it.
- Opening the page starts no turn and sends nothing off the computer.

## Detail of an event

- The detail shows the source, the type, the subject, the id, the time, the summary line, the
  detail, the link, and the result with its reason.
- The summary line and the detail are text from outside and the detail shows them as text, never as
  a step. For a watch, it shows the change text of 009, "A run of a watch gets the prompt and a
  short text of the change". For a web hook, it shows the first 4000 characters of the call (010).
- **Why**: one line that says how the app chose the place, in this order.
  1. The name of the routine or of the workflow that took it, as the user reads it in its form.
  2. The name of the web hook or of the watch, and its place.
  3. The reason that the place took nothing, for example "This call is not a kind that the
     workflow takes."
- **What the agent got**: the text that the turn got for the event, cut at 4000 characters. It is
  the change text for a watch (009), or the text of the preset for a web hook (010).
- A button "Open the place" when the result is "Routed".

## Check where this goes

- The form of a web hook trigger (010), of a watch (009) and of a schedule (009) has the button
  "Check where this goes".
- A click makes one event with the source "Test" and the result "Would go". It starts no run and no
  task, writes no message, and changes no field of a routine or of a workflow.
- The fields of the test event come from the form: for a web hook, the type of the event that the
  preset reads and the subject; for a watch, the path, the command or the tool, and a change text
  of two short lines that stand for a change; for a schedule, the planned time.
- The result names the place, and the first step of the workflow or the prompt of the routine, in
  words. It also names the agent.
- A form whose workflow step has no agent says so: "This step has no agent yet." (010). A form of a
  routine that is paused says "The routine is paused." A form of a workflow that is off says "The
  workflow is off."
- The test event stays on the page with the source "Test". It counts in the limit of 2000 events.
  It shows for 1 day, then leaves.

## One at a time for one subject

- A message of an outside program (023) names a subject. Two messages with the same subject never
  go at the same time. The second one **Waits** and shows the line "Waits for <subject>.". It
  starts when the work of the first message ends.
- A message with no subject never waits for another message.
- A message that waits behind 3 messages of its subject starts nothing and shows as **Skipped**,
  with the reason "3 messages of <subject> wait." It never starts later.
- When the app starts again, a message that waited shows as **Failed** with the reason of 005,
  "The app stopped." No task exists for it, so the program sends the message again when it wants
  the work done.
- A subject holds 1 to 100 characters: letters, digits, and the marks `#`, `.`, `_`, `:`, `/`, `@`
  and `-`. A message of an outside program with another subject is refused, and the reason names
  the subject.
- A schedule, a watch and a web hook keep their own rules: 009, "When a check is due while the
  last run of the same routine still goes, the check waits until the run ends", and 010, "Busy".
  This spec adds no second rule to them. The row of such an event shows the result that those rules
  give.

## Duplicates

- A web hook call carries an id from the sender, in the header of the preset (010). A message of an
  outside program carries an id (023). A message of Teams has no id. An event with no id never
  counts as a duplicate.
- The app keeps the id of each event for 7 days. A call with an id that it has starts nothing, and
  shows as **Duplicate** with the line "Same call as <time>." The app answers it as a call that
  starts nothing (010).
- A duplicate message of an outside program gives the task of the first call of that id to the
  program. It starts no second task.
- A call with an id that the sender used more than 7 days ago makes a new event.

## Limits and retention

- A profile keeps 2000 events. The oldest event leaves when a new one arrives at the limit.
- An event holds at most 20000 characters of detail. A longer detail is cut, and the detail ends
  with "…".
- The app hides a text that looks like a secret before it cuts the detail, so a cut never shows the
  start of a secret (014).
- An event of a source that the app cannot read keeps its row and shows the line "Could not read
  this event." in place of the detail.
- The page reads 200 rows at most for one look, in groups of 50.

## Rules

- The page adds one row for each arrival and the result of that arrival. It adds two changes and no
  others: the id of a call (see "Duplicates"), and the subject that makes the messages of one
  outside program wait in turn (see "One at a time for one subject"). Every other rule of 009, 010,
  023 and 028 stays as it is. It adds no trigger and no rule object: a routine (009) and a workflow
  (010) are the rules.
- A web hook event, an outside program event and a Teams event hold outside content for a turn that
  the user did not start (007). The page shows the mark "Holds outside content" on them.
- The page never shows the secret of a web hook, the key of an outside program, or the text of a
  saved secret (020). Text that looks like a secret is hidden (014).
- The page shows the work of this computer only. Work of a linked server shows on that computer
  (012). The phone has no Events tab in this version (011).
- Events do not sync (019). An export holds no event (014). A second profile has its own events.
- The app writes no log for this page (014). The rows are the record.
- Nothing on this page starts a turn of an agent. "Check where this goes" starts no run.
- After a restart, the rows are the same. An event that waited is Failed, as "One at a time for one
  subject" says.

## Surfaces

- Ways in: the tab "Events" of the Tasks page (001, 005). The button "Check where this goes" sits on
  the form of a trigger of 009 and of 010.
- Devices: the computer only. A linked device and the phone do not show the tab (012, 011), as for
  the action log (007). A second profile has its own events.
- Runtimes: the page shows events for every runtime (006). The mark "Holds outside content" and the
  text that the turn gets do not change with the runtime.
- Seeing the state: the row with its result, and the detail with "Why" and "What the agent got".
- Ways out: the page keeps no state that the user turns off. An event leaves with the limit of
  2000, with the 7 days of its id, or with the 1 day of a test event.

## Out of scope

- A rule object of its own. A routine (009) and a workflow (010) are the rules.
- A new rule made from an event. The user makes it in the form of a routine or of a workflow.
- An event for a routine that is paused or a workflow that is off. The calendar of 009 and the run
  list of 010 show that state.
- An event that names no place, for example a call to an address that no workflow holds.
- An address on the network for this app.
- A change of the agent or the place of an event after it started.
- A card or a notification of an event. The notification of the task that it starts is the notice
  of 015.
- A retry of an event on this page. The user uses Retry on the Tasks page (005) or Run now on the
  routine (009).
- Search of event text by an agent, with the tools of 007.
- An event from a chat service other than Teams (028).

## Acceptance

- A new app with no work: the page shows "No event yet."
- A routine on a schedule runs: one row shows the source "Schedule", the type, the summary line of
  the run, and the result "Routed" with the name of the chat. The detail has "Open the place", and
  that button opens the place at the task.
- A watch on a folder, and a new file: one row shows the source "Watch", the path among its fields,
  and the result "Routed". A check with no change makes no row.
- A watch on a path that does not exist fails a check: one row shows the result "Failed" with the
  reason of the check.
- A routine on a schedule pauses after 3 failed runs. The next planned time passes: no row shows.
- A web hook of a workflow that is off gets a call: no row shows, and the sender gets 404 (010).
- A web hook call that passes the proof and fails the filter of the preset: one row shows the
  result "No rule" with "This call is not a kind that the workflow takes.", the sender gets 202,
  and no run starts.
- The same web hook call with the same id arrives twice: the second row shows "Duplicate" with
  "Same call as <time>.", no second run starts, and the sender gets 202.
- A message of an outside program with an id that it used before: no second task starts, the call
  gets the task of the first call, and the page shows "Duplicate".
- Two messages of an outside program with the same subject, while the task of the first goes: the
  second row shows "Waits for <subject>.". The first task ends: the second message starts its task
  and its row shows "Routed".
- Four messages of an outside program with the same subject, while a task goes: the fourth row
  shows "Skipped" with "3 messages of <subject> wait.", and it never starts.
- A web hook call that comes while a run of the same workflow goes: its row shows "Skipped", and
  the workflow log holds one line (010, "Busy").
- The "Check where this goes" button on a web hook form shows "Would go" with the place, the first
  step and the agent, and no run starts. The run list of the workflow holds no run of that time.
- The same button on the form of a routine that is paused shows the line "The routine is paused."
  and no task starts.
- The same button on the form of a workflow whose agent step has no agent shows "This step has no
  agent yet."
- The event of a web hook shows the mark "Holds outside content", and "What the agent got" holds
  the text of the preset, cut at 4000 characters.
- The detail of an event with a long body ends with "…" at 20000 characters.
- A test event leaves the page after 1 day, and the page then shows the earlier rows.
- The filter "Result" with "No rule" shows only those rows.
- Restart the app with a message of an outside program that waited: its row shows "Failed" with
  "The app stopped.", and the Tasks page has no task for it.
- Export the data: the archive holds no event. A second profile shows no event of the first.
- A stand-in linked server and a stand-in phone: neither shows the tab.
