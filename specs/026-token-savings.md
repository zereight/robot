# 026 Token savings

## Purpose

A long task of a text node costs many tokens, because the model reads the same big results again
at each step. The user can turn on three savings for the whole app. Each saving cuts one kind of
repeated work. All three are off at first. None of them hides what the node did.

How much a saving can do depends on who runs the loop of the node. ROBot runs the loop of a text
node on an API account, so it can apply all three. A vendor program (006) runs its own loop, so
ROBot reaches only the part that passes through ROBot. The table in "Where each saving works"
says this, and the settings page says it to the user. A decision node has no loop and no tool, so
no saving reaches it (010).

## Concepts

- **Saving**: a switch in the settings section "Token savings" (013). There are three:
  - **Check with edit**: a file change can carry one shell command. The command runs at once after
    the change, in the same step. The node gets one result. This saves one model request each
    time the node would have changed a file and then run a check.
  - **Set big results aside**: ROBot keeps a copy of a big tool result and takes the big text out
    of what the model reads. The node can read the copy again, page by page. This saves the cost
    of sending the same big text at every later request.
  - **Compact at finished steps**: the node keeps a short list of steps. When it marks a step as
    done, ROBot may compact the context (003) and the turn goes on. This saves the cost of a long
    context in a long task.
- **Set-aside result**: the whole text of a result that the second saving took out of what the
  model reads. It is a file on this computer.
- **Savings line**: one line in the view of a task that counts how often the savings ran.

## Where each saving works

| Text node | Check with edit | Set big results aside | Compact at finished steps |
| --- | --- | --- | --- |
| On an API account (006) | Yes | Yes, for every tool result | Yes |
| On pi | At "Full access" only | Yes, for every tool result | Yes |
| On Claude Code, Codex, opencode, Muse Code or Cursor | No | Only for the tools of the app (the browser and "search chats") | No |
| On Pi-Bolt | Not in this version | Not in this version | Not in this version |

- A vendor program runs its own tools and keeps its own context during a turn. ROBot cannot change
  what such a program reads, so "Check with edit" and "Compact at finished steps" have no way in.
  These programs compact their own context (003).
- The tools of the app (the browser, "search chats") pass through ROBot for every node, so one
  saving reaches all of them.
- The model that answers in the chat of a workflow (003) follows the same table, by its runtime.
  Which model that is, is not decided (see the questions for 003).
- The settings page shows, under each switch, a muted line with the runtimes it works for. The
  editor of a text node shows one muted line under the model: which savings work for it, or "No
  savings work for this node."

## Flows

1. Turn on or off: in Settings, the section "Token savings" has three switches. Each switch has a
   one-sentence note of what it does and the muted line of the runtimes it works for. A muted line
   under the section says that savings cut tokens and can change how a node works, and that the
   view of a task (005) shows its tokens. The section makes no promise of a number.
   - A change counts from the next task. A task that is under way keeps the switches it began
     with.
   - All three switches are off in a new profile. They are off for a user who updates the app.
2. Check with edit: the node changes or writes a file and gives a command with it. The tool card
   shows the file step and the command in one card, with the label "With check", and the result
   of the command.
   - The command is a shell command in every respect (see "Rules"). When the level or a rule asks
     the user for a shell command, the one card asks, and shows the file step and the command
     together. When the user denies it, neither the file nor the command changes.
   - When the command fails, the card shows Failed, and the file keeps the change. The node gets
     the change and the failure together. The app does not undo the change.
   - When the file change fails, the command does not run. The card says so.
3. Set big results aside: a tool result of more than 10 KB of text goes to the model in one of two
   ways, by runtime:
   - A node whose loop ROBot runs (API account, pi): the result stays whole for the next two
     model requests. After that, the model reads the start and the end of the result and a note.
     The note says that the whole result is saved and that the node can read it again.
   - A vendor program, for a tool of the app: the program gets the first 10 KB and a note. The
     note says that more text is saved and how to read the next page. The program cannot be
     changed afterwards, so the cut is made at once.
   - The node reads a set-aside result with a step that takes the number of the result and a
     page. The card of this step reads "Read saved result".
   - The card of the first step still shows the whole result in the task view (005). The user
     loses nothing.
4. Compact at finished steps: while the saving is on, the node has one more tool, to list its
   steps and to mark them done. A card shows the list like any tool card. When a step is marked
   done, ROBot decides if a compact pays back (see "Rules"). If it does:
   1. The turn pauses. The working line reads "Compacting…" (003). In a task, the task view shows
      the same text.
   2. ROBot compacts the context of this turn as the compact of 003 does: a summary and the
      newest turns. It changes the context of this turn only. The task and the chat keep every
      row, the history of the chat stays as it is, and later turns do not read the summary. The
      compact of 003 is a separate thing and works as before.
   3. The task view, or the chat for a turn of the chat, shows the muted line "Compacted for this
      turn" in the turn. It is not the line "Compacted" of 003, which marks a compact of the
      history of the chat.
   4. The turn goes on from the list of steps. The task does not end.
   - The saving works whether the setting "Compact long chats automatically" (013) is on or off.
   - When the compact fails, a muted line gives the reason (003) and the turn goes on with its old
     context.
   - When the user stops the turn during the pause, the turn ends as stopped and does not go on.
5. See what ran: the view of a task shows the savings line, for example "Savings: 2 checks with
   edit, 3 results set aside, 1 compact". The line counts what the turn shows in its cards. A
   count of zero is left out. When all counts are zero, the line is absent.

## States

- **Switch off**: the run is the same as before this spec. The node gets no new tool and no new
  field.
- **No node**: a switch is on, and no text node of the profile is on a runtime for which the table
  offers that saving. The muted line under the switch says so.
- **Needs Full access** (check with edit, node on pi): the file steps of that node carry no
  command at the lower levels. The editor of the node says this in its muted line.
- **Copy gone**: the node asks for a set-aside result that does not exist, for example in a later
  turn or after a restart and "Continue" (003). The step fails with the text "This result is no
  longer saved." The node can run the step again.
- **Pause for compact**: the task shows as working. The quiet line (005) does not count the pause
  against the silent limit.

## Rules

- **A saving never widens what a node may do.**
  - The command of "Check with edit" meets the permission level, the rules (007) and the check of
    "Ask when unsure" exactly as the same command meets them as a step of its own. The file step
    and the command are decided together: if one is refused, neither runs.
  - For a node on pi, the command runs only at "Full access": pi cannot ask the user before a
    step, so at the lower levels ROBot starts pi with no shell (007). There the node gets no way
    to attach a command.
  - Reading a set-aside result is allowed at every level, also "Read only". It reads text that the
    node already had.
  - The list of steps of the third saving changes nothing outside the context. It is allowed at
    every level.
- **Outside content keeps its mark.** A result that held outside content (007) keeps that mark
  when it is set aside. Reading it again makes the task or the turn hold outside content.
- **Set-aside results are local.** They are files in the data folder of the profile, readable by
  the user only. They never leave the computer, are not exported (014), and do not sync (019). The
  app deletes the copies of a turn when the turn ends, and deletes any that remain when the app
  starts. In a later turn the model gets the start, the end and the note, and the copy is gone
  (see "Copy gone"). A result that is not text, and a result that is an error, is never set aside.
- **No new data leaves the computer.** The savings run on this computer. The compact sends its
  summary request to the same model account as the node, like any turn. This spec adds no
  exception to 000 and 014.
- **Compact only when it pays.** ROBot compacts at a finished step when the saving in later
  requests is likely to be larger than the cost of the compact, or when the context is nearly
  full. It does not compact twice within two model requests, except when the context is nearly
  full. A step marked done that was never listed does not start a compact.
  A short context does not pay: the fixed part of each request (instructions and tool
  definitions) stays after a compact, and the compact is a request of its own. So a compact of a
  short context saves little or nothing, and the app does not make it.
- **The pause is not an end.** The pause for a compact makes no notice, no sound, no result card
  and no "ended" state (015). The tokens of the compact request count in the usage of the task,
  also when a program reports them apart from the tokens of the turn.
- **Count for limits.** A file step with a command counts as one step for the step limit (005).
- **ROBot sets the savings.** The switches of the profile decide the savings of a run. A setting
  in a program of the user, for example the add-ons of pi, that adds or removes a saving does not
  change a node of ROBot.
- **Quality.** The app claims no saved amount and no unchanged quality. The savings line counts
  events and nothing else.

## Surfaces

- **Ways in**: Settings, the section "Token savings" (013). There is no slash command, key or
  per-workflow or per-node switch in this version.
- **Devices**:
  - The computer: all switches, and the savings line.
  - A linked computer (012): sees the switches and their state, with no buttons. It runs nothing
    of its own; a run on the server uses the switches of the server.
  - The phone (011): shows the savings line in the view of a task, as text. No switches.
  - A second profile (022): has its own switches, off at first.
- **Runtimes**: see "Where each saving works". For a node that the table marks "No", nothing
  changes, and its editor says so.
- **Ways out**: each switch turns off at any time. No data needs a restore. Set-aside results go
  away with the turn.
- **Seeing the state**: the switch, the muted lines, the "With check" label and the compact line in
  the task view and the chat, and the savings line in the task. All stay after a restart, because they are part of
  the stored turn.
- **Data**: the switches belong to the settings of the profile. An export holds them (014). Sync
  does not carry them (019), because the table depends on the programs on each computer. The
  savings line needs no stored field: it counts the cards of the turn.
- **Words**: see the glossary.

## Out of scope

- Reading a long log with a cheaper model and keeping only checked lines. This sends logs to a
  second model, so it needs a model choice and a new exception in 000 and 014. Open for a later
  change.
- Making a vendor program (Claude Code, Codex, opencode, Muse Code, Cursor) use ROBot tools in place of its
  own file and shell tools, to reach it with "Check with edit" and "Set big results aside". The
  program loses the tools its model was tuned for, and its own approvals. Decided against.
- Passing a vendor program its own limits, for example a cap on the size of a tool result or the
  point of its own compact. Open for a later change, after each program is checked
  (`docs/token-savings-research.md` lists what is known).
- A compact between turns for a vendor program that has a compact command: the app sends the
  command after a turn ends, when the context is large. A test with Claude Code shows that this
  works, and that it saves nothing at a short context. Open for a later change. The compact of
  003, when the cache of Claude Code has ended, is a different rule and is in scope (003). The
  same rule covers an Anthropic account when a turn that a person starts finds that cache gone.
- A per-workflow, per-node or per-task switch, and a choice that turns savings on by itself.
- A number of saved tokens or saved money.

## Acceptance

- A new profile: the section shows three switches, all off. Start a run on an API account and on a
  stand-in pi program: neither gets an extra tool or an extra field.
- Turn on "Check with edit". A text node on an API account, in a workflow at "Full access",
  changes a file with a command: one card with "With check", the file holds the change, the card
  shows the output of the command, and the task used one model request less than the same task
  with the switch off.
- The same node at "Ask for risky steps": one approval card shows the file step and the command.
  Deny: the file is unchanged and the command did not run. A Deny rule that matches the command
  refuses the whole step.
- A command that exits with an error: the card shows Failed, the file keeps the change, and the
  node receives both.
- A node on pi at "Ask for risky steps": the file steps carry no command, and the editor of the
  node says that the saving needs "Full access".
- Turn on "Set big results aside". A stand-in tool returns 50 KB to a node on an API account. Two
  requests later, the request holds the start, the end and the note, not the whole text. The card
  of the first step in the task view still shows the whole text. "Read saved result" with a page returns the right
  part. At "Read only" the same read works.
- A stand-in vendor program calls "browser_read" on a page of 50 KB: it gets the first 10 KB and
  the note, and the page it asks for next is the next part.
- End the turn, then read the result again in a later turn: the step fails with "This result is no
  longer saved." After a restart of the app, no set-aside file remains.
- A set-aside result that held a web page: after the read, a guarded step asks as it does in a
  turn that holds outside content (007).
- Turn on "Compact at finished steps". A stand-in model marks a listed step done with a nearly
  full context: the task view shows "Compacted for this turn" once and no line "Compacted" of 003,
  the task keeps one task row, the status island shows no result card and no notice, and the
  result ends once. In a turn of the chat, the chat shows the same line once, and the next turn of
  the chat sends the full history.
- A compact that fails: a muted line gives the reason and the turn ends with an answer.
- A run with a short context marks a listed step done: no compact runs, and the savings line shows
  no compact.
- A stand-in program reports the tokens of a compact apart from the tokens of the turn: the total
  of the task holds both.
- Stop the turn during the pause: the turn ends as stopped and does not go on.
- A stand-in program that stays silent for longer than the silent limit, outside the pause: the
  turn fails as before. A pause that is longer than the silent limit does not fail the turn.
- A node on Codex: its editor names "Set big results aside" for the tools of the app, and no
  other saving. A node on Pi-Bolt: its editor reads "No savings work for this node." The
  settings page lists, under each switch, the runtimes it works for, and the list matches the
  table.
- A decision node: no saving reaches it, and its editor shows no line about savings.
- Turn a switch off while a task is under way: that task keeps the old setting, and the next task
  uses the new one.
- The savings line shows the right counts after a restart. On the phone, the same line shows.
- The three savings add no request to any address that the run did not use before.
