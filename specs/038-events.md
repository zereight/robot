# 038 Events

## Purpose

Work arrives from outside the chat: a schedule, another program, a message from Teams. The user
sees each piece that arrived, the workflow that took it, the result, and the reason when the
workflow did nothing.

## Concepts

- **Event**: one arrival at a workflow that the user made. It has:
  - a **source**: "Schedule" (a trigger of a workflow, 010), "Outside program" (023), "Teams"
    (028), and "Test" (see "Check where this goes");
  - a **type**: a short name that the source gives, for example "message" or "planned time";
  - a **subject**: the thing that the event is about, when the source names one, for example the
    number of an issue;
  - an **id**: the name that the source gives to one call, when it gives one, so that the app
    finds a call that comes again;
  - a **summary line** of at most 200 characters, the **detail**, and a **link**;
  - the time that it arrived, and a **result**.
- **Place**: what took the event: a workflow (010), or the chat of a workflow (003) that a message
  of an outside program or of Teams goes to. The chat of a workflow is its main thread.
- **Result**: what the app did with the event. The result is one of these.
  - **Routed**: a run of the workflow started (a schedule), or a turn of the chat started (a
    message of an outside program or from Teams). The result names the place and the run or the
    turn.
  - **Would go**: a test event. The place is ready. Nothing started.
  - **Duplicate**: a call with an id that the app already has. Nothing starts.
  - **Waits**: a message of an outside program whose subject has work that goes now. It starts
    when that work ends.
  - **Skipped**: a rule stopped the start, and nothing starts. The rule is the one of "One at a
    time for one subject" (3 messages of the same subject wait), or a rule of the trigger (010).
    The reason names the rule.
  - **Failed**: the work started and failed.
- The page shows the arrivals at a place that the user made. So every event has a place to name. A
  workflow that is off makes no event from its schedule, and the run list of 010 shows that state.
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
- A result of "Skipped", "Duplicate", "Would go" or "Failed" shows a muted line with its reason,
  under the row's text.
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
  a step. For a message of an outside program or from Teams, the detail shows the text of the
  message.
- **Why**: one line that says how the app chose the place, in this order.
  1. The name of the workflow that took it, and the trigger or the entry that sent it, as the user
     reads it in its form.
  2. The reason that the place took nothing, for example "3 messages of <subject> wait."
- **What the workflow got**: the text that the run or the turn got for the event, cut at 4000
  characters. It is the text of the message for a message, and the text that started the run
  (`{{trigger}}`, 010) for a schedule, when there is one.
- A button "Open the place" when the result is "Routed". For a run, it opens the run view of the
  workflow, with its chat beside it (010). For a message, it opens the message in the chat. There
  the user asks the responsible document how far the run has gone, why it stopped or waits, and
  what the results are, and gives feedback while the run works (003).

## Check where this goes

- The form of a schedule trigger (010) has the button "Check where this goes".
- A click makes one event with the source "Test" and the result "Would go". It starts no run,
  writes no message, and changes no field of a workflow.
- The fields of the test event come from the form: the planned time.
- The result names the place, and the nodes that start the run, with their numbers and names, in
  words.
- A form of a workflow that is off says "The workflow is off."
- The test event stays on the page with the source "Test". It counts in the limit of 2000 events.
  It shows for 1 day, then leaves.

## One at a time for one subject

- A message of an outside program (023) names a subject. Two messages with the same subject never
  go at the same time. The second one **Waits** and shows the line "Waits for <subject>.". It
  starts when the work of the first message ends. The work of a message is the turn of the chat
  that it starts.
- A message with no subject never waits for another message.
- A message that waits behind 3 messages of its subject starts nothing and shows as **Skipped**,
  with the reason "3 messages of <subject> wait." It never starts later.
- When the app starts again, a message that waited shows as **Failed** with the reason of 005,
  "The app stopped." No turn exists for it, so the program sends the message again when it wants
  the work done.
- A subject holds 1 to 100 characters: letters, digits, and the marks `#`, `.`, `_`, `:`, `/`, `@`
  and `-`. A message of an outside program with another subject is refused, and the reason names
  the subject.
- A schedule keeps its own rules (010, "Trigger"). This spec adds no second rule to it. The row of
  such an event shows the result that those rules give.

## Duplicates

- A message of an outside program carries an id (023). A message of Teams has no id. An event
  with no id never counts as a duplicate.
- The app keeps the id of each event for 7 days. A call with an id that it has starts nothing, and
  shows as **Duplicate** with the line "Same call as <time>."
- A duplicate message of an outside program gives the program the answer of the first call of that
  id (023). It starts no second turn.
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
  outside program wait in turn (see "One at a time for one subject"). Every other rule of 010, 023
  and 028 stays as it is. It adds no trigger and no rule object: a workflow (010) is the rule.
- An outside program event and a Teams event hold outside content for a turn that the user did not
  start (007). The page shows the mark "Holds outside content" on them.
- The page never shows the key of an outside program, or the text of a saved secret (020). Text
  that looks like a secret is hidden (014).
- The page shows the work of this computer only. Work of a linked server shows on that computer
  (012). The phone has no Events tab in this version (011).
- Events do not sync (019). An export holds no event (014). A second profile has its own events.
- The app writes no log for this page (014). The rows are the record.
- Nothing on this page starts a turn of the responsible document or a run. "Check where this goes"
  starts no run.
- After a restart, the rows are the same. An event that waited is Failed, as "One at a time for one
  subject" says.
- The page tells about arrivals only. A run that ends, a node that fails, an approval that waits
  and a proposal that waits are in the Tasks tab (005) and in the notices (015), not here (see the
  questions for 038).

## Surfaces

- Ways in: the tab "Events" of the Tasks page (001, 005). The button "Check where this goes" sits
  on the form of the schedule trigger of 010.
- Devices: the computer only. A linked device and the phone do not show the tab (012, 011), as for
  the action log (007). A second profile has its own events.
- Runtimes: the page shows events for every runtime (006). The mark "Holds outside content" and the
  text that the run or the turn gets do not change with the runtime.
- Seeing the state: the row with its result, and the detail with "Why" and "What the workflow
  got".
- Ways out: the page keeps no state that the user turns off. An event leaves with the limit of
  2000, with the 7 days of its id, or with the 1 day of a test event.

## Out of scope

- A rule object of its own. A workflow (010) is the rule.
- A new rule made from an event. The user makes it in the form of a workflow.
- An event for a workflow that is off. The run list of 010 shows that state.
- An event that names no place.
- An address on the network for this app.
- A change of the place of an event after it started.
- A card or a notification of an event. The notice of the run that it starts, and of its stops,
  is the notice of 015.
- A retry of an event on this page. The user uses Retry on the Tasks page (005), or asks the
  outside program to send the message again.
- Search of event text by the responsible document, with the tools of 007.
- An event from a chat service other than Teams (028).
- The source "Web hook" and the source "Watch". 010 names no such trigger (see the questions for
  038).

## Acceptance

- A new app with no work: the page shows "No event yet."
- A workflow with a schedule trigger runs on its time: one row shows the source "Schedule", the
  type, the summary line, and the result "Routed" with the name of the workflow and the run. The
  detail has "Open the place", and that button opens the run view of the workflow with its chat
  beside it. Ask the chat "How far is the run?": the responsible document answers (003).
- A schedule of a workflow that is off: the time passes and no row shows.
- A message of an outside program arrives: one row shows the source "Outside program", the
  result "Routed" with the name of the workflow, and the mark "Holds outside content". "What the
  workflow got" holds the text of the message, cut at 4000 characters.
- A message from Teams arrives (028): one row shows the source "Teams", the name of the Teams chat
  in the summary line, and the result "Routed" with the name of the workflow.
- A message of an outside program with an id that it used before: no second turn starts, the
  program gets the answer of the first call, and the page shows "Duplicate" with "Same call as
  <time>."
- Two messages of an outside program with the same subject, while the turn of the first goes: the
  second row shows "Waits for <subject>.". The first turn ends: the second message starts its turn
  and its row shows "Routed".
- Four messages of an outside program with the same subject, while a turn goes: the fourth row
  shows "Skipped" with "3 messages of <subject> wait.", and it never starts.
- A message of an outside program with a subject of 101 characters is refused, and the reason
  names the subject.
- The "Check where this goes" button on the form of a schedule shows "Would go" with the workflow
  and the nodes that start the run, and no run starts. The run list of the workflow holds no run
  of that time.
- The same button on the form of a workflow that is off shows the line "The workflow is off." and
  no run starts.
- The detail of an event with a long body ends with "…" at 20000 characters.
- A test event leaves the page after 1 day, and the page then shows the earlier rows.
- The filter "Result" with "Skipped" shows only those rows.
- Restart the app with a message of an outside program that waited: its row shows "Failed" with
  "The app stopped.", and no turn exists for it.
- Export the data: the archive holds no event. A second profile shows no event of the first.
- A stand-in linked server and a stand-in phone: neither shows the tab.
- A run ends, a node fails and a proposal waits: the tab "Events" shows no row for them.
