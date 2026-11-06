# 002 Responsible document

## Purpose

Each workflow has one responsible document. It is a text that says who answers for the workflow, its
character and its limits (010). It is part of the workflow, and the user edits it.

The responsible document answers in the chat of the workflow (003). It tells the user how far a run
has gone, why a run stopped or waits, and what the results so far are. It takes feedback from the
user while a run works. After a run, it can propose changes to the workflow. The user accepts each
change before it applies.

## Concepts

- **Responsible document**: a text, in the form of a skill (017). It says who answers for the
  workflow, its character, its values, its way of work and its limits. Each workflow has one. A
  responsible document belongs to one workflow. The user cannot pick another one.
- **Version**: the responsible document as it was before a change (see "Responsible document
  history").
- **Proposal**: one change of the workflow that the responsible document proposes (see
  "Self-improvement").
- **Switch "Self-improvement"**: a switch of the workflow, on by default (see "Self-improvement").

## Flows

1. Make: a new workflow gets a responsible document with a short default text (010, "New
   workflow"). The text follows the language of the interface at the moment of the new workflow.
2. Edit: the user opens the responsible document, changes the text, and saves. The change counts from
   the next turn of the chat and from the next run. A turn that works keeps the text that it had. The
   responsible document is read-only while a run works, as the workflow is (010).
3. Ask in the chat: the user asks in the chat for a change of the responsible document, for example
   "from now on, answer in Korean". The responsible document makes a proposal, and its card shows
   in the chat (see "Self-improvement"). Nothing changes before the user accepts.
4. Ask about a run: the user asks in the chat how far a run has gone, why it stopped or waits, or
   what the results so far are. The responsible document answers (see "Progress, stops, results and
   feedback").
5. Give feedback: the user writes feedback on a result while a run works or waits. The responsible
   document takes it (see "Progress, stops, results and feedback").
6. History: the user opens "History" of the responsible document and restores a version (see
   "Responsible document history").
7. Propose: after a run, or in a turn of the chat, the responsible document can propose a change.
   The user answers on the page "Self-improvement" (see "Self-improvement").

## Responsible document

- **Size**: 0 to 20000 characters. A text over the limit is refused on save, with the reason.
- **Empty**: an empty responsible document is valid. A node then runs with its own prompt only. The
  responsible document answers in the chat with the rules of the app only.
- **Order**: at run time, the app sends the responsible document first and the prompt of the node
  after it (010). The rules of the app (007, 014) always win over both.
- **While a run works**: the responsible document is read-only, as the workflow is (010).
- **Who changes it**: the user, in the editor (also on a linked device that the user allows, 012);
  a proposal that the user accepts (see "Self-improvement"); Undo and Restore of a version. A
  request in the chat becomes a proposal. The user decides each change. No other part of the app
  changes it: not a node, not a manage tool (037), and not an outside program (023).
- **Text of a secret**: text that looks like a secret (014) is refused on save, with the reason. The
  responsible document goes to the model provider of each node and of the chat. The page says so.
- **Data**: the responsible document syncs with its workflow (019), and an export holds it (014).
- **Words**: the interface says "responsible document". It does not say "instructions", "prompt",
  "persona", "system prompt" or "Soul" for this text. A node prompt and the instructions of a skill
  (017) keep their names, because they are other texts.

## Responsible document history

- Each change of the responsible document keeps the old text as a version. A version has the text,
  the date, and where the change came from: the editor (on this computer or on a linked device,
  012), a proposal that the user accepted, Undo, or a restore.
- The workflow has "History": the versions, newest first. The user can open a version and restore
  it. A restore makes a new version. It does not delete the versions after it.
- A workflow keeps at most 50 versions of its responsible document. The oldest goes first.
- The history belongs to the workflow. An export holds it (014). When two computers sync (019), the
  history goes with the workflow. Deleting the workflow deletes it.

## Progress, stops, results and feedback

The responsible document answers in the chat of the workflow (003). It answers for the workflow, so
the user can ask it about a run. The full text of the chat is in 003. This is what the user can
rely on.

- **How far**: the user asks how far the run has gone. The answer gives the state of each node, with
  the words of 005 (for example done, running, waiting for the user). A node that the run has not
  reached has no task, and the answer says "not reached".
- **Why it stopped or waits**: the user asks why a run stopped or why it waits. The answer names the
  node and the reason. The reasons are the ones that 005 lists for a task: a failed node with its
  reason, a wait for the approval of the user, a wait for the pick of a decision node, a wait behind
  a slot, a cancel by the user ("Stopped by you"), and "The app stopped".
- **Results so far**: the user asks what the results are. The answer gives the result of each node
  that has ended, in the order of the run.
- **Feedback**: while a run works or waits, the user writes feedback on a result in the chat. The
  responsible document takes it. The feedback goes with the input of the text nodes that start after
  it. No node that has ended runs again. The feedback does not change the graph, the prompts, the
  folder or the permission levels of the run (010). The chat shows one muted line that says that the
  feedback was added to the run. The responsible document can also turn the feedback into a proposal
  (see "Self-improvement") for the next runs.
  - Only the words of the user are feedback. A message of an outside program (023) or from Teams
    (028) is never feedback (003).
  - In a turn that holds outside content, adding feedback is a guarded step (007, "Outside
    content"). An approval card shows the text of the feedback, and the feedback is added after the
    user allows it. At "Full access" no card shows, as for other guarded steps, unless the turn holds
    the program mark (007).
- **Facts only**: the answers come from the facts of the run. The responsible document does not
  invent a state or a result. When the workflow never ran, it says "No run yet." When no run works
  or waits, it says so and tells the state of the last run.

## Self-improvement

After a run, and in a turn of the chat, the responsible document can propose changes to its workflow.
The user accepts, edits or rejects each proposal. A proposal applies only after the user accepts it.
No change applies without the approval of the user. ROBot does not train or change a model (000).
This is the only flow for proposals: the memory proposals of 008 use it.

### Concepts

- **Proposal**: one change of the workflow that the responsible document proposes. It has a kind, a
  target, the new text, the old text for a change, a reason, a source, a time and a state. A proposal
  is not a change. The workflow does not read a proposal as its responsible document, prompt, graph
  or memory.
- **Kinds**:
  - **Document change**: a new text for the responsible document of this workflow.
  - **Prompt change**: a new prompt for one node of this workflow.
  - **Graph change**: a change of the nodes and the connections of the graph. A graph change can
    set the model of a node only to a value that the account of the node offers (006). It never sets
    the permission level of a node.
  - **Memory item**: a new fact for the memory of this workflow (008).
- **Target**: what a proposal changes. For a document change, the responsible document. For a
  prompt change, that node. For a graph change, the graph. Each memory item is its own target,
  because it does not exist yet.
- **Reason**: one line from the responsible document that says what in the work led to the proposal.
  At most 200 characters.
- **Source**: a run of the workflow, with a link to it; a turn of the chat, with a link to it; or a
  memory check (008).
- **State**: one of these.
  - **Waiting**: the proposal waits for the user.
  - **Applied**: the user accepted it, and the change is made.
  - **Rejected**: the user rejected it, or it expired. Nothing changed.
  - **Failed**: the user accepted it, and the change could not be made. Nothing changed.
  - **Undone**: the change was applied, and then the user undid it: with "Undo" in the change log,
    or, for a memory item, with "Undo" in the memory history (008). The change is not there any
    more. Only an Applied row can become Undone.
- **Switch "Self-improvement"**: a switch of the workflow, on by default. When it is off:
  - The responsible document cannot make a document change, a prompt change or a graph change.
  - No memory item is saved by itself. A new fact is a proposal, as with "Ask me first"
    (008), also when the choice "Memory saving" of the workflow is "Save at once". The choice stays
    as the user set it, and it counts again when the switch goes on.
  - Proposals that wait stay.
  So with the switch off, nothing changes the workflow before the user accepts a card.
- **Change log**: the list of the proposals that do not wait any more, with their state.

### Flows

1. **Propose**: after a run, or in a turn of the chat, the responsible document can propose a
   change. The app checks the limits (see "Limits"). When the proposal passes, it is Waiting. In a
   turn of the chat, the chat shows a muted line after the reply: "Suggested a change to the
   responsible document", "Suggested a change to the prompt of node <number>", "Suggested a change to
   the graph", or "Suggested for memory". The line has the link "Review". After a run, the proposal
   waits on the page, and the workflow list shows that one waits. When the proposal does not pass,
   nothing is made, and the responsible document gets the reason. When the reason is that 20
   proposals wait, the chat also shows one muted line (see "How many wait").
2. **See**: the workflow has the page "Self-improvement" with two tabs. "Waiting" lists the proposals
   that wait, oldest first. "Change log" lists the change log, newest first. The link "Review" opens
   the card in "Waiting". The memory page (008) has the link "Proposals (N)" to the same tab.
3. **Card**: a card shows the kind, the target, the reason, the source and the time. For a document
   change and a prompt change, it shows the old text and the new text, with the removed and the
   added parts marked. For a graph change, it shows the nodes and the connections that are added,
   changed or removed, and the state of the check for the new graph (010). For a memory item, it
   shows the full text. The card has three buttons: "Accept", "Edit and accept", and "Reject".
   - **Accept** makes the change as the card shows it. The state is Applied.
   - **Edit and accept** opens the new text in an editor in the card. For a graph change, it opens
     the new graph in the editor of the workflow (010). The user changes the text or the graph and
     saves. The edited text or graph is the change. The same limits and checks apply as in the
     editor. A change that does not pass shows the reason and is not saved. "Cancel" closes the
     editor, and the proposal still waits.
   - **Reject** changes nothing. The state is Rejected, with the reason "Rejected by you".
4. **Apply**: the change counts from the next turn and from the next run. A turn or a run that
   works keeps what it had (010).
   - Document change: a new version in the history of the responsible document, from "a proposal
     that the user accepted".
   - Prompt change: the node gets the new prompt. The graph before the change is kept as a version
     (010).
   - Graph change: the workflow gets the new graph. The graph before the change is kept as a
     version (010).
   - Memory item: a memory item that came from a proposal, and a row in the memory history (008).
5. **Fail**: when the change cannot be made at the moment of the accept, nothing changes. The state
   is Failed, and the change log row shows the reason. The reasons are:
   - The target changed after the proposal: "The responsible document changed after this
     proposal.", "The node changed after this proposal.", or "The graph changed after this
     proposal."
   - The node is deleted.
   - The new graph fails the check (010). A change that fails the check cannot be accepted. The card
     shows the problem, and "Accept" is off.
   - A run of the workflow works. The editor is read-only then (010). The card says "Accept when the
     run ends."
   - Memory is off for the workflow, or the same text is already an item (008).
   A failed proposal does not come back. The responsible document can make a new proposal.
6. **Change log row**: the kind, the target, the state, the time of the answer, and the source. A
   row for Applied shows the old text and the new text and has the button "Undo". A row for
   Rejected or Failed shows the reason and has no button.
7. **Undo**: Undo puts back the version before the change.
   - Document change: the responsible document gets the old text again, with a new version from Undo
     in the history.
   - Prompt change and graph change: the workflow gets the graph from before the change. The
     current graph is kept as a version (010).
   - Memory item: the item is removed. This is the same undo as the one in the memory history (008),
     and each place shows the result of the other.
   - Undo is on only while the target is exactly as the change left it. Otherwise Undo is off, and
     the row says: "A newer change exists. Undo that one first."
   - After an undo, the state of the row is Undone. The row shows "Undone" and the time, and has no
     button. The history and the memory history keep their own rows for the undo.

### Limits

- **How often**: in one turn of the chat or after one run, the responsible document makes at most 1
  proposal of the kinds document change, prompt change and graph change together. In 24 hours, it
  makes at most 3 proposals of these kinds for one workflow. Only a proposal that passes all limits
  counts. A refused proposal does not count. A memory check makes memory items only, at most 5 (008).
- **One for each target**: at most one proposal waits for the responsible document, at most one for
  each node, and at most one for the graph. A second proposal for the same target is refused, and the
  responsible document gets the reason: one waits. A memory item with the same text as an item or as
  another proposal is refused (008).
- **How many wait**: at most 20 proposals wait for each workflow, of all kinds together. When 20
  wait, a new proposal of any kind is refused. No proposal that waits is replaced, so memory items
  never push out a document change. The user sees one muted line: "20 proposals wait. Answer some
  before the responsible document can propose more." The line shows in the chat after the reply of
  the turn that made the refused proposal, and at the top of the tab "Waiting" while 20 wait. A proposal that waits
  for 30 days goes to Rejected with the reason "Expired".
- **Size**:
  - Document change: the new text is at most 20000 characters. The removed text and the added text
    together are at most 2000 characters.
  - Prompt change: the new prompt follows the limit of a node prompt (010). The removed text and
    the added text together are at most 2000 characters.
  - Graph change: the rules of the graph (010).
  - Memory item: at most 500 characters (008).
  - A proposal over a limit is refused, and the responsible document gets the limit.
- **What a proposal never touches**: the name of the workflow; the folder and the permission levels
  of the workflow and of its nodes (007, 010); the trigger (010); keys, saved secrets (020) and saved
  logins; the connections (018); the switches of the workflow, also memory, the memory check and
  "Self-improvement"; sync, devices and the Teams link (028); and other workflows. No kind of
  proposal covers these. Text in a proposal that asks for one of these changes nothing outside the
  text.
- **Secrets**: a proposal with text that looks like a secret (014) is refused. The responsible
  document gets the order to leave the secret out.
- **Outside content**: a turn or a run that holds outside content (007) can make a proposal. Its card
  then shows the muted line: "This work read outside content. Read the change before you accept."
  Nothing applies before the user accepts, so no approval card shows at the moment of the proposal.
- **No change without approval**: no change applies without the approval of the user. The
  responsible document has no other way to change the responsible document, the prompts, the graph
  or the memory of its workflow. One case is not a proposal, because the user decided first: "Save
  at once" for new memory items (008). A new workflow starts at "Ask me first". "Save at once" is a choice that the user
  makes on purpose for one workflow, on its memory page. No import or sync sets it. It counts only
  while the switch "Self-improvement" is on.

### States

- **None**: a state of the page, not of a proposal: the workflow has no proposal that waits and no
  row in the change log. The tab "Waiting" shows one muted line: "No proposals. When the responsible
  document sees a better way of work, it proposes a change here, and you decide." The tab "Change
  log" shows "No changes yet."
- **Switch off**: the tab "Waiting" shows "Self-improvement is off for this workflow." above the
  proposals that still wait.
- **Waiting**: the cards, and the number on the page.
- **Full**: 20 proposals wait. The tab "Waiting" shows the line of "How many wait" above the cards.
- **Applied, Rejected, Failed, Undone**: the rows of the change log, with their reason. The states
  stay after a restart.

### Surfaces

- **Ways in**: the responsible document after a run and in a turn of the chat, and a memory check
  (008). The user answers in the tab "Waiting", from the link "Review" in the chat, or from the link
  on the memory page.
- **Devices**: the page and the cards are on the computer that holds the proposal. A linked device
  (012) and the phone (011) do not show them. There, the muted line in the chat is plain text with
  no link.
- **Runtimes**: when the model that makes the proposal is a program of another vendor that cannot
  use the tools of the app (006), the switch is off for the workflow, with the muted line "<program>
  cannot use self-improvement."
- **Ways out**: "Reject" for a card, "Undo" for an applied change, and the switch for the workflow.
- **Data**: proposals and the change log are in the local database of the profile (014).
  - They do not sync (019). They stay on the computer that holds them.
  - An export of data (014) holds them, as it holds the rest of the database. An import of that
    export restores them with the workflow.
  - A workflow file holds neither (010, "File").
  - An applied change is data of its target, so it follows the sync and export rules of that
    target: a change of the responsible document, a prompt, a graph and a memory item sync (019).
  - The change log keeps 90 days and at most 1000 rows for each workflow. The oldest rows go first.
  - Deleting a workflow deletes its proposals and its change log.
- **Words**: the texts come from the catalogue in English and Korean (see
  [docs/glossary.md](../docs/glossary.md)). No text says that a model learns, trains or evolves
  (000).

| English | Korean |
| --- | --- |
| Self-improvement | 자기 개선 (proposed) |
| Proposal | 제안 |
| Proposals (N) | 제안 (N) (proposed) |
| Waiting | 대기 중 (proposed) |
| Change log | 변경 기록 (proposed) |
| Accept | 수락 (proposed) |
| Edit and accept | 수정 후 수락 (proposed) |
| Reject | 거절 (proposed) |
| Undo | 되돌리기 |
| Undone | 되돌림 (proposed) |
| Responsible document | 담당 문서 (proposed) |

## States

- **No run**: when the workflow never ran, the responsible document answers a question about a run
  with "No run yet." When no run works or waits, it says so and tells the state of the last run.
- **Run works or waits**: the responsible document answers from the state of the run, and takes
  feedback.
- **Run ended**: the responsible document answers from the state of the ended run. It takes no
  feedback for that run. The user can still write in the chat, and the responsible document can make
  a proposal.

## Rules

- Changing the responsible document keeps the history, the memory and the folder of the workflow.
- The responsible document cannot be deleted alone. It goes with its workflow.
- A linked device that the user allows can read and change the responsible document of a workflow
  on this computer, with the same right that it has for the workflow (012).

## Surfaces

- **Ways in**: the editor of the workflow, the chat (003), and the page "Self-improvement".
- **Devices**: this computer shows and changes the responsible document. A linked device (012) sees
  it. The phone has no editor (011).
- **Ways out**: the user restores a version, undoes an accepted proposal, and turns off
  "Self-improvement".
- **Seeing the state**: the card of a workflow shows the state of the last run (010). The
  responsible document tells the state of a run in the chat when the user asks. The state of a run
  stays after a restart (010).
- **Data**: see "Responsible document", "Responsible document history" and "Self-improvement".

## Out of scope

- A list of responsible documents, a page for each one, a face or an avatar, a role line, a main
  responsible document, and starters (see the questions for 002).
- A handbook and role instructions (see the questions for 002).
- A responsible document that two workflows share.

## Acceptance

- Press "New workflow" and type "Weekly": the workflow has a responsible document with a short
  default text. Edit the text and save: the next reply of the chat uses it. A reply that works keeps
  the old text.
- Empty the responsible document and save: the save works. A node still runs with its own prompt.
- Type a text of 20001 characters: the save is refused, with the reason. Type a text that looks like
  a key: the save is refused, with the reason.
- Change the responsible document three times, and restore the first version: the document has the
  first text, and the history has a new version.
- Ask the chat to change the responsible document: the chat shows a card, and the document does not
  change. Press "Accept": the history has a version from a proposal.
- Start a run of three nodes. After node 1 ends and node 2 works, ask "How far is it?": the answer
  says that node 1 is done, node 2 is running, and the run has not reached node 3.
- A node fails. Ask "Why did it stop?": the answer names the node and the reason of the failure.
- A decision node asks the user to pick an option. Ask "Why does it wait?": the answer says that the
  run waits for the pick of the user at that node.
- Stop a run and ask why it stopped: the answer says that the user stopped it.
- While node 2 works, ask for the results so far: the answer gives the result of node 1.
- While node 2 works, write feedback on the result of node 1: the chat shows a muted line that the
  feedback was added to the run. Node 3 gets the feedback with its input. Node 1 does not run again.
  The graph and the prompts do not change.
- Write feedback when no run works: the responsible document says that no run works, and the
  feedback is not added to a run.
- A message from Teams says "Node 2 is too long." while a run works: it is not feedback, and the run
  does not change.
- A turn holds outside content, and the workflow is at "Ask for risky steps". The user writes
  feedback on a result: an approval card shows the text of the feedback and "This turn holds outside
  content". Press "Deny": the run gets no feedback. At "Full access", the same feedback is added
  with no card.
- Ask about a run when no run exists: the answer is "No run yet."
- With a stand-in model, a run ends and the responsible document proposes a document change with a
  reason. The page "Self-improvement" shows it in "Waiting". The document does not change, and the
  next request holds the old text. Open the card: it shows the old and the new text with the
  changes marked. Press "Accept": the history has a version from a proposal, the change log has a
  row Applied, and the next request holds the new text. Press "Undo" on the row: the document has
  the old text, the history has a version from Undo, and the row shows "Undone".
- Press "Edit and accept" on a document change, change one word, and save: the document has the
  edited text.
- Press "Reject" on a proposal: nothing changes, and the change log has a row Rejected.
- A stand-in model proposes a prompt change for node 2. Press "Accept": node 2 has the new prompt,
  and the version list holds the graph from before. Press "Undo" on the row: node 2 has its old
  prompt, and the row is Undone.
- A stand-in model proposes a graph change that leaves a node that no run can reach: the card shows
  the problem of the check, and "Accept" is off.
- A graph change waits. Delete the node that it changes, then press "Accept": the state is Failed,
  and the row shows the reason. Nothing is made.
- A document change waits. The user edits the document in the editor, then presses "Accept" on the
  card: the state is Failed with "The responsible document changed after this proposal.", and the
  document keeps the text of the user.
- A document change waits, and the stand-in model proposes a second one: the app refuses it and
  the responsible document gets the reason: one waits. A fourth proposal of the kinds document,
  prompt and graph in 24 hours is refused. A second one in one turn is refused.
- A stand-in model proposes a document change that removes and adds 2001 characters: the app
  refuses it. A proposal with a text that looks like a key is refused, and the responsible document
  is told to leave the secret out.
- A stand-in model tries to propose a change of the folder or the permission level: no such kind of
  proposal exists, and nothing waits.
- With 20 proposals that wait, a document change among them, a stand-in model proposes a memory item:
  the app refuses it, the 20 proposals still wait, and the chat shows "20 proposals wait. Answer
  some before the responsible document can propose more." The tab "Waiting" shows the same line.
- With a test clock, a proposal waits for 30 days: it leaves the tab "Waiting", and the change log
  has a row Rejected with "Expired". Nothing changed.
- With a test clock, a change log row is 91 days old: it is not in the change log any more. The
  change that it made stays.
- Accept a document change, then edit the document in the editor: "Undo" on the change log row is off
  and says "A newer change exists. Undo that one first."
- A run is going. Press "Accept" on a graph change: the card says "Accept when the run ends." After
  the run ends, "Accept" works.
- A turn that read a web page proposes a document change: the card shows "This work read outside
  content. Read the change before you accept.", and the document changes only after "Accept".
- Turn "Self-improvement" off: no document, prompt or graph change can be proposed. With "Ask me
  first" in memory, a memory item still waits as a proposal. Set "Save at once", keep the switch
  off, and tell the workflow a fact: no item is saved, and the fact waits as a proposal. Turn the
  switch on again: the proposals that waited are still there, and the next fact is saved at once.
- Make a new workflow: its choice "Memory saving" is "Ask me first". Tell it a fact: no item is
  saved, and the fact waits as a proposal.
- In the chat, ask the responsible document to turn off "Self-improvement": nothing changes, and the
  responsible document says where the user can change it.
- A manage tool (037) or an outside program (023) tries to change the responsible document: the app
  has no such change, and the history has no new version.
- Export the data of the profile with a proposal that waits and a row Applied in the change log.
  Import it into an empty app: the proposal still waits, and the row is in the change log.
- Open the same workflow on a linked device: no page "Self-improvement" shows, and the line in the
  chat has no link.
- Delete a workflow: its responsible document, its history, its proposals and its change log are
  deleted with it.
