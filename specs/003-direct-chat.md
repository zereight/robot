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
  message, edit. On a finished message of an agent it also shows "Read aloud" (025) and "Mark as
  unread" (see "Mark as unread").

## Flows

1. Send: the user types and presses Enter. Shift+Enter makes a new line. The message shows at once.
   The agent's reply streams in as it is made.
2. Stop: while the agent works, the send button becomes a stop button. Stop ends the turn; the
   partial reply stays and is marked as stopped.
3. Send while the agent works: see "Messages during a turn".
4. Attach: the user drops or picks files and images. They show as chips in the message box and
   are copied into the agent's workspace when sent. A pasted or dropped image also shows as a
   small preview in the box, and above the sent message in the chat. While a file goes to a
   linked server (012), its chip shows the progress, and it shows "Retry" when the transfer
   fails. A failed file does not stop the other files.
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
   See "Compact". The app can also do this by itself (see "Automatic compact").
9. Continue after a restart: see "Rules".
10. Find in the chat: Cmd+F opens a find bar over the chat that is open (a direct chat, a thread or
    a channel). The user types a text. The bar shows "n of m" and the buttons Previous and Next.
    Enter goes to the next match and Shift+Enter to the previous one. The chat scrolls to the
    match and marks it. Escape closes the bar and takes the marks away. The find looks at the text
    of the messages of that chat only, not at tool cards or thinking. It ignores letter case.
    Cmd+K (001) searches all places and stays as it is. The phone has no find bar in this version.
11. Dictate: the microphone button of the message box turns speech into text in the box (025).

## Messages during a turn

The user can change the course of a turn without stopping it.

- A setting in General (see 013), "While an agent works, new messages", has two values: "Join the
  current turn" (the default) and "Wait in a queue".
- **Join the current turn**: a message that the user sends while the agent works shows in the
  chat at once, with the muted line "Read at the next step". The agent reads it at the next step
  of the same turn: when the tool step that runs now ends, or at once when no tool step runs. Then
  the muted line goes away. The agent reads the message as a new request from the user, and can
  change what it does. No second turn starts.
  - Until the agent reads the message, the row has "Delete". A deleted message does not reach
    the agent.
  - While an approval card waits, the agent reads the message after the user answers the card,
    or after Stop. The card stays open and the user can answer it at any time.
  - While a question card waits, the message is the answer to the question. The card shows
    "Answered in the chat" and the agent goes on with the message as its answer.
  - A message that the agent did not read when the turn ends (for example after Stop) starts the
    next turn, as one message in the order that the user sent them.
- **Wait in a queue**: the message waits in a short queue above the message box. The user can
  remove or edit a queued message before it is sent. Each queued message has "Send now", which
  sends it into the current turn as with "Join the current turn".
- An agent runtime from a vendor (see 006) takes a message during a turn only when its program
  accepts input during a turn. When it does not, the message waits in the queue, whatever the
  setting says, and one muted line above the queue says why. "Send now" is off there, with the
  same reason.
- This applies to direct chats and threads. In a channel (see 004), a message always starts new
  work, as before.
- The message queue of a thread holds at most 10 messages. The message over the limit is not
  queued. The box keeps its text and the line above it says "10 messages wait. Remove one or wait."

## Context meter

- The chat header shows how much of the context of the model the conversation uses, as a small
  ring with the numbers in its label.
- A runtime that reports its usage at the end of each turn feeds the ring. Right after a compact,
  the ring stays empty until the next reply, because no count is known.
- Compact is off, with the reason in words, when the size is not known or when the provider
  compacts by itself.

## Compact

A long conversation fills the context of the model. Compact frees room. The user can run it, and
the app can run it (see "Automatic compact").

- The model of the agent writes the summary, at the lowest effort that the model offers.
- The newest 2 turns stay word for word. The model gets one summary in place of everything older.
  The chat keeps every row. A line "Compacted" marks the place, and the user can open the line to
  read the summary. A later compact summarises the earlier summary and the turns after it.
- While it runs, the working line reads "Compacting…" and Stop ends it. A compact that is stopped
  or fails changes nothing. A message that the user sends during a compact that the user started
  waits in the message queue. When that compact ends, stops or fails, the queue sends its first
  message as after a turn. During an automatic compact, a message joins the turn as usual.
- Compact is off, with the reason in words, while the agent has a task that runs or waits, and
  when the conversation has 2 turns or fewer. The other reasons are in "Context meter".
- A manual compact is not a task. Its tokens add to the usage of the agent and the day (006). It
  holds the agent as a task does: no task of the agent starts until it ends. It does not use a slot
  (005). It does not ask first, because the chat keeps all its rows.
- A restart during a compact changes nothing.
- The mark "Holds outside content" stays after a compact (007).
- An agent on a vendor runtime (006) that compacts by itself has no Compact and no automatic
  compact. For other agents, nothing else changes.

## Automatic compact

- A setting in General (see 013), "Compact long chats automatically", is on by default.
- Before a turn of a direct chat or a thread starts, the app reads the last known use of the
  context. At 85 percent or more, the app compacts first, and then the turn goes on. The working
  line reads "Compacting…" first. The line "Compacted" shows afterwards.
- It does not run when the size of the context is not known, or when the provider compacts by
  itself (see "Context meter"). It does not run in a channel, which has its own rule (004).
- After a compact the use is not known until the next reply (see "Context meter"). So a second
  compact cannot follow at once.
- An automatic compact is part of the task of the turn. Its tokens add to the usage of that task
  and to the token limit of a run of a routine (009).
- When the compact fails, the turn goes on without it. A muted line gives the reason. The app does
  not try again for this conversation until 5 more turns of it have ended. The same holds when the
  first reply after a compact reports 85 percent or more. The count of 5 turns stays after a
  restart.
- Stop during the compact ends the task as Cancelled. The message of the user stays. What the
  model gets does not change.
- A linked computer and the phone show the result only. They do not start a compact in this
  version (011, 012).

## Threads

- **Thread**: a second conversation with the same agent. The agent keeps its identity, memory and
  workspace; only the history is separate. The direct chat is the main thread.
- The user starts a thread, renames it, archives it, restores it, and deletes it. A thread shows
  in a list in the chat header. Each thread keeps its own message queue and its own unread count.
- A new thread opens empty (see "Empty state"). Its title is "New thread" until the user sends the
  first message. Then the title is the first line of that message, at most 60 characters. The user
  can rename it. The main thread keeps its name. The user cannot archive or delete it. Delete of
  another thread asks first and says that the thread cannot be restored.
- An agent has at most 50 threads, the main thread included. Archived threads count. At 50, the
  controls for a new thread and for Fork are off, with the reason in words.
- A thread that has a running turn, a task that waits for the user, a queued task or queued
  messages cannot be archived or deleted. The control is off, with the reason in words.
- All threads of one agent share one queue of tasks (see 005). A message joins the running turn
  of its own thread only. When the agent works in another thread, the message starts its own task
  and waits. The thread shows the line of the queued task (see 005, "Tasks page"). When the agent
  works in another thread, the line reads "Waits for another thread".
- Work that a routine, a workflow, another agent or an outside program sends to the chat of an
  agent goes to the main thread.
- A fork made at a message after a "Compacted" line copies the summary and the turns after it. The
  model of the fork gets the same summary.
- A linked computer and the phone show the main thread only in this version. They never get the
  messages of another thread, and the search of messages on a linked server (001) finds the main
  thread only. An approval card or a question card of a task in another thread shows in "Needs
  you" (011) and in the task view (012), and the user can answer it there. "Open source place" is
  off there, with the reason in words. A notice of a reply in another thread is not sent to these
  devices.
- **Fork**: on a finished message of the main thread or of another thread, the user picks "Fork".
  A new thread of the same agent opens. It holds a copy of the conversation up to that message.
  The agent reads that copy with the first message that the user sends in the new thread. The
  original thread does not change. Later changes in either thread do not reach the other.
- The title of a fork is the first line of the message where it was made, or "New thread" when
  that line is empty.
- A fork is refused for a message that belongs to a turn that still runs, and for a message that
  does not exist.
- A fork keeps a link to its source thread and message. Deleting the source does not change the
  fork.

## Mark as unread

- On a finished message of an agent, the action "Mark as unread" makes that message and the later
  messages of agents count as unread again. The place shows the new count (001).
- The next time the user opens the chat, it opens at that message. The count clears when the chat
  shows its latest message, as for any chat.
- The menu of a place has "Mark as unread" too (001). It marks the latest message of an agent.
- A thread keeps its own count (see "Threads"). The mark works inside a thread.
- The read state follows the unread count (012, 019).

## Empty state

A new chat shows the agent's large face, its name, the line "This is the start of your chat.",
and its role line. Nothing moves.

## States

- Working: a calm animated line under the last row, with elapsed time. The line reads
  "Working…", or, in about half of the turns, a short playful phrase that the app picks at
  random for the turn and keeps until the turn ends. At least 20 phrases exist in each language.
  The Korean phrases read as spoken Korean, not as a translation. For a turn started by a routine,
  the line names the routine. The stop button shows whenever this line shows, in every place
  where the agent works (chat, channel, routine, workflow).
- Quiet: when the turn shows no sign of life for the quiet time, the working line reads "No
  answer from <name> for <time>" (see 005, "Quiet line"). The stop button stays. The quiet line
  does not animate. The elapsed time of the turn stays where it was. The quiet line replaces only
  the text.
- Failed: an error row with the reason in plain words and a Retry button. Retry shows the retry
  note (see 005) when the first try ran steps that may have changed things. The row also tells
  how far the turn went (see 005, "How far a turn went"). A turn that the app stopped because
  it was silent (see 005) fails in this way too.
- Provider not connected: the message box is disabled with a button to connect it.
- Busy provider, backup model and Keep going: a muted line tells that the model is busy and the
  app tries again (006), that the backup model goes on (006), or that the agent was asked to go
  on (005). None of these lines is an error row.
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
- With "Wait in a queue", a queued message is sent automatically when the turn ends.
- With "Join the current turn" and an API provider: the agent runs a tool step that takes 3
  seconds. The user sends "Use b.txt instead". The next request to the model holds this message,
  the chat shows one turn only, and the line "Read at the next step" goes away.
- Send a message during a turn and delete it before the step ends: the model never gets it.
- A question card waits. The user sends "the second one": the card shows "Answered in the chat"
  and the agent goes on with that text as its answer.
- With a runtime that takes no input during a turn: the message waits in the queue, and the
  line above the queue says why.
- Type `/` first in the box: the list opens. Type `~/notes/todo`: no list opens.
- Save a skill for an agent, open the chat, type `/` and the first letters of its name: the list
  shows the skill after the commands. Pick it: a chip with its name shows in the box (017).
- Fork at the third message of a chat of eight messages: the new thread has three messages and
  the original has eight. Fork at a message of a running turn: the app refuses.
- Restart the app while an agent works on a request: the chat shows the notice. Continue sends a
  short message and the notice leaves.
- An agent works on a part of a channel job. This is another place, so the turn is not the turn of
  the direct chat. The user sends a message in its direct chat. The message starts its own task,
  and the task waits as queued, because an agent runs one task at a time (005). End the app at
  once and start it again: the request had not reached the model. The notice says so and has "Send again". The button sends the same text, and the
  agent answers it.
- A chat of 200 messages opens at the latest message and stays there for the first 3 seconds.
- Run "compact" in a chat of six turns: the model gets a summary and the newest 2 turns. The chat
  still shows all six turns, with the line "Compacted" between turn 4 and turn 5. Open the line:
  the summary shows. Compact in a chat of 2 turns is off, with a reason.
- Automatic compact is on. A stand-in provider reports 90 percent use after a reply. The user
  sends a message: the line "Compacting…" shows, then the turn goes on. The ring is empty until the
  reply. Turn the setting off: the same message starts the turn at once.
- The stand-in provider fails the summary call: the turn goes on, a muted line gives the reason, and
  the next turns start with no new try until 5 turns have ended.
- Start a thread and send a message in it: the list in the header shows the main thread and the new
  thread, titled with the first line of the message. Make 50 threads: the control for a new thread
  is off.
- A turn runs in thread A. The user sends a message in thread B of the same agent: it starts a
  task that waits, and thread B shows "Waits for another thread". It starts when the turn of
  thread A ends. A message in thread A joins the turn of thread A.
- Delete a thread that has a running turn: the control is off.
- Fill a message queue with 10 messages: the 11th stays in the box and the line shows "10 messages
  wait. Remove one or wait."
- Stop an automatic compact: the task ends as Cancelled, the message of the user stays, and the
  next turn sends the old conversation to the model.
- Fork at a message after the line "Compacted": the new thread holds the summary and the turns
  after it, and its first turn sends that summary to the model. At 50 threads, Fork is off.
- Delete a thread that has a queued task: the control is off. Delete another thread: the app
  asks first.
- On a linked computer and on the phone, an agent with 3 threads shows the main thread only. A
  task of thread 2 waits for an approval: the card shows in "Needs you" and can be answered there.
  The search of messages finds no message of thread 2.
- Paste an image into the box: a small preview shows in the box, and above the message after it is
  sent. Send a file to a linked server with a stand-in link that fails once: the chip shows
  "Retry", and the other files go.
- Open a chat of 30 messages that holds the word "budget" in four of them. Press Cmd+F and type
  "budget": the bar says "1 of 4". Enter goes to 2 of 4. Escape closes the bar and the marks go.
- A chat has eight messages. The messages 2, 4, 5, 7 and 8 are from an agent. Mark message 5 as
  unread: the place shows the count 3 (messages 5, 7 and 8). Open the chat: it opens at message
  5. Scroll to the end: the count goes.
