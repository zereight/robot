# 003 Direct chat

## Purpose

The user gives an agent work in plain language and sees what the agent does while it does it.

## Message rows

- A row starts with the sender's face at the left, then a header line: name, a small "BOT" tag
  for agents, and the time. Rows from the same sender within 5 minutes join under one header.
- Day changes show as a centred date line.
- Agent replies render Markdown: headings, lists, tables, code blocks with copy buttons, links,
  and images.
- Tool use shows as a compact card inside the reply: an icon, a short label of what the agent did
  (read a file, ran a command, opened a page), and its result state. A click opens the details.
- Thinking, when the model gives it, folds into one muted line that the user can open.
- Hover on a row shows actions: reply, copy, and for the user's own last message, edit.

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
   control returns to where the user was.
6. Approve: when the agent asks for permission (see 007), an approval card shows in the chat with
   Allow and Deny. The agent waits until the user answers.

## Empty state

A new chat shows the agent's large face, its name, the line "This is the start of your chat.",
and its role line. Nothing moves.

## States

- Working: a quiet animated line "Working…" with elapsed time under the last row.
- Failed: an error row with the reason in plain words and a Retry button.
- Provider not connected: the message box is disabled with a button to connect it.

## Rules

- The conversation is stored locally as each part arrives, so a crash loses at most the part
  that was streaming.
- After an app restart, a reply that was streaming is marked as stopped. The exception is a reply
  whose task still waits for an approval or a question (see 005): it keeps its place and goes on
  after the user answers.
- Scrolling up stops auto-scroll. A "Jump to latest" button brings it back.

## Acceptance

- Send, stop mid-reply, send again: both turns are stored and the first is marked stopped.
- A queued message is sent automatically when the turn ends.
