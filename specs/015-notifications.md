# 015 Notifications and the status island

## Purpose

The user knows when an agent needs them or finishes, without watching the window.

## System notifications

- Kinds: reply in a direct chat while the window is not focused, mention in a channel, approval
  request, question, task failed, routine failed, part in review (see 004), workflow notice (a
  notify step, see 010), and Teams link needs you (the link is signed out or paused, see 028). A
  task that ends as Blocked (see 005) is a failed task for this list,
  and a routine run that ends as Blocked is a failed run. A question of a member that is with the
  lead (004) makes no notification. It makes one only when it passes to the user.
- Each kind can be turned off. A server or a channel can be muted for 1 hour, 8 hours, 1 day, or
  until turned back on.
- Clicking a notification opens the place and scrolls to the message.
- A computer that has a linked server open (012) shows the same kinds for that server while the
  link is online. The notification names the server. Mutes work per server, so the user can mute
  one computer and not the other. A request that a client already answered does not notify again
  on other devices.
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
- Idle: the app mark at the left and a still muted dot at the right. Nothing moves when idle.
- Working: the faces of working agents (up to 3) and a count.
- Attention: an approval or question expands the island with the agent face, a short summary
  and buttons to answer or open the app (see "Attention card").
- The user can turn it off, or show it only for attention.
- The island shows work and requests of this computer, and of tasks of the computer that this one
  syncs with (019). It never shows those of a linked server. An approval of a task that runs on
  the other computer has no "Always allow" button on the island: only the computer that runs the
  task can save a rule (007).

### Detail card

- While at least one agent works, the user points at the island or clicks it. The island then
  grows to a detail card. When the pointer has left the island for 400 ms, or the user clicks the
  bar again, the card closes, and it stays closed until the pointer has left the island and
  comes back. In the mode "only for attention" there is no detail card.
- When no agent works, the pointer opens nothing. While a result card shows, the detail card
  does not open.
- The card has one row for each working agent, at most 5. If more agents work, a last line says
  how many more.
- The rows are in the order in which the agents began to work.
- A row shows: the face, the name, the place where the agent works (a channel name, or a note
  that it is a direct chat), what the agent does now, and the time the current task has run.
  For an agent that waits for its turn and has no running task, the time is the time since the
  agent began to work.
- A routine that posts in a channel has that channel as its place. A routine in the chat of an
  agent, and a step of a workflow, have the direct chat as their place.
- "What the agent does now" is, in this order:
  1. the label of the plan step that runs (see 004);
  2. the kind of step that the agent runs: file work, a command, the web, the browser, a
     connection, another agent, or the computer (see 007);
  3. "Working…".
  When the turn is quiet (see 005, "Quiet line"), the row shows the quiet line in place of these.
- The kinds follow the tools. File work is the file tools, the tools for articles (see 016) and
  the file edits of vendor programs. A command is the shell tools. The web is page fetch and
  web search. The browser is the browser tools. A connection is a tool of a connection (see
  018). Another agent is the tool that starts a sub-agent of a vendor program. The computer is
  computer use. A tool that is none of these, for example saving a memory, shows "Working…".
- A row never shows the text of a command, a path, or the content of a file. The island sits
  over other apps and can be seen by others. The kind of step is enough.
- The time reads m:ss, and h:mm:ss after one hour. It changes once each second while the card is
  open.
- A click on a row opens the place of that agent.
- A new request for attention replaces the detail card with the attention card.

### Attention card

- The card shows, above the summary, the place of the request and the kind of step (for an
  approval) or "Question".
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
  Always allow for this agent, Deny; see 007), and "Open app" for both kinds. The buttons may use
  a second row. The user answers a question in the app.

### Result card

- In the mode "always", the island shows a result card when a system notification of the kind
  reply, task failed or routine failed is due (see "System notifications"). The same rules
  apply: the kind is on, the place is not muted, and no window of the app has the focus. A
  notification of another kind, for example a mention in a channel, makes no result card. A
  failed task or routine in a channel does.
- The card shows the face, the name, the place, one line, and "Open app". The line is the first
  line of the reply, or the reason for the failure. It has at most 90 characters, and a longer
  line ends with "…". The first line of the reply is the first line that has text, as it is,
  with the spaces at both ends removed. The reason for a failure is the error text in the
  language of the interface, the same text as on the Tasks page.
- A blocked task makes a result card like a failed task. Its line is the reason of the block.
  A part in review makes no result card, and the island does not show it. Its notification opens
  the part.
- The bar stays above the result card, so the faces and the count stay in view.
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

## Menu bar item

- A setting of the computer in General (013), "Show in the menu bar", is off by default. With it on, a small icon
  of the app shows in the menu bar of the Mac, also when the window is closed. It shows a still
  dot when nothing works, a moving dot while an agent works (still with reduce motion), and a
  badge when something waits for the user.
- A click opens a menu. It has one row for each working agent (face, name, place, and the time, as
  in the detail card), at most 5, and a last line for the rest. It has the line "N waiting for
  you", which opens the Today page (021), and the items "Open ROBot", "Settings" and "Quit".
  "Quit" follows the rule of 001.
- The menu shows no command, path or file content, as the detail card does not.
- Only the open profile shows here (022). The menu shows no work of a linked server, as the island
  does not.
- When the window is closed, "Open ROBot" opens it again.

## Sound

- Settings → Notifications has "Sound when a task ends". The user picks one of four sounds that
  the app brings, or "None". The first sound is the default. Each sound plays when the user picks
  it in the list.
- The sound plays when a result card would show (see "Result card"): the kind is reply, task
  failed or routine failed, the kind is on, the place is not muted, and no window of the app has
  the focus. It plays in every mode of the island. When several results come within one second,
  the sound plays once. A result that comes while a request waits makes no card and no sound. A
  turn that a continuation follows (005, "Keep going") makes none of them.
- It plays on this computer for the work of this computer. A phone uses its own sound of the
  system.
- The system notice has no sound of its own while the app plays this sound. Do-not-disturb of the
  system, and the mute of a server or a channel, silence it. The quiet line makes no sound (005).
- The sounds are new files made for ROBot.

## Rules

- Do-not-disturb of the system is respected.
- The pause of a turn for a compact (026) is not the end of a turn. It makes no notification,
  no sound and no result card.
- After an app restart, a task that still waits for an approval or a question (see 005) asks for
  attention again, in the same way as a new request. It asks once.
- Motion in the island is short (under 300 ms) and follows reduce motion. With reduce motion on,
  the cards still show and close, with no movement.
- Each part of the island has a text label for screen readers: the rows, the count, "1 of N",
  and the buttons.
- The island keeps its size to its content. It never needs a scroll bar. The bar is 340 px wide,
  a card is 460 px wide, and the height fits the content, up to 560 px.
- The island follows a change of language or of reduce motion at once, while it is open.

## Acceptance

- An approval request with the window hidden shows a notification and expands the island; Allow
  on the island lets the task continue.
- Three agents work and the window is hidden. The user points at the island: a card shows three
  rows. Each row has the name, the place, a line about the work, and a time that counts up. A
  click on a row opens that place.
- Seven agents work. The card shows five rows and a line that says "2 more".
- A command runs. The row says that a command runs. It does not show the command.
- Three approval requests wait. The island shows "1 of 3". The user allows the first one: the
  island shows "1 of 2" with the next request, and the first task goes on.
- A reply ends in a direct chat while the window is hidden, in the mode "always". A result card
  shows the first line of the reply for 6 seconds. "Open app" opens the message. Mute that
  server and repeat: no card and no notification show.
- In the mode "only for attention", a reply ends while the window is hidden. A system
  notification shows. The island shows no card.
- Three approval requests wait and the user looks at "2 of 3". The user allows it: the card
  shows "2 of 2" with the request that took its place. At the first request, "previous" shows the
  last one.
- A result card shows, and then an approval request comes. The attention card replaces the
  result card. The user answers: the island does not show the result card again.
- A task fails in a channel while the window is hidden, in the mode "always". A result card
  shows the name of the channel and the error text. A mention in a channel makes a system
  notification and no result card.
- No agent works. The user points at the island: nothing opens.
- The island is open and the user changes the language to Korean: the text of the island
  changes at once.
- Stand-in input arrives on the computer 5 seconds ago, and a stand-in phone is linked. An agent
  replies: the phone gets the data and no notice. The input stops. After 30 seconds the notice
  comes. Read the place on the computer first: the notice does not come. Turn the setting off: the
  notice comes at once.
- Turn on the menu bar item. Two stand-in agents work: the menu lists both with their places and
  times, and shows no command text. "Quit" while an agent works shows the note of 001.
- Pick the second sound, and end three tasks within one second: the sound plays once. Pick "None":
  it is silent.
