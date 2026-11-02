# 003 Direct chat

## Purpose

The user gives an agent work in plain language and sees what the agent does while it does it.

## Message rows

- A row starts with the sender's face at the left, then a header line: name, a small "BOT" tag
  for agents, and the time. Rows from the same sender within 5 minutes join under one header.
- Day changes show as a centred date line.
- Agent replies render Markdown: headings, lists, tables, code blocks with copy buttons, links,
  and images. The app adds no automatic image preview below a reply. An image shows only where the
  Markdown of the reply puts it.
- Tool use shows as a compact card inside the reply: an icon, a short label of what the agent did
  (read a file, ran a command, opened a page), and its result state. A click opens the details.
- Thinking, when the model gives it, folds into one muted line that the user can open.
- Hover on a row shows actions: reply, copy, fork (see "Threads"), and for the user's own last
  message, edit.

## Flows

1. Send: the user types and presses Enter. Shift+Enter makes a new line. The message shows at once.
   The agent's reply streams in as it is made.
2. Stop: while the agent works, the send button becomes a stop button. Stop ends the turn; the
   partial reply stays and is marked as stopped.
3. Queue: if the user sends while the agent works, the message waits in a short queue above the
   message box. The user can remove or edit a queued message before it is sent.
4. Attach: the user drops or picks files and images. They show as chips in the message box and
   are copied into the agent's workspace when sent.
5. Reply: the user picks "reply" on a message. A quote line shows above the box. The sent message
   links back; clicking the link scrolls to the quoted message and flashes it, and a "Back"
   control returns to where the user was. A hit of message search (001) uses the same jump.
6. Approve: when the agent asks for permission (see 007), an approval card shows in the chat with
   Allow and Deny. The agent waits until the user answers.
7. Command picker: when the user types a slash as the first character of a message, a list opens
   above the box. It shows the commands first, then the skills that the user saved for this agent
   (see 017), then the skills of the agent, if its runtime reports skills (see 006). A skill of a
   runtime shows the name of the runtime. The list narrows as the user types. It shows at most 30
   skills, in this order. A skill that the user saved sets a chip in the box when picked (see 017).
   A slash in any other place is plain text, so a path such as `~/notes/todo` never opens the list.
8. Compact: the user runs the command "compact" from the list, or uses the Compact control of the
   context meter. The app asks the model to replace the older part of the conversation with a
   summary, to free room in the context. A failure shows in the normal error line above the box.
9. Continue after a restart: see "Rules".

## Context meter

- The chat header shows how much of the context of the model the conversation uses, as a small
  ring with the numbers in its label.
- A runtime that reports its usage at the end of each turn feeds the ring. Right after a compact,
  the ring stays empty until the next reply, because no count is known.
- Compact is off, with the reason in words, when the size is not known or when the provider
  compacts by itself.

## Threads

- **Thread**: a second conversation with the same agent. The agent keeps its identity, memory and
  workspace; only the history is separate. The direct chat is the main thread.
- The user starts a thread, renames it, archives it, restores it, and deletes it. A thread shows
  in a list in the chat header. Each thread keeps its own queue and its own unread count.
- **Fork**: on a finished message of the main thread or of another thread, the user picks "Fork".
  A new thread of the same agent opens. It holds a copy of the conversation up to that message.
  The agent reads that copy with the first message that the user sends in the new thread. The
  original thread does not change. Later changes in either thread do not reach the other.
- The title of a fork is the first line of the message where it was made, or a default title when
  that line is empty.
- A fork is refused for a message that belongs to a turn that still runs, and for a message that
  does not exist.
- A fork keeps a link to its source thread and message. Deleting the source does not change the
  fork.

## Empty state

A new chat shows the agent's large face, its name, the line "This is the start of your chat.",
and its role line. Nothing moves.

## States

- Working: a quiet animated line under the last row, with elapsed time. The line reads
  "Working…", or, in about half of the turns, a short playful phrase that the app picks at
  random for the turn and keeps until the turn ends. At least 20 phrases exist in each language.
  The Korean phrases read as spoken Korean, not as a translation. For a turn started by a routine,
  the line names the routine. The stop button shows whenever this line shows, in every place
  where the agent works (chat, channel, routine, workflow).
- Failed: an error row with the reason in plain words and a Retry button. The row also tells how
  far the turn went (see 005, "How far a turn went"). A turn that the app stopped because it was
  silent (see 005) fails in this way too.
- Provider not connected: the message box is disabled with a button to connect it.
- Interrupted by a restart: see "Rules".

## Rules

- The conversation is stored locally as each part arrives, so a crash loses at most the part
  that was streaming.
- After an app restart, a reply that was streaming is marked as stopped. The exception is a reply
  whose task still waits for an approval or a question (see 005): it keeps its place and goes on
  after the user answers.
- When a restart cut off the last request of the user to this agent, and the user has not
  written since, a notice shows above the message box. It says that the restart stopped the
  request. Its "Continue" button sends a short new message that asks the agent to go on. It does
  not send the old request again, so no side effect repeats unless the user chooses it. A stop by
  the user shows no notice.
- If the cut request had not reached the model (see 005, "How far a turn went"), the notice says
  so. It has the button "Send again" and no "Continue". "Send again" does what Retry does for the
  task (005): it sends the same request again, because no step ran. On a linked device (012), it
  asks the server to retry the task.
- If the cut request had reached the model ("Sent" or "Started"), the notice shows the line of
  005 for that progress, and keeps "Continue".
- Scrolling up stops auto-scroll. A "Jump to latest" button brings it back.
- For 3 seconds after a chat opens, an upward scroll that the reader did not cause (no wheel,
  touch, drag or key) returns the chat to the latest message, as long as the chat follows the
  latest message. Later scrolls are left alone. The app never fights the reader.
- A chat with more than 30 messages draws only the rows that are near the visible area. Return to
  a long chat from another page is fast, and the scroll place stays.
- The hint text in the message box hides while the box holds text.

## Acceptance

- Send, stop mid-reply, send again: both turns are stored and the first is marked stopped.
- A queued message is sent automatically when the turn ends.
- Type `/` first in the box: the list opens. Type `~/notes/todo`: no list opens.
- Save a skill for an agent, open the chat, type `/` and the first letters of its name: the list
  shows the skill after the commands. Pick it: a chip with its name shows in the box (017).
- Fork at the third message of a chat of eight messages: the new thread has three messages and
  the original has eight. Fork at a message of a running turn: the app refuses.
- Restart the app while an agent works on a request: the chat shows the notice. Continue sends a
  short message and the notice leaves.
- An agent works on a part of a channel job. The user sends a message in its direct chat, and the
  task waits as queued (005). End the app at once and start it again: the request had not reached
  the model. The notice says so and has "Send again". The button sends the same text, and the
  agent answers it.
- A chat of 200 messages opens at the latest message and stays there for the first 3 seconds.
