# 003 Workflow chat

## Purpose

The user talks to a workflow in its chat. The responsible document answers. The user builds and
changes the workflow in the chat (010), and sees what the workflow does while it does it. The
responsible document tells the user how far a run has gone and why it stopped or waits. It shows
the results of the nodes that have ended. It takes the feedback of the user on these results while
the run works.

## Concepts

- **Chat**: the one chat of a workflow (010). No other chat talks about the workflow. The
  responsible document of the workflow answers in it (002). The word "chat" in this spec means this
  chat and, when the text says so, its threads.
- **Turn**: one request of the user and the work of the responsible document that follows it,
  until the reply ends. A turn of the chat is not a node (010) and not a task (005).
- **Run**: one execution of the workflow (010). A run can work while the chat is quiet. The user
  does not need to send a message to start it.
- **Result**: what a node writes when it ends (010). A decision node gives the option that it took
  and the probability of each option.
- **Feedback**: a message of the user in the chat about the results of a run. It tells what is good
  or wrong. It counts only while the run works or waits (see "Progress, stops, results and
  feedback").

## Message rows

- A row starts with a header line: the name of the sender and the time. A reply shows the name of
  the workflow. Rows from the same sender within 5 minutes join under one header.
- Day changes show as a centred date line.
- Replies render Markdown: headings, lists, tables, code blocks with copy buttons, links, and
  images. The app adds no automatic image preview below a reply. An image shows only where the
  Markdown of the reply puts it. A picture from the web shows as a box until the user loads it (see
  "Pictures from the web").
- A link with no scheme that names a host opens with `https` (`localhost` opens with `http`, as in
  the bar of a browser). A bare mail address opens as `mailto`. A link that opens nothing (a
  relative address or another scheme) shows its words as plain text, not as a link.
- Tool use shows as a compact card inside the reply: an icon, a short label of what was done (read
  a file, ran a command, opened a page), and its result state. A click opens the details. Finished
  steps can fold into one line per series (see "Folded tool steps").
- Thinking, when the model gives it, folds into one muted line that lists every thought of the
  reply, in order, whether the switch "Show tool steps" is on or off. A model that thinks before
  each step gives many thoughts, and they still show as that one line.
- Hover on a row shows actions: reply, copy, fork (see "Threads"), and for the user's own last
  message, edit. On a finished reply it also shows "Read aloud" (027) and "Mark as unread" (see
  "Mark as unread").

## Folded tool steps

A long series of tool steps fills the chat. The user can fold it away.

- The switch "Show tool steps" in Appearance (013) is on at first. When it is off, each series of
  plain tool steps in a message shows as one muted line with the count. For example: "2 tool
  steps", or "1 tool step" for one step. The user opens the line to read the cards, and closes it
  again.
- A series is steps with no other part between them. Text, files, muted lines and cards that stay
  open split series. The one line of the thoughts of a reply sits above its series, so thinking
  between two steps does not split them.
- A step joins a series while it runs, and after it finishes, as long as it carries no mark. A step
  that waits, failed, was refused, or carries an approval, question, decision, memory, knowledge or
  settings note leaves the series and shows as its own card or line, so the user sees what needs
  them.
- The line of a series keeps its place while the series grows: a new step joins the series that is
  there, and only the count of the line changes. A step never shows as a card first and then goes
  into the line of a series.
- A line that the user opened stays open when the series takes another step, and when the chat
  draws it again, for example after a change of the theme.
- The switch changes the chat at once, in the chat and in its threads.
- Find in the chat (flow 10) does not look at the folded line, as it does not look at tool cards or
  thinking.
- Ways in: the switch is the only way to turn folding on or off. The user opens and closes a line by
  a click or a tap on it.
- Devices: each computer and each phone has its own switch, and uses it for every chat that it
  shows. Each profile (022) has its own switch.
- Runtimes: nothing changes for the work. The switch changes only the view. It works the same with
  every model provider and vendor runtime (006).
- Data: the switch is a setting of the open profile on its computer (013). It does not sync (019).
  An export holds it, like the other settings (014). The switch on the phone stays on the phone
  (011).
- Seeing the state: the switch shows on or off, and it keeps its state after a restart. The line
  shows the count of its steps.

## Flows

1. Send: the user types and presses Enter. Shift+Enter makes a new line. The message shows at once.
   The reply of the responsible document streams in as it is made.
2. Stop: while the responsible document works, the send button becomes a stop button. Stop ends the
   turn; the partial reply stays and is marked as stopped. Stop of the turn does not stop a run.
   The user stops a run in the workflow view (010).
3. Send while the responsible document works: see "Messages during a turn".
4. Attach: the user drops or picks files and images. They show as chips in the message box and are
   copied into the folder of the workflow (007) when sent. A pasted or dropped image also shows as
   a small preview in the box, and above the sent message in the chat. While a file goes to a
   linked server (012), its chip shows the progress, and it shows "Retry" when the transfer fails.
   A failed file does not stop the other files.
5. Reply: the user picks "reply" on a message. A quote line shows above the box. The sent message
   links back; clicking the link scrolls to the quoted message and flashes it, and a "Back" control
   returns to where the user was. A hit of message search (001) uses the same jump. A reply to the
   result of a node is the way to name that node in feedback (see "Progress, stops, results and
   feedback").
6. Approve: when a node of a run asks for permission (see 007), an approval card shows in the chat
   with Allow and Deny. The node waits until the user answers. The run view shows the task as
   waiting for the user (005). A decision node that asks the user to pick an option (010) shows its
   approval card here too.
7. Command picker: when the user types a slash as the first character of a message, a list opens
   above the box. It shows the commands first, then the skills that the user saved (see 017), then
   the skills that the runtime of the answering model reports, if it reports skills (see 006). A
   skill of a runtime shows the name of the runtime. The list narrows as the user types. It shows
   at most 30 skills, in this order. A skill that the user saved sets a chip in the box when picked
   (see 017). A slash in any other place is plain text, so a path such as `~/notes/todo` never
   opens the list.
8. Compact: the user runs the command "compact" from the list, or uses the Compact control of the
   context meter. The app asks the model to replace the older part of the conversation with a
   summary, to free room in the context. A failure shows in the normal error line above the box.
   See "Compact". The app can also do this by itself (see "Automatic compact").
9. Continue after a restart: see "Rules".
10. Find in the chat: Cmd+F opens a find bar over the chat that is open (the chat or a thread). The
    user types a text. The bar shows "n of m" and the buttons Previous and Next. Enter goes to the
    next match and Shift+Enter to the previous one. The chat scrolls to the match and marks it.
    Escape closes the bar and takes the marks away. The find looks at the text of the messages of
    that chat only, not at tool cards or thinking. It ignores letter case. Cmd+K (001) searches
    all places and stays as it is. The phone has no find bar in this version.
11. Dictate: the microphone button of the message box turns speech into text in the box (027).
12. Ask about a run: the user asks how far a run has gone, why it stopped or waits, or what the
    results are. See "Progress, stops, results and feedback".
13. Give feedback: while a run works or waits, the user writes feedback on a result. See "Progress,
    stops, results and feedback".
14. Edit the workflow: the user asks the responsible document to change the workflow. It uses the
    tools of 010, "Assistant". The rules of that section hold in this chat. The user can also ask
    for a new workflow with a name. The chat makes it and stays where it is.

## Progress, stops, results and feedback

The responsible document of a workflow knows the runs of that workflow. The user can ask it in
plain words how a run goes. It also takes the feedback of the user while the run works.

### What the user can ask

- **How far the run has gone.** The answer names the run and its state. It lists the nodes, with
  their numbers and names (010), in the order of their numbers. For each node it gives the state of
  its task, with the words of 005 ("States and reasons"). A node that is skipped (010) shows as
  skipped. A node that the run has not reached has no task, and the answer says "not reached".
- **Why the run stopped or waits.** The answer gives the reason of the task in plain words, as 005
  lists the reasons ("States and reasons"). It adds this:
  - For a wait for an approval (007), the answer names the step and says that the card is in the
    chat.
  - For a wait for the pick of a decision node, the answer says why: no option reached the
    threshold, the model gave no answer in 3 seconds, or the choice is off or has no key (010).
  - For a wait for a free slot, the answer says behind what the task waits.
  - After a restart, the answer says "The app stopped" (010, "Rules").
  - A scheduled run waits as a task that waits for the user (010, 005).
- **What the results are.** The answer gives the result of each node that has ended, with the
  number and the name of the node. For a decision node, it gives the option that won and the
  probability of each option. A result that is long shows its first part with "Show all", which
  opens the whole result in the run view (010). A node that has not ended has no result, and the
  answer says so.

### Rules of the answers

- The answers come from the facts of the run. The responsible document does not guess a state, a
  reason or a result. When it does not know a fact, it says so.
- The answer names the run that it is about, with the time at which the run started. When the
  workflow has no run that works or waits, the answer says so and tells the state of the last run.
  When the workflow never ran, the answer is "No run yet."
- When more than one run of the workflow works or waits, the answer names each of them.
- A question about a run starts no run and changes nothing. To start a run, the user asks for it
  (010, "Assistant").
- An answer shows the run as it is now. When the run goes on, the chat does not change an answer
  that it gave before. The user asks again to see the new state.
- To answer, the responsible document reads the results. They go to the model provider that
  answers in the chat (006). Text that looks like a secret (014) shows as `[redacted]`.
- The phone (011) and a linked computer (012) can ask in the same way. The answer comes from the
  server that holds the workflow.

### Feedback

Feedback is the opinion of the user on the results of a run, for example "Node 2 is too long. Keep
it to five lines." or "The summary of node 3 is wrong about the date."

- **When it works.** Feedback works in the chat of this workflow, and only while a run of the
  workflow works or waits. It works for a run that the user started and for a run that a trigger
  started (010). It works while the run waits for the user, and the run still waits for the
  answer to the card.
- **What the user writes.** A message that tells what is good or wrong in a result. The user can
  name the node in the message ("node 2"), or reply to the result of the node (flow 5). A message
  that names no node is feedback on the run as a whole. When more than one run works or waits, the
  user names the run, or the responsible document asks which run it is.
- **What the responsible document does.** It adds the feedback to the run. The chat shows one muted
  line after the message: "Feedback added to the run". The line names the run and the nodes that
  will get the feedback. When no node starts after the feedback, the line says that no node will
  get it.
  - The feedback goes with the input of every text node of the run that starts after the feedback.
    The node reads it as a note of the user on the results. It is not a new prompt.
  - A node that has ended does not run again. A node that is running keeps the input that it had.
  - A decision node does not get the feedback. It takes its input as before.
- **What feedback never changes.** It does not change the graph, the node prompts, the responsible
  document, the memory, the folder or the permission levels of the run. The graph does not change
  during a run (010).
- **When it is not feedback.** A question, such as "How far is the run?", is not feedback. While a
  question card waits, a message is the answer to that card (see "Messages during a turn"), not
  feedback. A message of an outside program (023) or from Teams (028) is never feedback. When the
  responsible document does not know if a message is feedback, it asks one question and adds
  nothing until the user answers.
- **Outside content.** In a turn that holds outside content (007), adding feedback is a guarded
  step, and it follows the permission level of the workflow as other guarded steps do (007,
  "Outside content"). Where it asks, an approval card shows the full text of the feedback, with
  Allow once and Deny. "Deny" adds nothing, and the responsible document says so. At "Full access"
  no card shows, and the feedback is added. The exception is a turn that holds the program mark
  (007, "Outside content"): there the card shows, also at "Full access".
- **Self-improvement.** The responsible document can turn feedback into a proposal for the next
  runs: a change of the responsible document, of a node prompt, of the graph, or of the memory (002,
  "Self-improvement"). The proposal waits until the user accepts it. It changes nothing in the run
  that works. When no run works or waits, feedback is not added to a run. The responsible document
  says so and can make a proposal from it.
- **After the run.** When the run ends, new feedback is not added to it. The responsible document
  says that the run ended.
- **Stops and ends in the chat.** The responsible document answers when the user asks. It does not
  tell the user by itself when a run stops, waits or ends.

### States

- **No run**: the answer says that the workflow has no run that works or waits, and tells the state
  of the last run.
- **Run works**: the answer lists the nodes and their states. Feedback is added to the run.
- **Run waits**: the answer says what the run waits for. Feedback is added to the run.
- **Run ended**: done, failed, blocked or cancelled. The answer gives the results and, for a failed run, the
  reason. Feedback is not added.
- **After a restart**: a run that was going is failed with the reason "The app stopped" (010). The
  answer says so.

### Surfaces

- Ways in: the message box of the chat; the phone and a linked computer (011, 012).
- Seeing the state: the answer in the chat, the muted line of the feedback, and the run view (010).
  The line of the feedback stays after a restart.
- Ways out: the user stops the run in the workflow view (010). A message that is not feedback
  starts a normal turn.
- Data: the answers and the lines of feedback are messages of the chat. The text of the feedback is
  part of the input of the nodes that read it. It is not part of the file of the workflow (010).
  It syncs with the chat (019) and an export holds it (014).

## Messages during a turn

The user can change the course of a turn without stopping it.

- A setting in General (see 013) has two values: "Join the current turn" (the default) and "Wait
  in a queue". The setting is named "While an agent works, new messages" in 013.
- **Join the current turn**: a message that the user sends while the responsible document works
  shows in the chat at once, with the muted line "Read at the next step". The responsible document
  reads it at the next step of the same turn: when the tool step that runs now ends, or at once
  when no tool step runs. Then the muted line goes away. It reads the message as a new request from
  the user, and can change what it does. No second turn starts.
  - Until the responsible document reads the message, the row has "Delete". A deleted message does
    not reach it.
  - While an approval card waits, the responsible document reads the message after the user answers
    the card, or after Stop. The card stays open and the user can answer it at any time.
  - While a question card waits, the message is the answer to the question. The card shows
    "Answered in the chat" and the work goes on with the message as its answer.
  - A message that was not read when the turn ends (for example after Stop) starts the next turn,
    as one message in the order that the user sent them.
- **Wait in a queue**: the message waits in a short queue above the message box. The user can
  remove or edit a queued message before it is sent. Each queued message has "Send now", which
  sends it into the current turn as with "Join the current turn".
- A vendor runtime (see 006) takes a message during a turn only when its program accepts input
  during a turn. When it does not, the message waits in the queue, whatever the setting says, and
  one muted line above the queue says why. "Send now" is off there, with the same reason.
- A message during a turn is not feedback on a run, and a run does not need a turn. A run can work
  while no turn works. See "Progress, stops, results and feedback".
- This applies to the chat and to its threads.
- The message queue of a thread holds at most 10 messages. The message over the limit is not
  queued. The box keeps its text and the line above it says "10 messages wait. Remove one or wait."

## Context meter

- The chat header shows how much of the context of the model the conversation uses, as a small ring
  with the numbers in its label.
- A runtime that reports its usage at the end of each turn feeds the ring. Right after a compact,
  the ring stays empty until the next reply, because no count is known.
- Compact is off, with the reason in words, when the size is not known or when the provider
  compacts by itself.
- When the answering model comes from an API account or from pi, and the saving "Compact at
  finished steps" (026) is on, the app can compact the context of one running turn at a finished
  step. This is not the compact of this spec: the history of the chat does not change, and the chat
  shows the muted line "Compacted for this turn", not the line "Compacted". The ring stays empty
  until the next reply, as after any compact.

## Compact

A long conversation fills the context of the model. Compact frees room. The user can run it, and
the app can run it (see "Automatic compact").

- The model that answers in the chat writes the summary, at the lowest effort that the model offers.
- The newest 2 turns stay word for word. The model gets one summary in place of everything older.
  The chat keeps every row. A line "Compacted" marks the place, and the user can open the line to
  read the summary. A later compact summarises the earlier summary and the turns after it.
- While it runs, the working line reads "Compacting…" and Stop ends it. A compact that is stopped
  or fails changes nothing. A message that the user sends during a compact that the user started
  waits in the message queue. When that compact ends, stops or fails, the queue sends its first
  message as after a turn. During an automatic compact, a message joins the turn as usual.
- Compact is off, with the reason in words, while a turn of this chat works or waits for the user,
  and when the conversation has 2 turns or fewer. The other reasons are in "Context meter".
- A manual compact is not a node and not a task. Its tokens add to the usage of the day (006). It
  holds the chat: no turn of this chat starts until it ends. It does not ask first, because the
  chat keeps all its rows. A run of the workflow goes on while the chat compacts.
- A restart during a compact changes nothing.
- The mark "Holds outside content" stays after a compact (007).
- When the answering model comes from a vendor runtime (006) that compacts by itself, the chat has
  no Compact control. It has no automatic compact, except for Claude Code when its cache has ended
  (see "Automatic compact"). Nothing else changes.

## Automatic compact

- A setting in General (see 013), "Compact long chats automatically", is on by default.
- Before a turn of the chat or of a thread starts, the app reads the last known use of the context.
  At 85 percent or more of the context, or at 400000 tokens or more, whichever comes first, the app
  compacts first, and then the turn goes on. The working line reads "Compacting…" first. The line
  "Compacted" shows afterwards.
- The limit of 400000 tokens is for a model with a large context. For a model whose context is
  larger than about 470000 tokens, 400000 tokens come before 85 percent. A long context costs more
  at each request, so the app does not wait for 85 percent there. For a smaller model, the 85
  percent rule comes first and the limit has no effect. The limit is not a setting. The setting
  "Compact long chats automatically" (013) turns these rules, and the 1 hour cache rule below, on
  and off.
- Anthropic keeps the start of a request in the cache of the model for 1 hour. Each turn writes
  that cache again. Claude Code does this on every turn. An Anthropic account does this on a turn
  that the user starts in the chat. A node of a run keeps that cache for 5 minutes. It does not use
  this rule. Before a turn that keeps the cache for 1 hour, when the last reply of that
  conversation ended 1 hour or more ago, the cache is gone. The next turn would write the history
  again. The app compacts first, then the turn goes on. This uses the same compact, the same pause
  of 5 turns and the same line "Compacted" as the rules above. It does not replace the 85 percent
  rule or the limit of 400000 tokens. An Anthropic account still uses those. Claude Code does not.
  A conversation of 2 turns or fewer does not compact. A turn that goes on after a restart does
  not. While less than 1 hour has passed since the last reply, this rule does not compact. Codex,
  Muse Code, pi, opencode, Cursor, an OpenAI account and a custom account do not get this compact.
- The 85 percent rule and the limit of 400000 tokens do not run when the size of the context is not
  known, or when the provider compacts by itself (see "Context meter"). The 1 hour cache rule for
  Claude Code is the one exception for a provider that compacts by itself.
- After a compact the use is not known until the next reply (see "Context meter"). So a second
  compact cannot follow at once.
- An automatic compact is part of the turn. Its tokens add to the usage of the turn and of the day
  (006).
- When the compact fails, the turn goes on without it. A muted line gives the reason. The app does
  not try again for this conversation until 5 more turns of it have ended. The same holds when the
  first reply after a compact reports a use that the rule above would compact again. The count of 5
  turns stays after a restart.
- Stop during the compact ends the turn as stopped. The message of the user stays. What the model
  gets does not change.
- A linked computer and the phone show the result only. They do not start a compact in this version
  (011, 012).

## Threads

The chat of a workflow keeps threads and forks. The rules below hold for the chat and its threads.

- **Thread**: a second conversation with the same workflow. The workflow keeps its responsible
  document, its memory and its folder; only the history is separate. The chat is the main thread.
- The user starts a thread, renames it, archives it, restores it, and deletes it. A thread shows in
  a list in the chat header. Each thread keeps its own message queue and its own unread count.
- A new thread opens empty (see "Empty state"). Its title is "New thread" until the user sends the
  first message. Then the title is the first line of that message, at most 60 characters. The user
  can rename it. The main thread keeps its name. The user cannot archive or delete it. Delete of
  another thread asks first and says that the thread cannot be restored.
- A workflow has at most 50 threads, the main thread included. Archived threads count. At 50, the
  controls for a new thread and for Fork are off, with the reason in words.
- A thread that has a working turn, a turn that waits for the user, or queued messages cannot be
  archived or deleted. The control is off, with the reason in words.
- A message joins the working turn of its own thread only. When a turn works in another thread of
  the chat, the message waits in the queue of its thread. The thread shows the line "Waits for
  another thread". The message goes when the other turn ends.
- A thread has no run of its own. A run belongs to the workflow (010). The answers of "Progress,
  stops, results and feedback" are the same in every thread.
- Work that an outside program (023) or Teams (028) sends to the chat of a workflow goes to the main
  thread.
- A fork made at a message after a "Compacted" line copies the summary and the turns after it. The
  model of the fork gets the same summary.
- A linked computer and the phone show the main thread only in this version. They never get the
  messages of another thread, and the search of messages on a linked server (001) finds the main
  thread only. An approval card or a question card of a node in a run, asked from another thread,
  shows in "Needs you" (011) and in the task view (012), and the user can answer it there. "Open
  source place" is off there, with the reason in words. A notice of a reply in another thread is
  not sent to these devices.
- **Fork**: on a finished message of the main thread or of another thread, the user picks "Fork". A
  new thread of the same workflow opens. It holds a copy of the conversation up to that message.
  The responsible document reads that copy with the first message that the user sends in the new
  thread. The original thread does not change. Later changes in either thread do not reach the
  other.
- The title of a fork is the first line of the message where it was made, or "New thread" when that
  line is empty.
- A fork is refused for a message that belongs to a turn that still runs, and for a message that
  does not exist.
- A fork keeps a link to its source thread and message. Deleting the source does not change the
  fork.

## Mark as unread

- On a finished reply, the action "Mark as unread" makes that reply and the later replies count as
  unread again. The chat shows the new count.
- The next time the user opens the chat, it opens at that message. The count clears when the chat
  shows its latest message, as for any chat.
- A thread keeps its own count (see "Threads"). The mark works inside a thread.
- The read state follows the unread count (012, 019).

## Pictures from the web

A picture in a Markdown text can take its data from an address on the web. That address can carry
data: a node that read a secret, or that obeyed an order in a web page, can write the data into the
address. A device that loads the picture then sends the data to the host of the address, and the
user does not click. So a picture from the web loads only when the user asks.

- This holds for every Markdown text that the app shows: messages in the chat and its threads, the
  results of nodes in the run view (010), and articles of knowledge (016).
- An image with an address that starts with `https` shows as a box. The box shows the alt text (cut
  at 80 characters, or the word "Image" when the alt text is empty), the address (cut at 100
  characters), and the button "Load image".
- The button loads that one image, and the image takes the place of the box. The choice holds while
  the app runs, for that address in that message. It is not saved. After a restart the box shows
  again.
- An image with an address that starts with `http` does not load, and the box has no button. The
  alt text shows in its place.
- An image that is a part of the Markdown text itself (a `data:image` address) shows at once,
  because it needs no network.
- The device of the user loads the picture. No ROBot server loads it for a linked device or for the
  phone.
- The phone (011) and a linked device (012) follow the same rule.

## Empty state

A new chat shows the name of the workflow and the line "This is the start of your chat." Nothing
moves.

## States

- Working: a calm animated line under the last row, with elapsed time. It starts with the badge of
  the app mark: a small dark tile with the two smiling eyes of the app mark in light. The eyes open
  when the badge comes in, and the light breathes while the responsible document works. This is the
  only light that moves, and the badge shows nowhere else. With reduced motion, the eyes are open
  and the light is still. The line reads "Working…", or, in about half of the turns, a short
  playful phrase that the app picks at random for the turn and keeps until the turn ends. At least
  20 phrases exist in each language. The Korean phrases read as spoken Korean, not as a translation.
  The stop button shows whenever this line shows. A run that works shows its own state in the
  workflow view (010).
- Quiet: when the turn shows no sign of life for the quiet time, the working line reads "No answer
  from <name> for <time>" (see 005, "Quiet line"), with the name of the workflow. The stop button
  stays. The quiet line does not animate, and the light of its badge is still. The elapsed time of
  the turn stays where it was. The quiet line replaces only the text.
- Failed: an error row with the reason in plain words and a Retry button. Retry shows the retry note
  (see 005) when the first try ran steps that may have changed things. The row also tells how far
  the turn went (see 005, "How far a turn went"). A turn that the app stopped because it was silent
  (see 005) fails in this way too.
- Provider not connected: the message box is disabled with a button to connect it.
- Busy provider and backup model: a muted line tells that the model is busy and the app tries
  again (006), or that the backup model goes on (006). None of these lines is an error row.
- Interrupted by a restart: see "Rules".
- A run that works, waits, failed or ended: see "Progress, stops, results and feedback".

## Rules

- A message in the chat is not the prompt of a node. A node prompt changes only by an edit of the
  workflow (010) or by an accepted proposal (002, "Self-improvement").
- The conversation is stored locally as each part arrives, so a crash loses at most the part that
  was streaming.
- After an app restart, a reply that was streaming is marked as stopped. This includes a turn of the
  chat that waited for an approval or a question (007): it does not keep its place and does not go
  on. The card goes away (005, 007).
- When a restart cut off the last request of the user to this chat, and the user has not written
  since, a notice shows above the message box. It says that the restart stopped the request. Its
  "Continue" button sends a short new message that asks the responsible document to go on. It does
  not send the old request again, so no side effect repeats unless the user chooses it. A stop by
  the user shows no notice.
- If the cut request had not reached the model (see 005, "How far a turn went"), the notice says
  so. It has the button "Send again" and no "Continue". "Send again" sends the same request again,
  because no step ran. On a linked device (012), it asks the server to send it again.
- If the cut request had reached the model ("Sent" or "Started"), the notice shows the line of 005
  for that progress, and keeps "Continue".
- Scrolling up stops auto-scroll. A "Jump to latest" button brings it back.
- For 3 seconds after a chat opens, an upward scroll that the reader did not cause (no wheel,
  touch, drag or key) returns the chat to the latest message, as long as the chat follows the
  latest message. Later scrolls are left alone. The app never fights the reader.
- A chat with more than 30 messages draws only the rows that are near the visible area. Return to a
  long chat from another page is fast, and the scroll place stays.
- The hint text in the message box hides while the box holds text.

## Out of scope

- A chat that is not the chat of a workflow.
- A mention of another workflow in a message, and a handover of a chat to another workflow, with its
  brief (see the questions for 003).
- Feedback that changes the graph or a prompt of the run that works.

## Acceptance

- Open the chat of a workflow that has no message: it shows the name of the workflow and "This is
  the start of your chat."
- Send, stop mid-reply, send again: both turns are stored and the first is marked stopped.
- With "Wait in a queue", a queued message is sent automatically when the turn ends.
- With "Join the current turn" and an API provider: the responsible document runs a tool step that
  takes 3 seconds. The user sends "Use b.txt instead". The next request to the model holds this
  message, the chat shows one turn only, and the line "Read at the next step" goes away.
- Send a message during a turn and delete it before the step ends: the model never gets it.
- A question card waits. The user sends "the second one": the card shows "Answered in the chat" and
  the work goes on with that text as its answer. The message is not feedback.
- With a runtime that takes no input during a turn: the message waits in the queue, and the line
  above the queue says why.
- Type `/` first in the box: the list opens. Type `~/notes/todo`: no list opens.
- Save a skill, open the chat, type `/` and the first letters of its name: the list shows the skill
  after the commands. Pick it: a chip with its name shows in the box (017).
- Attach a file: the file is in the folder of the workflow after the message is sent.
- Ask the chat to add a node: it uses the tools of 010, "Assistant", and the canvas shows the node.
- Fork at the third message of a chat of eight messages: the new thread has three messages and the
  original has eight. Fork at a message of a running turn: the app refuses.
- Restart the app while the responsible document works on a request: the chat shows the notice.
  Continue sends a short message and the notice leaves.
- End the app at once after a send, and start it again: the request had not reached the model. The
  notice says so and has "Send again". The button sends the same text, and the responsible
  document answers it.
- A chat of 200 messages opens at the latest message and stays there for the first 3 seconds.
- Run "compact" in a chat of six turns: the model gets a summary and the newest 2 turns. The chat
  still shows all six turns, with the line "Compacted" between turn 4 and turn 5. Open the line: the
  summary shows. Compact in a chat of 2 turns is off, with a reason.
- Run "compact" while a run of the workflow works: the compact runs, and the run goes on. While a
  turn of the chat works, Compact is off.
- Automatic compact is on. A stand-in provider reports 90 percent use after a reply. The user sends
  a message: the line "Compacting…" shows, then the turn goes on. The ring is empty until the
  reply. Turn the setting off: the same message starts the turn at once.
- The model that answers in the chat is Claude Code, and the chat has two turns. An hour after the
  last reply, the next message compacts first. The program gets a summary and the newest 2 turns. Before that hour, the
  same chat does not compact. With the setting off, an hour later, the next message does not
  compact. With Codex, it does not compact after an hour.
- The model that answers in the chat is an Anthropic account, the chat has two turns, and the use of
  the context is low.
  An hour after the last reply, the next message of the user compacts first. Before that hour, the
  same chat does not compact. A node of a run, an hour after the last reply of the chat, does not
  make the chat compact. With an OpenAI account, or a custom account, the chat does not compact
  after an hour when the use is low.
- Automatic compact is on, and a stand-in model has a context of 1000000 tokens. It reports 399999
  tokens (40 percent) after a reply: the next message starts the turn with no compact. It reports
  400000 tokens: the next message shows "Compacting…" first. With a stand-in model of 200000 tokens
  that reports 170000 tokens (85 percent), the next message compacts first as well.
- The stand-in provider fails the summary call: the turn goes on, a muted line gives the reason, and
  the next turns start with no new try until 5 turns have ended.
- Stop an automatic compact: the turn ends as stopped, the message of the user stays, and the next
  turn sends the old conversation to the model.
- Start a thread and send a message in it: the list in the header shows the main thread and the new
  thread, titled with the first line of the message. Make 50 threads: the control for a new thread
  is off.
- A turn works in thread A. The user sends a message in thread B of the same chat: it waits, and
  thread B shows "Waits for another thread". It goes when the turn of thread A ends. A message in
  thread A joins the turn of thread A.
- Delete a thread that has a working turn: the control is off.
- Fill a message queue with 10 messages: the 11th stays in the box and the line shows "10 messages
  wait. Remove one or wait."
- Fork at a message after the line "Compacted": the new thread holds the summary and the turns after
  it, and its first turn sends that summary to the model. At 50 threads, Fork is off.
- Delete another thread: the app asks first.
- On a linked computer and on the phone, a chat with 3 threads shows the main thread only. A node of
  a run asked from thread 2 waits for an approval: the card shows in "Needs you" and can be
  answered there. The search of messages finds no message of thread 2.
- Paste an image into the box: a small preview shows in the box, and above the message after it is
  sent. Send a file to a linked server with a stand-in link that fails once: the chip shows
  "Retry", and the other files go.
- Open a chat of 30 messages that holds the word "budget" in four of them. Press Cmd+F and type
  "budget": the bar says "1 of 4". Enter goes to 2 of 4. Escape closes the bar and the marks go.
- A chat has eight messages. The messages 2, 4, 5, 7 and 8 are replies. Mark message 5 as unread:
  the chat shows the count 3 (messages 5, 7 and 8). Open the chat: it opens at message 5. Scroll to
  the end: the count goes.
- A reply holds the Markdown `![chart](https://host.test/a.png?d=1)`, and a test server listens at
  `host.test`. The chat shows a box with the text "chart", the address and the button "Load image".
  The test server has had no request. Press the button: one request arrives, and the image shows.
  Restart the app and open the chat: the box shows again, and the test server has had no new
  request.
- A reply holds an image with an `http` address, and an image with a `data:image` address. The first
  one shows its alt text and has no button. The second one shows at once.
- Turn off "Show tool steps". A reply with two finished reads in a row shows one folded line with
  the count 2. Open the line: the two cards show. A reply with a text between two finished reads
  shows two folded lines with the count 1 each.
- With the switch off, a step that waits for an approval and a failed step still show as cards. Turn
  the switch on: the cards show with no folded line.
- Turn off "Show tool steps" and send a request that makes four steps, one after the other. While
  the turn runs, the reply shows one thought line and one folded line, and the line stays in its
  place: its count grows from 1 to 4, and no card shows and goes away again. Open the line while the
  third step runs: it stays open, and it shows the third step as running.
- A reply that thinks before each of its four steps shows one thought line, and, with the switch
  off, one folded line with the count 4. Open the thought line: it lists the four thoughts in
  order.
- A workflow has four nodes. Node 1 is done, node 2 is running, and the run has not reached node 3
  and node 4. The user asks "How far is the run?": the answer names the run and lists node 1 as
  done, node 2 as running, and nodes 3 and 4 as not reached.
- Node 2 fails with a reason. The user asks "Why did it stop?": the answer names node 2 and gives
  its reason. A stand-in node asks for an approval: the user asks "Why does it wait?": the answer
  says that the node is waiting for the user for an approval and that the card is in the chat.
- A decision node has no option at the threshold. The user asks "Why does it wait?": the answer says
  that the decision node waits for the user to pick an option. The user picks one, and the answer to
  the same question now says that the run goes on.
- A run waits behind a full slot. The user asks "Why does it wait?": the answer says that the node
  is queued and waits for a free slot.
- Stop a run, then ask "What happened?": the answer says that the user stopped the run. Restart the
  app during a run and ask: the answer says "The app stopped".
- Node 1 and node 2 ended. The user asks "What are the results so far?": the answer gives the result
  of node 1 and of node 2, and says that node 3 has no result. A result with text that looks like a
  key shows `[redacted]`. A long result shows its first part and "Show all".
- The workflow has no run that works. The user asks "How far is the run?": the answer says that no
  run works and tells the state of the last run. For a workflow that never ran, the answer is "No run
  yet."
- A run works. The user asks "How far is the run?" and then the run goes on: the first answer stays
  as it was. Ask again: the answer shows the new state.
- A run works, node 2 is done and the run has not reached node 3. The user replies to the result of
  node 2 with "Too long. Keep it to five lines.": the chat shows "Feedback added to the run", with
  the run and node 3. Node 3 gets the feedback with its input. Node 2 does not run again. The graph
  and the prompts do not change.
- Feedback while a node works: that node keeps its input, and the next node that starts gets the
  feedback.
- Feedback when no text node starts after it: the line says that no node will get it.
- Feedback while the run waits for an approval: the responsible document adds it to the run, and the
  card still waits.
- A decision node starts after feedback: the request to the decision model does not hold the
  feedback.
- The user writes "How far is the run?" during a run: the responsible document adds no feedback to
  the run.
- The user writes a message that may be feedback: the responsible document asks one question, and
  adds nothing until the user answers.
- Two runs work. The user writes feedback that names no run: the responsible document asks which
  run.
- No run works. The user writes feedback on the last run: the responsible document adds no feedback
  to a run. It says so and can make a proposal. The user accepts it, and the next run uses the
  change (002).
- A message from Teams or from an outside program says "Node 2 is too long." during a run: it is not
  feedback, and the run does not change.
- A turn holds outside content, and the workflow is at "Ask for risky steps". The user writes
  feedback: an approval card shows the text and "This turn holds outside content". "Allow once"
  adds the feedback. "Deny" adds nothing, and the responsible document says so. At "Full access",
  the feedback is added with no card, unless the turn holds the program mark: then the card shows.
- The run has ended. The user writes feedback: the responsible document says that the run ended, and
  adds nothing.
- A run that a schedule started works with no user at the screen. The user opens the chat and writes
  feedback: the run gets it.
- On the phone (011), the user asks "How far is the run?": the answer shows. The user writes
  feedback on the phone: the run on the computer gets it.
- A message in the chat never changes the prompt of a node. The prompt changes only by an edit of
  the workflow or an accepted proposal.
