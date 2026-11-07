# 028 Chat bridge

## Purpose

The user talks to the responsible document of one workflow from a Microsoft Teams chat. This helps
when the user is away from the Mac and has Teams on a phone. A turn that a Teams message starts is
not a turn that the user started in the app, so it has none of the tools of the chat (007, 010; see
the questions for 023 and 028). It answers in words. The app reads the chat in a Teams page where
the user signed in by hand. It gives each message of an allowed sender to the chat
of the workflow, and it writes the answer in the same Teams chat. It needs no app registration with
a company.

The link is off until the user turns it on. A Teams message is outside content (007). It gives no
permission, it changes no rule, and it answers no approval or question. It is never feedback on a
run (003). The user gives feedback in the chat of the workflow in the app.

## Concepts

- **Teams link**: the one link between a Teams chat and a target. A profile (022) has at most one.
  Its fields:
  - **Target**: the chat of one workflow (its main thread, 003). The workflow exists.
  - **Chat title**: 1 to 100 characters. The title of the Teams chat must hold this text.
  - **Kind of chat**: "A chat with one person" (this includes the chat with oneself) or "A group
    chat".
  - **Allow list**: the names of the senders that get an answer. 1 to 20 names of 1 to 80
    characters.
  - **Bot list**: the names of senders that never get an answer. 0 to 20 names.
  - **Call text**: 0 to 40 characters, for example "@ROBot". A group chat needs it.
  - **Marker**: the text at the start of every message that the app writes. 1 to 20 characters.
    At first it is "[ROBot]".
  - The **switch** and the **state** (see "States and errors").
- **Name**: the name of a sender as the Teams page shows it. Two names are the same when they are
  equal after the app removes spaces at both ends, joins runs of spaces and ignores letter case.
- **Teams page**: a page of the app that shows Microsoft Teams on the web. It is hidden. The user
  can show it to sign in or to solve a prompt of Teams, and hide it again.
- **Sign-in profile**: a browser profile (a named set of saved sign-ins on this computer) that the
  app makes for the link. It holds the sign-in of the Teams page. No node can get it: the browser
  of a workflow (007) does not use it, and a request to give it is refused. Settings, Browser
  lists it with "Used by the Teams link", with no rename and no delete. It does not count in the
  limit of browser profiles.
- **Baseline read**: a read that marks every message now in the chat as read and answers none.

## Flows

1. Set up: Settings, Teams (013). The page shows "Page text" and the button "Set up". The user
   does these steps in any order.
   1. Sign in: "Sign in to Teams" shows the Teams page. The user signs in by hand. The app does not
      read or store the password. It only sees if the page shows Teams or a sign-in form.
   2. Target: the user picks the workflow. A muted line says that a message from Teams talks to
      the responsible document of that workflow, and that such a message changes nothing in the
      workflow.
   3. Chat: the user opens the chat in the Teams page and presses "Use this chat". The app reads
      the title of the open chat and fills the field "Chat title". The user may shorten it. The
      user picks the kind of chat.
   4. Lists: the user types the allow list, the bot list and the call text.
   5. Turn on: the switch "Teams link". It stays off until steps 1 to 4 are complete. A dialog
      repeats three facts of "Page text" and has "Turn on" and "Back".
2. Run: while the switch is on, the app loops. It opens the linked chat by its title. Every 3
   seconds it reads the new messages, in the order that the chat shows them. It applies "Who may
   call" to each one. A call becomes work (see "Work from a message"). When that work ends or
   needs the user, the app makes an answer for the outbox (see "Answers and the outbox").
3. Ask about a run: the user writes in Teams, for example "How far is the run?". The turn has no
   tool of the chat to read a run (007, "Following a run in the chat"), so the reply says that the
   state of a run shows in the app. A question starts no run and changes nothing. Whether a turn
   from Teams may read a run is not decided (see the questions for 023 and 028).
4. Other controls, all in Settings, Teams:
   - Turn off: the app stops reading and sending, empties the outbox and closes the Teams page.
     Work that runs goes on in the app. The sign-in stays.
   - "Sign out of Teams": after a confirm, it deletes the saved sign-in and turns the link off.
   - "Remove link": after a confirm, it deletes the link and the sign-in profile.
   - "Resume": a paused link starts again with a baseline read.
   - "Show the Teams page" and "Hide the Teams page". While the page shows, the app reads but does
     not send. The answers wait.
   - A change of a field: the target, the chat title, the kind of chat and the marker change only
     while the switch is off. The lists and the call text change at any time and count from the
     next read.

## Page text

The page says these things in plain words, before "Set up":

- What the link does, in two sentences.
- The text of the conversation passes through the service of Microsoft: the messages of the user
  and the answers of the responsible document. An answer can hold text that the chat holds, for
  example the results of nodes.
- A rule of the company, or of Microsoft, can forbid this use of an account. The user checks the
  rules first.
- The app reads no password. The sign-in stays on this computer. It gives access to the account,
  so it is a secret.
- Teams shows the name that a person sets. Another person can use the same name. So the allow list
  is not proof of who writes.
- A message from Teams gives no permission. A card can be answered only in the app or on a linked
  device. Feedback on a run is given in the app.
- The app reads the chat in a Teams page. So Teams may count the messages as read, and may show the
  user as online, while the link is on.
- Two computers that link the same chat both answer each message.
- The user can turn the link off at any time.

The dialog of "Turn on" repeats the second, third and sixth facts.

## Rules and limits

### Events of a link

- Each message of Teams that the app answers makes one event on the tab "Events" (038), with the
  source "Teams", the name of the chat in its summary line, and the result. The text of the message
  is outside content (007), as it is for the turn that the message starts.
- The tab shows the events of this computer only, so a message that another computer answered
  shows there.

### Who may call

The app answers a message only when all of these are true, in this order:

1. The message does not start with the marker, after the spaces at its start are removed. The app
   never reads its own text.
2. The message has text. A file, a picture or a card alone gets no answer.
3. The sender has a name.
4. The name is on the allow list and is not on the bot list. The bot list wins.
5. The message calls the app: it holds the call text (letter case is ignored). When the call text
   is empty and the kind is "A chat with one person", every message calls the app.
6. Some text is left after the app takes out the first call text.

- The lists and the call text come only from the link. The text of a message cannot change them.
- A message that fails a check gets no answer and no line in Teams. The link log (014) records the
  reason, with no name and no text.
- A message is read once. An edit of a message that was read, a reload of the Teams page and a
  delete after the read start no new work. A message that was deleted before the read is never
  read. Two messages with the same text, sender and time are two messages.
- At most 10 calls start work in one minute. A call over the limit starts no work, and Teams gets
  one line: "Too many messages. Try again in a minute." At most one such line goes out each minute.

### Work from a message

- The responsible document gets the text with the first call text taken out, and the name of the
  sender. The message shows in the chat of the workflow with the mark "From Teams" and the name of
  the sender.
- The message starts a turn of the chat (003). It is not a node and not a task (005). It starts no
  run.
- The tools of the chat work only in a turn that the user started in the chat (007, "Who may use
  them"; 010, "Assistant"). A turn that a Teams message starts is not such a turn (038 says the
  same). So it has none of them: it cannot change the graph, a node or a prompt, start or stop a
  run, read a run, list workflows, search or read chats, or add feedback. It saves no memory. It
  answers in words. This is the same rule as for a message of an outside program (023). Whether
  such a turn may use the tools of the chat is not decided (see the questions for 023 and 028).
  Until then this turn uses none, the safer reading.
- A turn in the chat that such a message starts holds outside content (007) from its start, with
  the source "Teams", and holds the program mark (007). If the open question gives the turn a
  tool, every guarded step of 007 asks, also at "Full access". The mark stays with the chat (007):
  until the user clears it, a later turn of the user in the app holds outside content too, and a
  guarded step there asks, also at "Full access".
- A Teams message is never feedback (003). When it reads as feedback on a result, the responsible
  document says that feedback is given in the app, and adds nothing to the run.
- A Teams message never answers a card. While an approval or a question waits, a message that says
  "yes" or "allow" starts its own work and waits behind.
- The message goes to the main thread as a message of the user, with its mark. It never joins a
  running turn. When the responsible document works, the message waits and starts its own turn. It
  is not in the message queue of the user (003), has no "Send now" and no edit, and never merges
  with messages of the user. When 20 messages of Teams already wait for the chat of the workflow,
  no turn is made, and Teams gets the line "<name> has 20 messages that wait. Try again later."
- Only work that a Teams message started sends text to Teams. Other work stays in the app. A run
  that ends, a node that fails and a proposal that waits send nothing to Teams. The notices of 015
  tell the user in the app.
- No tool of the responsible document or of a node reads or changes the link (037).

### Answers and the outbox

Every answer starts with the marker and one space. It is plain text: the app does not turn
Markdown into Teams formatting. In a line below, <name> is the name of the workflow. The lines are
in the language of the app.

- **Done**: the reply text of the turn: the words of the responsible document, with no tool card
  and no thinking. For a question about a run, the reply is the answer of the responsible document
  (003). When the reply has files or pictures, one more line says "The reply has N files or
  pictures. Open them in ROBot." A done turn with no words sends "Done. There is no reply text."
- **Failed**: "<name> could not finish: <reason>". The reason is cut at 300 characters.
- **Stopped**: "<name> was stopped."
- **Waiting line**: when an approval or a question of a turn of the chat holds back a turn that a
  Teams message started, or holds back a new Teams message: "<name> waits for you in ROBot. Open
  the app to answer." It holds no text of the step or of the question. One line goes out for each
  card.
- The app replaces text that looks like a secret (014) with "[redacted]" before it makes the answer.

The outbox:

- Answers go out in the order in which the app made them. A text over 4,000 characters (the marker
  counts) is split into messages at a line break or a space when possible. Each message starts with
  the marker. One answer is at most 5 messages. The app cuts a longer text, and the last message
  ends with "The rest is in ROBot."
- At most 20 messages go out in one minute. The rest wait. The outbox holds 50 messages. An answer
  that finds it full is dropped with the record "Outbox full".
- Before each try, the app opens the linked chat if it is not open, and reads its title.
  - The title holds the chat title of the link: the app sends the message.
  - No title is found, or the page does not take the message: the try failed. The app tries again
    after 5 seconds, then after a time that doubles each try, up to 5 minutes. A message holds back
    the later messages until it has failed 3 tries in a row. Then the link records a problem and
    the later messages go out. The message goes on to be tried. After 1 hour it is dropped with the
    record "Not sent".
  - The title is another title: the message is dropped at once with the record "Wrong chat". The
    app never sends it again, and it types nothing in the other chat.
- When the link is off, paused or signed out, or the target is missing, no answer is made. The
  work that ends then gets a record. A turn-off, a pause and a sign-out empty the outbox, and each
  message in it gets a record.
- The outbox is in memory. A restart drops it. A turn that the restart stopped gets no answer in
  Teams. The chat shows that the restart stopped the request (003, "Rules").
- **Records**: Settings, Teams lists the newest 50: the time, the reason ("Wrong chat", "Not sent",
  "Outbox full", "Link off", "Link paused", "Signed out"), the place, and a link to the message in
  the chat. A record holds no text of a message.

### Starts and gaps

- The first read after the switch on, a resume, a sign-in after "Signed out", and the start of the
  app is a baseline read. So is the first read after the state Offline.
- If more than 2 minutes pass between two finished reads, the next read is a baseline read. This
  happens after a sleep of the computer. While the computer is off or asleep, nothing is read.
  After a wake, the baseline read runs at once. A message that arrives after it gets an answer.
- When a baseline read after a gap skips a message that would have been a call, Teams gets one
  line: "ROBot did not read this chat for a while. Messages from that time got no answer. Send them
  again." No line goes out at a start of the link.

### Limits

| What | Limit |
| --- | --- |
| Links | 1 in a profile |
| Names in a list | 20 in the allow list, 20 in the bot list, 80 characters each |
| Chat title, call text, marker | 100, 40 and 20 characters |
| Read | every 3 seconds |
| Calls | 10 in one minute |
| Messages that wait for one chat | 20 |
| Messages to Teams | 4,000 characters each, 20 in one minute |
| One answer | 5 messages |
| Outbox | 50 messages |
| Tries to send | after 5 seconds, then doubling up to 5 minutes. Later messages wait for 3 failed tries. Drop after 1 hour |
| Pause | 20 failed reads in a row, or 6 failed tries to send in a row |
| Gap | more than 2 minutes between two finished reads |
| Waits | Connecting, 60 seconds at most. Chat not found and Offline look again every 30 seconds |
| Reason in a line | 300 characters |
| Records | the newest 50 in Settings. The link log keeps 90 days |

## States and errors

The state shows in Settings, Teams, with the time of the last read. It shows again after a
restart.

| State | When | What the user sees | What the app does |
| --- | --- | --- | --- |
| Off | The switch is off | The switch and the form | Reads and sends nothing. No Teams page runs |
| Connecting | After a start, at most 60 seconds | "Connecting to Teams" | Opens the page and the chat, makes the baseline read. After 60 seconds it shows the state that fits |
| On | The chat is open and the reads work | "Reading <chat title>. Last read <time>." | Runs the loop |
| Signed out | The page shows a sign-in form | "Sign in to Teams to go on" and the button "Sign in" | Reads and sends nothing, empties the outbox. After a sign-in it starts with a baseline read |
| Chat not found | No chat holds the title, or more than one does | "No chat found with this title" or "More than one chat has this title" | Sends nothing. Looks again every 30 seconds |
| Offline | The page cannot reach Microsoft | "Teams cannot be reached" | Tries again every 30 seconds. This does not count for a pause |
| Paused | A repeated failure | "Paused after repeated failure", the reason, and "Resume" | Reads and sends nothing, empties the outbox |
| Target missing | The workflow is deleted | "The target is not available" | Reads and sends nothing. The user turns the switch off, picks another target, and turns it on |

- **Repeated failure**: the link pauses itself when 20 reads in a row fail, or when 6 tries to send
  in a row fail. A read fails when the page cannot be read, for example when Teams changed its page.
  The reasons read "The app cannot read the Teams page" and "Teams does not take the messages". A
  good read or a good send sets its count to 0. "Signed out", "Chat not found" and "Offline" are
  not failures.
- One notification "Teams link needs you" goes out (015) when the state becomes Signed out or
  Paused, once for each change. It does not go out when the user turned the link off.
- The switch refuses with a reason under the field, when there is no sign-in, no target, an empty
  chat title, an empty allow list, no call text for a group chat, or a text over its limit. A name
  in both lists is kept, and a muted line says that the bot list wins.
- A failure of the link never stops a run or another feature of the app.

## Interface text

The implementer writes every text in English and Korean (013). The words below are the intent. The
interface says "Teams link", not "bridge", and it does not call the sign-in an "account".

| Where | Intent |
| --- | --- |
| Settings part | "Teams", with the nine facts of "Page text" |
| Buttons | Set up, Sign in to Teams, Use this chat, Turn on, Back, Resume, Sign out of Teams, Remove link, Show the Teams page, Hide the Teams page |
| Fields | Target, Chat title, Kind of chat (two choices), Allowed senders, Bots that get no answer, Call text, Marker |
| Header of the chat of the linked workflow | A muted mark "Linked to Teams", with the state word when the state is not On |
| Message | The mark "From Teams" with the sender name |
| States and records | The eight states and the six reasons above |
| Lines in Teams | The lines in quotes in this spec |
| Notification | "Teams link needs you", with the state |
| Settings, Browser | "Used by the Teams link" |

## Surfaces

- Ways in: Settings, Teams, only. The header mark opens it. Ways out: the switch, "Sign out of
  Teams", "Remove link", and "Resume".
- Devices: only the computer shows and changes the link. A linked computer (012) and the phone
  (011) show no settings part. They show "From Teams" on a message. They answer a card as any
  card.
- Runtimes: nothing changes. The responsible document answers with the model that answers in the
  chat of the workflow (003), as for any message.
- Seeing the state: the settings page, the header mark, the notification and the records. All stay
  after a restart, except the outbox.
- Data: the link belongs to one computer and one profile (022). It does not sync (019). An export
  holds no link and no sign-in, and an import brings none back (014). A message from Teams and its
  mark sync with the message, and the sender name is stored with it. The link log (014) holds the
  time, the event, the reason and the place, and no text and no name. It keeps 90 days.
- Words: see `docs/glossary.md`.

## Out of scope

- Another chat service, for example Slack, Discord or Telegram. Each needs its own spec.
- A channel of a Teams team, and its threads. The link reads a chat only.
- Files, pictures, cards, reactions and voice in Teams, in both directions.
- An approval, a question or a permission answered from Teams. A command such as "stop" or "retry"
  from Teams.
- Feedback on a run from Teams, a start or a stop of a run from Teams, and a tool of the chat in a
  turn from Teams (see the questions for 023 and 028).
- A message to Teams that nobody asked for, for example when a run ends or fails. The notices of
  015 do this in the app.
- More than one link in a profile. A setup on the phone.
- An app registration, a bot account, or a Microsoft service for bots.
- A trigger of a workflow from Teams (010). A tool with which a node or the responsible document
  sends to Teams by itself.

## Acceptance

All checks use a fake chat, a stand-in Teams: a page with chats, each with a title and a list of
messages (sender, text, time). It can show a sign-in form, accept a typed message, change the open
chat, drop the network and fail on request. A stand-in clock moves time. A stand-in model gives
set replies and asks for approvals. The checks never call the real Teams.

Examples of "Who may call". The allow list holds "Marta Kim". The bot list holds "Helper Bot". The
chat is a group chat. The call text is "@ROBot".

| Sender | Text | Result |
| --- | --- | --- |
| Marta Kim | "@ROBot how far is the run?" | A turn starts. The responsible document gets "how far is the run?" |
| "marta  KIM" | "@robot hi" | A turn starts. Case and extra spaces do not count |
| Marta Kim | "hello" | Nothing. The text has no call text |
| Joe Lee | "@ROBot hi" | Nothing. Not on the allow list |
| Helper Bot | "@ROBot hi" | Nothing. On the bot list, also when it is on the allow list |
| (no name) | "@ROBot hi" | Nothing |
| Marta Kim | "[ROBot] @ROBot hi" | Nothing. The text starts with the marker |
| Marta Kim | "@ROBot" | Nothing. No text is left |

Checks:

- On a new profile the switch is off, the page text shows, and the stand-in saw no visit. The
  switch stays off, with a reason under the field, while one of these is missing: the sign-in, the
  target, the chat title, a name on the allow list, or the call text of a group chat. "Turn on"
  shows the dialog, and "Back" leaves the switch off.
- The stand-in shows a sign-in form: the state is "Signed out". The user signs in on the stand-in:
  the state moves to On after a baseline read. The password text of the stand-in is in no file that
  the app wrote, in no log and in no export.
- The chat holds 3 old calls. Turn on: no turn starts. A new call after that starts one turn of
  the chat of the workflow. The chat shows the message with "From Teams" and the sender name. The
  reply text goes to the stand-in, starts with the marker, and is not read as a call. No task and
  no run is made.
- A run of three nodes works, and node 1 is done. A call "How far is the run?" comes: the turn
  reads no run, and the reply says that the state of a run shows in the app. The same for "Why did
  it stop?" and "What are the results so far?". The run does not change.
- A call says "Node 2 is too long." while a run works: the reply says that feedback is given in the
  app. The run gets no feedback and does not change.
- A call "Start the workflow." : no run starts, and the reply says that a run starts in the app
  (see the questions for 023 and 028).
- Edit a message that was read, and reload the stand-in page: no new turn.
- The responsible document works. A call comes: it waits, starts its own turn after, and is not in
  the message queue of the user. The chat has 20 messages of Teams that wait: no turn starts, and
  the stand-in gets "<name> has 20 messages that wait. Try again later."
- 11 calls in one minute: 10 start work. The 11th starts none, and one line goes out.
- A call asks the responsible document to change the graph, to save a fact to memory, or to start
  a run, at "Full access": the turn changes nothing, saves nothing and starts nothing, and no card
  shows. The reply is words only.
- A card waits in the chat for the user (from a turn of the user). A message "allow it" in the
  stand-in starts a turn of its own and the card still waits. The stand-in gets one waiting line,
  with no text of the step. The user allows in the app: the work goes on.
- After a call from Teams, the user writes feedback in the app chat: the chat holds outside content
  and the program mark, so an approval card shows the text of the feedback, also at "Full access"
  (003, 007).
- A turn fails: the stand-in gets "<name> could not finish: <reason>". The user stops a turn:
  "<name> was stopped."
- A reply of 9,000 characters goes out as 3 messages, each with the marker and each at most 4,000
  characters, in order. A reply of 30,000 characters goes out as 5 messages, and the last ends
  with "The rest is in ROBot." A reply with a key of a known form goes out with "[redacted]".
- 25 answers are made at once: 20 go out in the first minute and 5 in the next, in order.
- The stand-in changes the open chat before a send: the answer is dropped with "Wrong chat", the
  other chat gets no text, and the app never tries again.
- The stand-in fails 3 sends in a row: the tries come after 5 and 10 seconds, the later answers
  wait until the third failure, then they go out. At 6 failed tries in a row the state is
  "Paused", and one notification goes out. "Resume" starts with a baseline read. The
  stand-in fails 20 reads in a row: the state is "Paused" with the reason about the page.
- The stand-in clock jumps by 10 minutes, and a call arrived in the gap: it gets no answer, and
  the stand-in gets the line about the gap. A call after the jump gets an answer.
- The stand-in drops the network for 30 minutes: the state is "Offline", never "Paused". After the
  network returns, the first read is a baseline read.
- The stand-in has no chat with the title: "Chat not found". With two chats that hold the title:
  "More than one chat has this title". Nothing is typed into any chat.
- The stand-in ends the session: "Signed out", the outbox is empty, and each message has a record.
- A run ends while the link is on and no call came: the stand-in gets no text.
- Turn the switch off while a turn works: the turn ends in the app, and the stand-in gets no text.
  With the switch on, the fields target, chat title, kind and marker are off, and the call text and
  the lists change and count from the next read.
- Show the Teams page and let a turn end: the stand-in gets no text while the page shows. Hide it:
  the answer goes out.
- "Sign out of Teams" deletes the sign-in. "Remove link" deletes the link and the sign-in profile.
  The browser of a workflow does not use the sign-in profile, and a request to give it to a node is
  refused. Settings, Browser lists it with "Used by the Teams link" and no delete.
- Delete the target workflow: the state is "Target missing" and nothing is read.
- A linked computer and the phone do not show the settings part. They show "From Teams" on the
  message.
- A second profile has no link of the first, and the sign-in of the first is not used in it. With
  two computers in sync (019), the link, its lists and its sign-in are on one computer only, the
  message and its mark are on both, and an export holds no link.
- The link log holds the events and the reasons. A search of it finds no message text and no
  sender name.
- Switch the app to Korean: the lines for Teams are in Korean.
- Ask the responsible document in the chat to turn the link off: it does not change it, and says
  where in Settings the user can do it.
