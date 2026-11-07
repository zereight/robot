# 015 Notifications and the status island

## Purpose

The user knows when a workflow needs them or finishes a run, without watching the window. Each
notice leads to the chat of the workflow. There the user asks the responsible document how far
the run has gone, why it stopped or waits, and what the results so far are, and gives feedback
while the run works (003).

## System notifications

- Kinds:
  - **Reply**: a reply in the chat of a workflow while the window is not focused.
  - **Approval request**: an approval card of a node or of a turn of the chat (007), or a request
    card of a manage request from an outside program or from the chat that waits for the user
    (037). The pick of a decision node (010) is an approval request.
  - **Question**: a question card, also a protected card for a secret (020).
  - **Node failed**: a task that ends as failed or blocked (see 005). A run stops when a node
    fails, unless the node has the mark "Continue on failure" (010). The notice names the workflow,
    the node and the reason.
  - **Run done**: a run of a workflow ends as done.
  - **Proposal waits**: a proposal of self-improvement or a memory proposal waits for the user
    (002, 008). One notice goes out for each run or turn of the chat that made proposals. It gives
    the number of proposals. A memory check (008) makes no notice, also when it fails.
  - **Teams link needs you**: the link is signed out or paused (see 028).
- A run that the user stopped makes no notice. The user did it.
- Each kind can be turned off. A server can be muted for 1 hour, 8 hours, 1 day, or until turned
  back on.
- Clicking a notification opens the chat of the workflow. A manage request (037) makes a workflow
  that does not exist yet, so its notice opens the request card. For a reply, an approval request
  and a question, the click scrolls to the message or the card. For a node failure and a finished
  run, it opens the chat of the workflow with the run view (010). For a proposal, it opens the chat
  of the workflow: with the run view when a run made the proposal, and at the proposal when a turn
  of the chat made it (a turn of the chat has no run). It also offers the link "Review" (002). The
  text of a notice holds no result of a node, no command and no path.
- A computer that has a linked server open (012) shows the kinds reply, approval request, question
  and node failed for that server while the link is online. The notification names the server.
  Mutes work per server, so the user can mute one computer and not the other. A request that a
  client already answered does not notify again on other devices. The kinds run done, proposal
  waits and Teams link needs you are for the computer that holds the workflow or the link only (see
  the questions for 015).
- When two computers sync (019), an approval or a question of a task on the other computer also
  shows here, with the name of that computer. Data that arrives by sync makes no notice. Once
  one computer has an answer, the other drops the notice.
- The mute row in Settings → Notifications follows the server on screen: "This server" for this
  computer, or "Server <name>" for a linked one.
- Only the open profile (022) makes system notices and shows the status island. A profile that is
  not open makes none on this computer. Its entry in the profile menu shows a dot while
  something waits for the user. Devices linked to it get its notices as above.

## Status island (optional)

- A small dark shape at the top centre of the screen, around the camera notch when there is one.
  Nothing of the island sits behind the notch.
- When the screen changes (its resolution, or a screen that comes or goes), the island moves to the
  top centre of the screen again, and reads the notch again.
- A workflow **works** while a task of its run runs, or while a turn of its chat works (003).
- Idle: the app mark at the left and a still muted dot at the right. Nothing moves when idle.
- Working: the app mark at the left. At the right, a moving dot (still with reduce motion) and the
  number of workflows that work.
- Attention: an approval or question expands the island with the name of the workflow, a short
  summary and buttons to answer or open the app (see "Attention card").
- The user can turn it off, or show it only for attention.
- Settings → Notifications has "Island bar width" with two choices, "Compact" and "Wide". The
  default is "Compact". The setting belongs to this computer and does not sync (019).
- The island shows work and requests of this computer, and of the workflows that run on the
  computer that this one syncs with (019). It never shows those of a linked server. An approval of
  a task that runs on the other computer has no "Always allow" button on the island: only the
  computer that runs the task can save a rule (007).

### Detail card

- While at least one workflow works, the user points at the island or clicks it. The island then
  grows to a detail card. When the pointer has left the island for 400 ms, or the user clicks the
  bar again, the card closes, and it stays closed until the pointer has left the island and
  comes back. In the mode "only for attention" there is no detail card.
- When no workflow works, the pointer opens nothing. While a result card shows, the detail card
  does not open.
- The card has one row for each working workflow, at most 5. If more workflows work, a last line
  says how many more.
- The rows are in the order in which the workflows began to work.
- A row shows: the name of the workflow, what the workflow does now, and the time the current
  task has run. For a task that runs, the row names the node (its number and name). For a turn of
  the chat, the row says "Chat". For a workflow whose run has no running task, for example while a
  task waits for a free slot (005), the time is the time since the workflow began to work.
- "What the workflow does now" is, in this order:
  1. the kind of step that the node runs: file work, a command, the web, the browser, a
     connection, sub-work, or the computer (see 007);
  2. "Working…".
  When the turn is quiet (see 005, "Quiet line"), the row shows the quiet line in place of these.
- The kinds follow the tools. File work is the file tools, the tools for articles (see 016) and
  the file edits of vendor programs. A command is the shell tools. The web is page fetch and
  web search. The browser is the browser tools. A connection is a tool of a connection (see
  018). Sub-work is the tool that starts a sub-task of a vendor program. The computer is
  computer use. A tool that is none of these, for example saving a memory, shows "Working…".
- A row never shows the text of a command, a path, the content of a file, or the result of a
  node. The island sits over other apps and can be seen by others. The kind of step is enough.
- The time reads m:ss, and h:mm:ss after one hour. It changes once each second while the card is
  open.
- A click on a row opens the chat of that workflow with its run view. There the user can ask
  about the run and give feedback (003).
- A new request for attention replaces the detail card with the attention card.

### Attention card

- The card shows, above the summary, the name of the workflow and the kind of step (for an
  approval) or "Question". For the pick of a decision node, the kind reads "Pick".
- A summary of an approval has at most 90 characters and uses up to 2 lines. A question has at
  most 160 characters and uses up to 3 lines.
- Sometimes the app does not know the step yet, for example when a vendor program asks before it
  says what the step is. Then the kind reads "Approval". A request to change an article reads
  "File work".
- When more than one request waits, the card shows "1 of N" and a control to go to the previous
  and the next request. The oldest request shows first. The controls go round: at the first
  request, "previous" shows the last one, and at the last request, "next" shows the first one.
- When the user answers a request, the card shows the request that took its place, that is the
  next one. If the answered request was the last one, the card shows the one before it. A request
  that the user looks at stays on the screen when another request ends or a new one comes. When
  none is left, the island goes back to its idle or working shape.
- The buttons stay as they are: for an approval, the answers of the approval card (Allow once,
  Always allow for this workflow, Deny; see 007), and "Open app" for both kinds. "Open app" opens
  the chat of the workflow at the card. The buttons may use a second row. The user answers a
  question, a protected card (020) and a pick in the app.

### Result card

- In the mode "always", the island shows a result card when a system notification of the kind
  reply, node failed or run done is due (see "System notifications"). The same rules apply: the
  kind is on, the place is not muted, and no window of the app has the focus. A notification of
  another kind, for example a proposal, makes no result card.
- The card shows the name of the workflow, one line, and "Open app". "Open app" opens the chat of
  the workflow, at the message or with the run view. The line is the first line of the reply, the
  reason for the failure, or "Run done" for a finished run. It has at most 90 characters, and a
  longer line ends with "…". The first line of the reply is the first line that has text, as it
  is, with the spaces at both ends removed. The reason for a failure is the error text in the
  language of the interface, the same text as on the Tasks page. A finished run shows no result
  of a node.
- A blocked task makes a result card like a failed task. Its line is the reason of the block.
- The bar stays above the result card, so the dot and the count stay in view.
- The card stays for 6 seconds, and as long as the pointer is on it. A newer result replaces it.
  A request for attention replaces it at once. When the user has answered all requests, the
  replaced card does not come back. A result that comes while a request waits makes no card.
- In the modes "only for attention" and "off", there is no result card. The system notification
  is the same in all modes.

## Phone notices while the user works

- A setting in Settings → Notifications, "Keep phones quiet while I work at this computer", is on
  by default.
- With it on, the server sends no notice to a linked phone (011) while this computer has had
  keyboard or mouse input within the last 30 seconds, in any app. The app reads the time since the
  last input from the system. That value stays on the computer. It is never sent to a phone or to
  a linked computer.
- The server holds the notice back.
- When the computer has had no input for 30 seconds, the server sends the held notices.
- It does not send a held notice whose cause the user already saw or answered on the computer,
  for example an answered card or a place that was read.
- While the server holds notices, Settings → Notifications shows the muted line "Notices to
  phones are held while you work here."
- Held notices are not stored. After a restart of the app they are gone, and the data still
  reaches the phone.
- The setting belongs to this computer and does not sync (019).
- A computer that sleeps or is locked counts as no input.
- The phone still gets the data. Messages, counts and lists show when the app opens. Only the
  notice is held.
- A computer that opens a linked server has its own rule for its own notices ("Do-not-disturb"
  below). This rule is for phones only.
- The phone gets the kinds that 011 lists: reply, approval request (with the pick of a decision
  node) and node failed.

## Menu bar item

- A setting of the computer in General (013), "Show in the menu bar", is off by default. With it on,
  a small icon of the app shows in the menu bar of the Mac, also when the window is closed. It
  shows a still dot when nothing works, a moving dot while a workflow works (still with reduce
  motion), and a badge when something waits for the user.
- A click opens a menu. It has one row for each working workflow (name, node or "Chat", and the
  time, as in the detail card), at most 5, and a last line for the rest. It has the line "N waiting
  for you", which opens the chat of the workflow of the oldest request, at its card. N is the
  number of requests that wait for an answer of the user (an approval card, a question card or a
  pick of a decision node, in a run or in a turn of the chat) in all workflows of the open profile.
  The oldest request is the one that has waited the longest. The line is not there when N is 0,
  and the items "Open ROBot", "Settings" and "Quit".
  "Quit" follows the rule of 001.
- The menu shows no command, path, file content or result of a node, as the detail card does not.
- Only the open profile shows here (022). The menu shows no work of a linked server, as the island
  does not.
- When the window is closed, "Open ROBot" opens it again.

## Sound

- Settings → Notifications has "Sound when a task ends". The user picks one of four
  sounds that the app brings, or "None". The first sound is the default. Each sound plays when the
  user picks it in the list.
- The sound plays when a result card would show (see "Result card"): the kind is reply, node
  failed or run done, the kind is on, the place is not muted, and no window of the app has the
  focus. It plays in every mode of the island. When several results come within one second, the
  sound plays once. A result that comes while a request waits makes no card and no sound. A turn
  that a continuation follows (005, "Keep going") makes none of them.
- It plays on this computer for the work of this computer. A phone uses its own sound of the
  system.
- The system notice has no sound of its own while the app plays this sound. Do-not-disturb of the
  system, and the mute of a server, silence it. The quiet line makes no sound (005).
- The sounds are new files made for ROBot.

## Rules

- Do-not-disturb of the system is respected.
- The notice "Run done" goes out only while no window of the app has the focus, as a reply does.
  This is the choice for now (see the questions for 015).
- The pause of a turn for a compact (026) is not the end of a turn. It makes no notification,
  no sound and no result card.
- After an app restart, a run that was going, with its tasks that waited for an approval or a
  question, is failed with the reason "The app stopped" (010). A turn of the chat that waited
  does not go on (003). No request asks for attention again, and no notice goes out for the
  restart.
- A notice never decides for the user. It leads to the chat, and the user answers there or in the
  card.
- Motion in the island is short (under 300 ms) and follows reduce motion. With reduce motion on,
  the cards still show and close, with no movement.
- When the island changes its size (the bar grows to a card, or a card closes to the bar), the
  shape grows or shrinks in one smooth move, and does not jump in one frame. Each corner at the
  bottom of the shape stays round during the move, at the left and at the right.
- Each part of the island has a text label for screen readers: the rows, the count, "1 of N",
  and the buttons.
- The island keeps its size to its content. It never needs a scroll bar. A card is 460 px wide,
  and the height fits the content, up to 560 px.
- The bar is wide enough for its content, and never narrower than the camera notch plus the place
  that the mark and the dot with the count need at each side of it. The mark sits in the left wing
  and the dot and the count sit in the right wing, each group centred in its wing, so the bar
  never puts content behind the notch. On a screen with no notch, the bar is 340 px wide and the
  two groups keep the two ends of it. This is the choice "Compact".
- With "Wide", each wing has 24 px more room, so the bar is 48 px wider than with "Compact", and
  the groups stay centred in their wings. On a screen with no notch, the bar is 388 px wide. "Wide"
  never makes the bar narrower, and no choice puts content behind the notch.
- A bar keeps the width of its choice, not the width of the card that was open before. When the
  card closes, the bar goes back to its width at once.
- A change of the choice shows on the island at once, with no restart, and stays after a restart.
- The island follows a change of language or of reduce motion at once, while it is open.

## Surfaces

- **Ways in**: Settings → Notifications for the kinds, the mutes, the island, the sound and the
  phone rule; the island, the menu bar item and the system notice for the user.
- **Devices**: the computer shows all. A linked computer (012) shows the kinds that "System
  notifications" gives. The phone (011) gets the kinds that "Phone notices while the user works"
  gives. A second profile (022) is shown by a dot only.
- **Runtimes**: nothing changes. A node on a vendor runtime (006) shows as other work.
- **Ways out**: each kind can be turned off, a server can be muted, and the island can be turned
  off or limited to attention.
- **Seeing the state**: the island, the menu bar item and the badge show what works and what
  waits. After a restart, the run view and the Tasks page show the state (010, 005).
- **Data**: the settings of this spec belong to the computer and do not sync (019). A held notice
  is not stored.
- **Words**: see `docs/glossary.md`.

## Acceptance

- On a screen with a camera notch, open the detail card and close it. The bar is as wide as the
  notch and its two wings, not as wide as the card. Choose "Wide": the bar is 48 px wider at
  once. Restart the app: the choice is still "Wide".
- An approval request with the window hidden shows a notification and expands the island; Allow
  on the island lets the task continue. "Open app" opens the chat of the workflow at the card.
- Three workflows work and the window is hidden. The user points at the island: a card shows three
  rows. Each row has the name of the workflow, a line about the work, and a time that counts up. A
  click on a row opens the chat of that workflow.
- Seven workflows work. The card shows five rows and a line that says "2 more".
- A node runs a command. The row says that a command runs. It does not show the command.
- A turn of the chat works: the row says "Chat".
- Three approval requests wait. The island shows "1 of 3". The user allows the first one: the
  island shows "1 of 2" with the next request, and the first task goes on.
- A decision node asks the user to pick an option, with the window hidden: a notification shows,
  the island shows the attention card with the kind "Pick", and the pick in the app lets the run go
  on.
- A reply ends in the chat of a workflow while the window is hidden, in the mode "always". A result
  card shows the first line of the reply for 6 seconds. "Open app" opens the message. Mute that
  server and repeat: no card and no notification show.
- In the mode "only for attention", a reply ends while the window is hidden. A system
  notification shows. The island shows no card.
- Three approval requests wait and the user looks at "2 of 3". The user allows it: the card
  shows "2 of 2" with the request that took its place. At the first request, "previous" shows the
  last one.
- A result card shows, and then an approval request comes. The attention card replaces the
  result card. The user answers: the island does not show the result card again.
- A node fails in a run that a schedule started, with the window hidden, in the mode "always". A
  result card shows the name of the workflow and the error text, and the notification names the
  node. Click the notification: the chat of the workflow opens with the run view. Ask "Why did it
  stop?": the responsible document names the node and the reason (003).
- A run ends as done with the window hidden: a notification and a result card with "Run done" show.
  They hold no result of a node. Click the notification: the chat opens, and "What are the
  results?" gets the results of the nodes (003).
- The user stops a run: no notice goes out.
- A run waits for the pick of a decision node. The user clicks the notice, writes feedback on a
  result in the chat while the run waits, and the run gets the feedback (003).
- A run ends and the workflow proposes a change to its responsible document: one notice "Proposal
  waits" shows, with the number. The click opens the chat of the workflow, and the link "Review"
  opens the card (002).
- A turn of the chat makes a proposal: one notice "Proposal waits" shows. The click opens the chat
  of the workflow with the proposal, not a run view.
- A memory check (008) makes proposals, or fails: no notice goes out.
- A stand-in outside program asks to make a workflow (037), with the window hidden: a notice of the
  kind approval shows, and the phone gets it too. The click opens the request card.
- A run ends as done while the window of the app has the focus: no notice goes out. Hide the
  window and end another run: the notice "Run done" shows.
- No workflow works. The user points at the island: nothing opens.
- The island is open and the user changes the language to Korean: the text of the island
  changes at once.
- Stand-in input arrives on the computer 5 seconds ago, and a stand-in phone is linked. A reply
  ends: the phone gets the data and no notice. The input stops. After 30 seconds the notice
  comes. Read the place on the computer first: the notice does not come. Turn the setting off: the
  notice comes at once.
- Turn on the menu bar item. Two stand-in workflows work: the menu lists both with their nodes and
  times, and shows no command text. "Quit" while a workflow works shows the note of 001. A
  request waits: the line "1 waiting for you" opens the chat of its workflow.
- Pick the second sound, and end three runs within one second: the sound plays once. Pick "None":
  it is silent.
- Restart the app while a run waits for an approval: the run and its tasks are failed with "The
  app stopped", and no card and no notice asks again.
