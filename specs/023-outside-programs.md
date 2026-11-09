# 023 Outside programs

## Purpose

The user works in another program on the same computer, for example a coding assistant in a
terminal or an editor. That program can read what the workflows of ROBot did and talk to a workflow
in its chat, through MCP (Model Context Protocol, an open standard). It cannot answer approvals,
change settings, or delete anything. A workflow that it makes waits for the user to allow it (037).
A message that it sends starts a turn of the responsible document that the user did not start.
That turn has none of the tools of the chat (007, 010), under the rules of 007 (see "Rules").

## Concepts

- **Outside program**: an entry that the user adds. It has a name (1 to 40 characters, unique,
  case ignored), an access ("Read", "Read and send work", or "Read, send work and manage"), an access
  key, the date it was made,
  and the time it was last used.
- **Helper**: a small program that comes with ROBot. The outside program starts it as an MCP server
  of the kind "program on this computer". The helper talks only to ROBot on this computer.
- **Access key**: a secret that tells ROBot which entry calls. It is in the secrets file
  (014).

## Flows

1. Turn on: in Settings, Outside programs (013), the switch "Allow outside programs" is off by
   default. When the user turns it on, the page says what an outside program can and cannot do,
   and that the program can send what it reads to its own model provider.
2. Add: "Add program" asks for a name and an access. The app shows the setup text once: the
   command that starts the helper, and the access key. "Copy" copies it. After the dialog closes,
   the app never shows the key again.
3. Use: the outside program calls the tools of the helper (see "Tools"). The row of the entry shows
   the time it was last used.
4. New key: "Make a new key" shows a new setup text. The old key stops at once when the new
   key is saved (see 014).
5. Change access: the user picks one of the three accesses on the row. It counts from the
   next call.
6. Remove: after a confirm. The key stops at once when the entry is removed (see 014). A
   turn that a message of the program started goes on. The user can stop it.
7. Turn off: the switch "Allow outside programs" off stops every key at once. The entries stay.
   On again, the same keys work.

## Tools

With the access "Read":

- **List workflows**: for each workflow, the name, the state of the last run, the state of the
  check, and the number of nodes (010, 037).
- **List tasks**: the newest 50 tasks, with filters for workflow and state: the workflow, the node,
  the source, the state and the times (005).
- **Read a task**: the node, its input, the state, the reason of a failure, the result, and the
  usage (005). Text that looks like a secret is hidden (014).
- **Read a run**: one run of one workflow. It is the run that works now or, when none works, the
  newest run. The program can name an earlier run by the time it started, as the list of runs shows
  it (010). It gives:
  - the state of the run, with the words of 005 and of the run view (010);
  - for each node of the graph, the name and the state of its task, with the words of 005, or
    "skipped", or "not reached" when the run has not reached the node and it has no task; which
    node works; and how many nodes have ended;
  - for each task that waits for the user, the reason only, with the words of 005: "Waits for
    your approval", "Waits for your answer", or "Waits for your pick" (a decision node found no
    winner, 010). It gives no step, no question and no option: the card is for the user, as in
    "Read messages";
  - when the run failed, was cancelled or was stopped, the reason that the run view shows (007,
    "Following a run in the chat"): the node that failed and the reason of 005, for example "The
    app stopped" or "Step limit reached (N).", a step that was refused, or "Stopped by you";
  - the result of each node that has ended. It gives no result of a node that has not ended.
    A result of a task that held outside content shows with the mark "Holds outside content" and the
    first source (007). Files show as names. Text that looks like a secret is hidden (014).

  "Read a run" changes nothing. It asks for no approval and adds no event. When the workflow has no
  run, it returns "This workflow has no run yet."
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
  before (in the 7 days of 038) starts no second turn, and the call returns the number of the first
  message with that id (038, "Duplicates"; see the questions for 023). A message with a subject waits behind the work
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
- A turn that a message started waits for the user: "Wait for a reply" returns "Waits for the
  user". With the choice for now the turn has no tool, so it has no card. If a card exists, it
  shows to the user on the computer and on the phone, as for any card (007, 011).

## Rules

- A tool can make a workflow only through a request that the user allows (037), and only with the
  access "Read, send work and manage".
- The tools of an outside program start no run. They change no workflow that exists. No tool can
  answer an approval or a question, change a permission level or a rule, change a setting, delete
  anything, or read a key, a saved secret (020), memory (008), knowledge (016), or the action log
  (007).
- The turn that a message starts is not a tool. It is a turn of the responsible document (003)
  that the user did not start. The tools of the chat work only in a turn that the user started in
  the chat of the workflow (007, "Who may use them"; 010, "Assistant"). So this turn has none of
  them: it cannot change the graph, a node or a prompt, start a run, read the state or a result of
  a run, list workflows, search or read chats, or add feedback. It answers in words. It saves no
  memory. A program that wants one of these things does it with the tools of the helper, within
  its access (see "Tools"), or asks the user. Whether such a turn may use the tools of the chat is
  not decided (see the questions for 023). Until then this turn uses none, the safer reading.
- A message of an outside program is never feedback (003, 007). It adds nothing to a run.
- A turn that a message of an outside program starts holds outside content from its start (007,
  "Outside content"). The source is the name of the program. So guarded steps ask, and at "Ask
  when unsure" every checked step asks.
- Such a turn holds the program mark (007). In a turn with the program mark, every guarded step
  of 007 asks the user, also at "Full access". The card says "This turn holds outside content" and
  names the program. At "Read only", the steps that "Read only" refuses stay refused. This holds
  for a later turn of the user in the same chat, where the tools of the chat work, and for the
  turn of the message if the open row gives it a tool. The program mark goes
  to later turns of the same chat, to its threads and forks, and to a task whose input comes from a
  task that held it, until the user clears it (007, "The mark of a place"). A hit of "search
  chats", or a result of "read chat", that holds a message of an outside program gives the
  program mark too.
- Each message of an outside program makes one event on the tab "Events" (038). A message with an
  id that the program used before starts no second turn, and the call returns the number of the
  first message (038, "Duplicates").
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
- In the states of 014, calls, "Add program", "Make a new key" and "Remove" follow
  014. When Locked or Damaged the page shows "Cannot read the vault." with Retry. A call
  fails with that reason. "Add program", "Make a new key" and "Remove" are refused. In
  Missing key, an entry shows that its access key is missing, and the user makes a new key.
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
- A tool of an outside program that changes a workflow that exists. A manage request makes a new
  workflow only (037). The turn that a message starts has no tool of the chat that could change
  one (see "Rules").
- A tool of an outside program that starts a run. The turn that a message starts has no tool of
  the chat that could start one (see "Rules" and the questions for 023).
- Answers to approvals and questions from an outside program.
- MCP resources and prompts. The helper offers tools only.

## Acceptance

- With the switch off, a call of "List workflows" gets "Outside programs are off in ROBot."
- Add a program with "Read". Its key lists the workflows and reads the messages of a chat. "Send a
  message" is refused with the reason, and nothing is sent.
- Change the access to "Read and send work". "Send a message" to a workflow: the message shows in
  its chat with "Sent by <program name>", and the responsible document starts a turn. "Wait for a
  reply" returns the reply text when the turn ends.
- A message of the program asks the responsible document to change the graph, to save a fact to
  memory, or to start a run: the turn changes nothing, saves nothing and starts nothing, and no
  card shows. The reply is words only.
- After that message, the user writes in the same chat, at "Full access", and asks for a change of
  the graph: an approval card shows with "This turn holds outside content" and the name of the
  program, because the chat holds the program mark.
- The responsible document works on a turn of the user, and the program sends a message: the
  message waits, and it starts its own turn when the first turn ends.
- Remove the entry: its key gets "This key is not valid.", and a turn that it started goes on.
- "Stop a turn" on a turn that the user started is refused with the reason.
- "Wait for a reply" on a turn that runs for 11 minutes returns "Still running" after 10 minutes.
- Quit ROBot: a call gets "ROBot is not running."
- Add 10 entries: "Add program" is off, with the reason.
- The phone shows the message with the mark "Sent by <program name>". The tab "Events" shows one
  event for the message.
- No tool of the helper can answer a card of the user.
- Make a new key: the old key gets "This key is not valid.", and the new key works.
- 61 calls in one minute: the 61st gets "Too many calls. Try again in a minute."
- Export the data: the archive holds no entry and no key.
- A second profile does not see the entries of the first, and a key of the first does not reach the
  second.
- Set the access to "Read, send work and manage". "Make a workflow" returns "Waits for the user".
  No tool of the helper can allow the request (037).
- A message of a program says "Node 2 is too long." during a run: it is not feedback, and the run
  does not change (003).
- A message of the program sends a second call with the same id: no second turn starts, and the
  call returns the same number as the first call.
- A run of 3 nodes works on node 2. "Read a run" gives the state of the run, "node 2 works", the
  result of node 1, and node 3 as "not reached". It gives no result of node 2 or node 3.
- A task of the run waits for an approval: "Read a run" gives "Waits for your approval" and no
  step. For a question card it gives "Waits for your answer" and no question. For a decision node that found no
  winner it gives "Waits for your pick".
- A node failed: "Read a run" gives the state of the run, the node, and the reason of 005. After a
  stop by the user it gives "Stopped by you". After a restart of the app it gives "The app stopped".
- A result holds a text that looks like a key: "Read a run" and "Read a task" show it hidden. A
  result of a task that held outside content shows with the mark "Holds outside content".
- "Read a run" with the access "Read" works. It changes no state, shows no card and adds no event.
  A workflow with no run gets "This workflow has no run yet."
