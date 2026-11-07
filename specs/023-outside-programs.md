# 023 Outside programs

## Purpose

The user works in another program on the same computer, for example a coding assistant in a
terminal or an editor. That program can read what the workflows of ROBot did and talk to a workflow
in its chat, through MCP (Model Context Protocol, an open standard). It cannot answer approvals,
change settings, or delete anything. A workflow that it makes waits for the user to allow it (037).

## Concepts

- **Outside program**: an entry that the user adds. It has a name (1 to 40 characters, unique,
  case ignored), an access ("Read", "Read and send work", or "Read, send work and manage"), an access
  key, the date it was made,
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
5. Change access: the user picks one of the three accesses on the row. It counts from the
   next call.
6. Remove: after a confirm. The key stops at once. A turn or a run that the program started goes
   on. The user can stop it.
7. Turn off: the switch "Allow outside programs" off stops every key at once. The entries stay.
   On again, the same keys work.

## Tools

With the access "Read":

- **List workflows**: for each workflow, the name, the state of the last run, the state of the
  check, and the number of nodes (010, 037).
- **List tasks**: the newest 50 tasks, with filters for workflow and state: the workflow, the node,
  the source, the state and the times (005).
- **Read a task**: the node, its input, the state, the reason of a failure, the result, and the
  usage (005).
- **Read messages**: a page of at most 50 messages of the chat of one workflow (its main thread),
  the newest first, with the name of who wrote each one and its time. It gives the text of
  messages only. Files show as names. It gives no tool card, no thinking and no content of an
  approval or question card. Text that looks like a secret is hidden (014).
- **Search messages**: the same search as the search field (001), at most 50 hits.

With the access "Read and send work", also:

- **Send a message**: a message to the chat of one workflow (its main thread, 003), at most 100000
  characters. It goes the same way as a message of the user (003), with one difference: it never
  joins a running turn. When the responsible document works, the message waits and starts its own
  turn. The waiting message is not in the queue of the user (003). It has no "Send now" and no
  edit, and it never merges with messages of the user. It shows in the chat with the mark "Sent by
  <program name>". It returns a number for the message. A message can carry an id of at most 200
  characters and a subject of 1 to 100 characters. A message with an id that the program used
  before starts no second turn (038, "Duplicates"). A message with a subject waits behind the work
  of the same subject (038, "One at a time for one subject"). A message with no id and no subject
  works as before.
- **Wait for a reply**: waits until the reply to a message ends, the turn waits for the user, or 10
  minutes pass. It returns the state ("Still running" after 10 minutes, "Waits for the user", or
  "Done") and, when the reply ended, the reply text.
- **Stop a turn**: stops a turn that this program started, as Stop does (003). It does not stop a
  run.

With the access "Read, send work and manage", also the manage tools (037): read a workflow, make a
workflow, and wait for a request. Each change is a request that the user allows. The program
cannot allow it.

## States

- Off: the page shows the switch and one muted line. The helper answers each call with "Outside
  programs are off in ROBot."
- ROBot does not run: the helper answers each call with "ROBot is not running."
- A wrong or old key: the helper answers "This key is not valid." The entry does not change.
- A turn that a message started waits for an approval: "Wait for a reply" returns "Waits for the
  user". The card shows to the user on the computer and on the phone, as for any card (007, 011).

## Rules

- A tool can make a workflow only through a request that the user allows (037), and only with the
  access "Read, send work and manage".
- No tool can answer an approval or a question, change a permission level or a rule, change a
  workflow that exists or a setting, delete anything, or read a key, a saved secret (020), memory
  (008), knowledge (016), or the action log (007). No tool starts a run (see the questions for
  023).
- A turn that a message of an outside program starts holds outside content from its start (007,
  "Outside content"). The source is the name of the program. So guarded steps ask, and at "Ask
  when unsure" every checked step asks.
- Such a turn holds the program mark (007). In a turn with the program mark, every guarded step
  (007), for example a change of the graph or a save to memory, asks the user, also at "Full
  access". At "Read only", the steps that "Read only" refuses stay refused. The program mark goes
  to later turns of the same chat, to its threads and forks, and to a task whose input comes from a
  task that held it, until the user clears it (007, "The mark of a place"). A hit of "search
  chats", or a result of "read chat", that holds a message of an outside program gives the
  program mark too.
- Each message of an outside program makes one event on the tab "Events" (038). A message with an
  id that the program used before starts no second turn (038, "Duplicates").
- The helper reaches ROBot on this computer only. ROBot offers no network address for it. The way
  between the helper and ROBot is open only to the user of the system who runs ROBot.
- The helper answers in English, because its reader is a program. The settings page is in the
  language of the app.
- An entry belongs to one profile (022). Its helper reaches that profile, also when it is not open.
- A server holds at most 10 entries. One entry makes at most 60 calls in one minute. A call over
  the limit gets "Too many calls. Try again in a minute." and changes nothing.
- The app writes a log of outside programs (014): the time, the entry, the tool, the workflow or
  task, and the result. It holds no message text and no key. It keeps 90 days.
- Entries and keys are local. They do not sync (019). An export (014) holds no entry and no key.
  An import of data brings no entry back.
- Only the computer shows this part of settings. A linked device (012) and the phone (011) do not
  show it, and cannot turn it on. A message of an outside program shows on them with its mark.
- The model that answers in the chat may be on a vendor runtime (006). It gets the message of an
  outside program as it gets any message of the chat.

## Surfaces

- Ways in: Settings, Outside programs, only. Ways out: remove an entry, make a new key, or turn the
  switch off.
- Seeing the state: the row shows the access and the time last used. The mark "Sent by <program
  name>" shows on each message, and the tab "Events" shows each message (038).
- Devices: the computer only, as said in "Rules".

## Out of scope

- An address on the network for the helper.
- Changing a workflow that exists from an outside program. A manage request makes a new workflow
  only (037).
- Starting a run from an outside program (see the questions for 023).
- Answers to approvals and questions from an outside program.
- MCP resources and prompts. The helper offers tools only.

## Acceptance

- With the switch off, a call of "List workflows" gets "Outside programs are off in ROBot."
- Add a program with "Read". Its key lists the workflows and reads the messages of a chat. "Send a
  message" is refused with the reason, and nothing is sent.
- Change the access to "Read and send work". "Send a message" to a workflow: the message shows in
  its chat with "Sent by <program name>", and the responsible document starts a turn. "Wait for a
  reply" returns the reply text when the turn ends.
- The turn of that message tries to change the graph of the workflow: an approval card shows with
  "This turn holds outside content" and the name of the program, also at "Full access".
- The turn of that message saves a fact to memory with "Save at once": an approval card shows with
  "This turn holds outside content".
- The responsible document works on a turn of the user, and the program sends a message: the
  message waits, and it starts its own turn when the first turn ends.
- Remove the entry: its key gets "This key is not valid.", and a turn that it started goes on.
- "Stop a turn" on a turn that the user started is refused with the reason.
- "Wait for a reply" on a turn that runs for 11 minutes returns "Still running" after 10 minutes.
- Quit ROBot: a call gets "ROBot is not running."
- Add 10 entries: "Add program" is off, with the reason.
- The phone shows the message with the mark "Sent by <program name>". The tab "Events" shows one
  event for the message.
- A turn that a message started waits for an approval. "Wait for a reply" returns "Waits for the
  user". No tool of the helper can answer the card.
- Make a new key: the old key gets "This key is not valid.", and the new key works.
- 61 calls in one minute: the 61st gets "Too many calls. Try again in a minute."
- Export the data: the archive holds no entry and no key.
- A second profile does not see the entries of the first, and a key of the first does not reach the
  second.
- Set the access to "Read, send work and manage". "Make a workflow" returns "Waits for the user".
  No tool of the helper can allow the request (037).
- A message of a program says "Node 2 is too long." during a run: it is not feedback, and the run
  does not change (003).
