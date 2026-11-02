# 015 Notifications and the status island

## Purpose

The user knows when an agent needs them or finishes, without watching the window.

## System notifications

- Kinds: reply in a direct chat while the window is not focused, mention in a channel, approval
  request, question, task failed, routine failed, and workflow notice (a notify step, see 010).
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

## Status island (macOS, optional)

- A small dark shape at the top centre of the screen, around the camera notch when there is one.
- Idle: the app mark at the left and a still muted dot at the right. Nothing moves when idle.
- Working: the faces of working agents (up to 3) and a count.
- Attention: an approval or question expands the island with the agent face, a short summary
  and buttons to answer or open the app (see "Attention card").
- The user can turn it off, or show it only for attention.
- The island shows work and requests of this computer only, not those of a linked server.

### Detail card

- While at least one agent works, the user points at the island or clicks it. The island then
  grows to a detail card. When the pointer has left the island for 400 ms, or the user clicks the
  bar again, the card closes. In the mode "only for attention" there is no detail card.
- The card has one row for each working agent, at most 5. If more agents work, a last line says
  how many more.
- A row shows: the face, the name, the place where the agent works (a channel name, or a note
  that it is a direct chat), what the agent does now, and the time the current task has run.
- "What the agent does now" is, in this order:
  1. the label of the plan step that runs (see 004);
  2. the kind of step that the agent runs: file work, a command, the web, the browser, a
     connection, another agent, or the computer (see 007);
  3. "Working…".
- A row never shows the text of a command, a path, or the content of a file. The island sits
  over other apps and can be seen by others. The kind of step is enough.
- The time reads m:ss, and h:mm:ss after one hour. It changes once each second while the card is
  open.
- A click on a row opens the place of that agent.
- A new request for attention replaces the detail card with the attention card.

### Attention card

- The card shows, above the summary, the place of the request and the kind of step (for an
  approval) or "Question".
- A summary has at most 90 characters. A question may use up to 3 lines and 160 characters.
- When more than one request waits, the card shows "1 of N" and a control to go to the previous
  and the next request. The oldest request shows first. When the user answers one, the card shows
  the next one at once. When none is left, the island goes back to its idle or working shape.
- The buttons stay as they are: for an approval, the answers of the approval card (Allow once,
  Always allow for this agent, Deny; see 007), and "Open app" for both kinds. The buttons may use
  a second row. The user answers a question in the app.

### Result card

- In the mode "always", the island shows a result card when a system notification of the kind
  reply, task failed or routine failed is due (see "System notifications"). The same rules
  apply: the kind is on, the place is not muted, and no window of the app has the focus.
- The card shows the face, the name, the place, one line, and "Open app". The line is the first
  line of the reply, or the reason for the failure. It has at most 90 characters.
- The card stays for 6 seconds, and as long as the pointer is on it. A newer result replaces it.
  A request for attention replaces it at once.
- In the modes "only for attention" and "off", there is no result card. The system notification
  is the same in all modes.

## Rules

- Do-not-disturb of the system is respected.
- After an app restart, a task that still waits for an approval or a question (see 005) asks for
  attention again, in the same way as a new request. It asks once.
- Motion in the island is short (under 300 ms) and follows reduce motion. With reduce motion on,
  the cards still show and close, with no movement.
- Each part of the island has a text label for screen readers: the rows, the count, "1 of N",
  and the buttons.
- The island keeps its size to its content. It never needs a scroll bar.

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
