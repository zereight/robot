# 023 Outside programs

## Purpose

The user works in another program on the same computer, for example a coding agent in a terminal
or an editor. That program can read what the agents of ROBot did and give them work, through MCP
(Model Context Protocol, an open standard). It cannot answer approvals, change settings, or delete
anything, and an agent asks the user before it changes a setting for it.

## Concepts

- **Outside program**: an entry that the user adds. It has a name (1 to 40 characters, unique,
  case ignored), an access ("Read" or "Read and send work"), an access key, the date it was made,
  and the time it was last used.
- **Helper**: a small program that comes with ROBot. The outside program starts it as an MCP server
  of the kind "program on this computer". The helper talks only to ROBot on this computer.
- **Access key**: a secret that tells ROBot which entry calls. It is in the system keychain (014).

## Flows

1. Turn on: in Settings, Outside programs (013), the switch "Allow outside programs" is off by
   default. When the user turns it on, the page says what an outside program can and cannot do,
   and that the program can send what it reads to its own model provider.
2. Add: "Add program" asks for a name and an access. The app shows the setup text once: the
   command that starts the helper, and the access key. "Copy" copies it. After the dialog closes,
   the app never shows the key again.
3. Use: the outside program calls the tools of the helper (see "Tools"). The row of the entry shows
   the time it was last used.
4. New key: "Make a new key" shows a new setup text. The old key stops at once.
5. Change access: the user changes "Read" and "Read and send work" on the row. It counts from the
   next call.
6. Remove: after a confirm. The key stops at once. Tasks that the program started go on, as tasks
   of their agents. The user can stop them.
7. Turn off: the switch "Allow outside programs" off stops every key at once. The entries stay.
   On again, the same keys work.

## Tools

With the access "Read":

- **List agents**: for each agent that is not archived, the name, the role line and the state.
- **List channels**: for each channel that is not archived, the name, the topic and the members.
- **List tasks**: the newest 50 tasks, with filters for agent and state: the agent, the label, the
  source, the state and the times (005).
- **Read a task**: the prompt, the state, the reason of a failure, the reply text, and the usage
  (005).
- **Read messages**: a page of at most 50 messages of one direct chat or channel, the newest first,
  with the name of who wrote each one and its time. It gives the text of messages only. Files show
  as names. It gives no tool card, no thinking and no content of an approval or question card.
  Text that looks like a secret is hidden (014).
- **Search messages**: the same search as the search field (001), at most 50 hits.

With the access "Read and send work", also:

- **Send a message**: a message to the direct chat of one agent or to one channel, at most 100000
  characters. It goes the same way as a message of the user (003, 004), with one difference: it
  never joins a running turn. When the agent works, the message waits and starts its own turn. The
  waiting message is not in the queue of the user (003). It has no "Send now" and no edit, and it
  never merges with messages of the user. It
  shows in the place with the mark "Sent by <program name>". It returns the task that it started.
- **Wait for a task**: waits until the task ends, waits for the user, or 10 minutes pass. It
  returns the state ("Still running" after 10 minutes, "Waits for the user", or the final state)
  and, when the task ended, the reply text.
- **Stop a task**: stops a task that this program started, as Stop does (005).

## States

- Off: the page shows the switch and one muted line. The helper answers each call with "Outside
  programs are off in ROBot."
- ROBot does not run: the helper answers each call with "ROBot is not running."
- A wrong or old key: the helper answers "This key is not valid." The entry does not change.
- A task waits for an approval: "Wait for a task" returns "Waits for the user". The card shows to
  the user on the computer and on the phone, as for any task (007, 011).

## Rules

- No tool can answer an approval or a question, change a permission level or a rule, change an
  agent, a channel, a routine, a workflow or a setting, delete anything, or read a key, a saved
  secret (020), memory (008), knowledge (016), the handbook (002), or the action log (007).
- A turn that a message of an outside program starts holds outside content from its start (007,
  "Outside content"). The source is the name of the program. So guarded steps ask, and at "Ask
  when unsure" every checked step asks.
- Such a turn holds the program mark (007). In a turn with the program mark, every guarded step
  (007), for example a change of settings or a save to memory, asks the user, also at "Full
  access". At "Read only", the steps that "Read only" refuses stay refused. The program mark goes
  to later turns of the same chat, to forks, to the parts of a job, and to a message that the
  agent sends to another agent, until the user clears it (007, "The mark of a place"). A hit of
  "search chats", or a result of "read chat", that holds a message of an outside program gives the
  program mark too.
- A task of an outside program has depth 0 (005).
- A job that an outside program sends to a channel holds outside content and the program mark in
  every part (007).
- The helper reaches ROBot on this computer only. ROBot offers no network address for it. The way
  between the helper and ROBot is open only to the user of the system who runs ROBot.
- The helper answers in English, because its reader is a program. The settings page is in the
  language of the app.
- An entry belongs to one profile (022). Its helper reaches that profile, also when it is not open.
- A server holds at most 10 entries. One entry makes at most 60 calls in one minute. A call over
  the limit gets "Too many calls. Try again in a minute." and changes nothing.
- The Tasks page (005) shows the source "outside program" with the name of the program, and has it
  in the source filter.
- The app writes a log of outside programs (014): the time, the entry, the tool, the place or task,
  and the result. It holds no message text and no key. It keeps 90 days.
- Entries and keys are local. They do not sync (019). An export (014) holds no entry and no key.
  An import of data brings no entry back.
- Only the computer shows this part of settings. A linked device (012) and the phone (011) do not
  show it, and cannot turn it on. A message of an outside program shows on them with its mark.
- An agent on a vendor runtime (006) gets the work of an outside program in the same way as other
  work.

## Surfaces

- Ways in: Settings, Outside programs, only. Ways out: remove an entry, make a new key, or turn the
  switch off.
- Seeing the state: the row shows the access and the time last used. The mark "Sent by <program
  name>" shows on each message, and the Tasks page shows the source.
- Devices: the computer only, as said in "Rules".

## Out of scope

- An address on the network for the helper.
- Creating or changing agents, channels, routines or workflows from an outside program.
- Answers to approvals and questions from an outside program.
- MCP resources and prompts. The helper offers tools only.

## Acceptance

- With the switch off, a call of "List agents" gets "Outside programs are off in ROBot."
- Add a program with "Read". Its key lists the agents and reads the messages of a chat. "Send a
  message" is refused with the reason, and nothing is sent.
- Change the access to "Read and send work". "Send a message" to an agent: the message shows in
  the chat with "Sent by <program name>", and a task with the source "outside program" starts.
  "Wait for a task" returns the reply text when the turn ends.
- The agent of that turn tries to change its own instructions: an approval card shows with "This
  turn holds outside content" and the name of the program, also at "Full access".
- The agent of that turn saves a fact to memory with "Save at once": an approval card shows with
  "This turn holds outside content".
- The agent works on a turn of the user, and the program sends a message: the message waits, and
  it starts its own turn when the first turn ends.
- Remove the entry: its key gets "This key is not valid.", and a task that it started goes on.
- "Stop a task" on a task that the user started is refused with the reason.
- "Wait for a task" on a turn that runs for 11 minutes returns "Still running" after 10 minutes.
- Quit ROBot: a call gets "ROBot is not running."
- Add 10 entries: "Add program" is off, with the reason.
- The Tasks page filter "outside program" lists the task. The phone shows the message with the mark
  "Sent by <program name>".
- A task of the program waits for an approval. "Wait for a task" returns "Waits for the user". No
  tool of the helper can answer the card.
- Make a new key: the old key gets "This key is not valid.", and the new key works.
- 61 calls in one minute: the 61st gets "Too many calls. Try again in a minute."
- Export the data: the archive holds no entry and no key.
- A second profile does not see the entries of the first, and a key of the first does not reach the
  second.
