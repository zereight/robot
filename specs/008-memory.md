# 008 Memory

## Purpose

A workflow remembers useful facts across runs and chats. The user sees what it keeps, decides what
it may keep, and can undo a change.

## Concepts

- **Memory item**: a short text, the workflow it belongs to, when it was made, and where it came
  from (a node, the user, or a proposal).
- **Scope**: one workflow. Workflows do not read each other's memory.
- **Memory tool**: the tool with which a text node saves, suggests, searches and reads facts (007).
  A decision node has no memory tool (010). The app does not put memory items into a prompt by
  itself. A text node gets a memory item only when it reads it with the memory tool.
- **Memory saving**: a choice for each workflow. It sits on the memory page of the workflow, above
  the tabs. "Ask me first" is the default: a text node can only suggest a fact, and the user
  decides. "Save at once": a text node saves a fact as a memory item. "Save at once" is a choice
  that the user makes on purpose for one workflow (002, "Self-improvement", "No change without
  approval").
- **Proposal**: a fact that a text node suggests and the user has not accepted. It is a proposal of
  the kind "Memory item" of self-improvement (002, "Self-improvement"). That section holds the
  card, the states, the change log and the limits that all proposals share. A proposal is not
  memory. A node does not read it.
- **History**: the list of changes to the memory of one workflow.
- **Memory check**: a choice for each workflow, off by default. When it is on, the app gives the
  workflow a short turn after every 10 done tasks, to find facts that no node saved.

Whether the responsible document can use the memory tool in the chat of the workflow is not decided
(see the questions for 008).

## Flows

1. A text node finds a lasting fact (a preference, a name, a decision).
   - With "Save at once", it saves a memory item. The run view shows a muted "Saved to memory"
     line with an undo control. The control does the same as "Undo" in the history (see 4).
   - With "Ask me first", it makes a proposal. The run view shows a muted "Suggested for memory"
     line with the link "Review", which opens the card (002, "Self-improvement").
2. The user opens the memory page of the workflow. Where the page opens from is not decided (see
   the questions for 008). Under the page title, above the choice "Memory saving" and the tabs, one
   muted line says how a workflow gets better: through its responsible document, the prompts of its
   nodes, its graph, its memory and its skills, and through the proposals that the user accepts.
   The line also says that ROBot does not train the model (see 000). It shows on every tab, when
   the list is empty, and when memory is off. The page has two tabs.
   - **Items**: a list, newest first, with search. The user can add, edit, or delete items.
   - **History**: the changes, newest first.
   When a proposal of a memory item waits, the page shows the link "Proposals (N)" above the tabs.
   It opens the tab "Waiting" of the page "Self-improvement" (002).
3. The user answers a proposal on its card (002, "Self-improvement"): "Accept", "Edit and accept",
   or "Reject". Accept and Edit and accept make a memory item. Reject makes no item.
4. A history row shows the time, who made the change (the user, a node, a proposal that the user
   accepted, or an undo), and the kind (added, edited, deleted) with the text. An edit shows the
   text before and after. A row has the button "Undo".
   - Undo of "added" removes the item. Undo of "edited" puts back the text before. Undo of
     "deleted" makes the item again with its text.
   - Undo is on only while the item is exactly as that change made it. After an edit, the item
     has the new text. After a deletion, the item is missing. Otherwise Undo is off, and the row
     says: "A newer change exists. Undo that one first."
   - An undo is a change too. It has its own row, and the user can undo it.
5. A text node reads memory with the memory tool: it searches the items and reads the ones that
   relate to its work. The tool returns items up to a limit set by the size of the context of the
   model.
6. Memory check: the choice "Memory check" is on the memory page, under "Memory saving". Its text
   says that each check is a turn of a model and uses an account of the user. "Check now" runs a
   check at once with the tasks since the last check. It is off when there are none.

## Rules

- Memory is stored locally with the workflow.
- Deleting a workflow deletes its memory, its proposals and its history.
- The user can turn memory off for a workflow. Existing items stay but are not used. A text node of
  a workflow with memory off has no tool to save, to suggest, to search or to read earlier messages
  of the chat (see 007). The tabs stay open and the user can still change items.
- The memory tool accepts a text of at most 500 characters, for an item and for a proposal. It
  refuses a longer text and tells the node. The user can type longer items by hand.
- A proposal with the same text as an item or as another proposal is not added. Spaces at both
  ends and the case of letters do not matter. The tool tells the node that the fact is known.
- How many proposals wait, and when they expire, is in 002, "Self-improvement", "Limits". The
  limit is for all kinds of proposals of the workflow together. When 20 wait, a new memory
  proposal is refused. It does not replace a proposal that waits.
- A new workflow starts at "Ask me first". No node, import or sync sets "Save at once". Only the
  user sets it, on the memory page of one workflow.
- "Save at once" is the choice of the user for new memory items of this workflow. It does not cover
  a change of the responsible document, of a node prompt or of the graph (002). With "Save at
  once", an item is saved with no card, and Undo stays.
- "Save at once" counts only while the switch "Self-improvement" of the workflow is on (002). With
  the switch off, a new fact is a proposal, as with "Ask me first". The choice stays as the user
  set it.
- A change of the choice leaves the proposals as they are. After the change to "Save at once",
  the proposals wait until the user answers them.
- The memory tool refuses a text that looks like a secret (see 014). It does not save it and does
  not suggest it, and it tells the node to leave the secret out. The user can type such a text
  by hand.
- A save in a task that holds outside content asks first (see 007, "Outside content"). So a
  web page cannot put a lasting order into the memory of a workflow. This holds for "Save at
  once". A proposal is not memory, so a proposal in such a task needs no approval card. The user
  still decides on the card of the proposal, which says that the work read outside content (002).
- Each change to an item makes a history row. A change that arrives by sync (019) makes none.
  Such a change can turn an Undo off, because the item is not as that row left it.
- History keeps 90 days and at most 1000 rows for each workflow. The oldest rows go first.
  Removing a row does not change an item.
- A history row whose text looks like a secret shows "[redacted]" in place of the text and has no
  Undo.
- The link in the line "Suggested for memory" and the undo control in the line "Saved to memory"
  work on the computer where the change was made. On a linked device (012) and on the other
  computer of a sync pair (019), the lines are plain text with no link and no undo control.
- Memory items sync (019) with the workflow, and an export holds them (014). A workflow file (010)
  holds no memory.
- A linked device (012) sees the memory page. It can change an item or a choice only when the
  server allows it to change workflows (012).
- The memory page shows one muted line with this fact: the model does not learn. The workflow keeps
  what the user can see and edit (see 000).

### Memory check

- The count: each task of a text node that ends as done adds 1. A task that fails, is stopped, is
  cancelled or ends as Blocked adds nothing. A task of a decision node adds nothing. A memory check
  adds nothing. A restart keeps the count. The count is 0 when the choice goes on. Whether a turn
  of the chat adds to the count is not decided (see the questions for 008).
- At 10, the app adds a check to the queue of the workflow (005). It runs when the workflow has no
  task that runs or waits. The count goes to 0 when the check starts.
- The check is a turn that no node makes. It posts no message in any place, and it makes no
  notification, also when it fails. Where the user sees it, and where its usage shows, is not
  decided (see the questions for 008).
- What the check reads: the input and the result of the tasks that it counted, at most 20000
  characters, the newest first; and the items and proposals of the workflow. It reads no tool
  output, no web page and no file.
- In the check, the model has one tool: suggest a fact. It can make at most 5 proposals. It makes
  proposals also when the choice "Memory saving" is "Save at once", so the user decides each one.
  The proposal rules above and in 002 hold: 500 characters, no duplicates, no secrets, at most 20
  that wait. The card shows "From a memory check" as the source. A check makes no change of the
  responsible document, of a node prompt or of the graph.
- Which provider, model and reasoning level the check uses is not decided (see the questions for
  008).
- With memory off, no check runs and the count does not grow.
- On a sync pair (019), the check runs on the computer that runs the workflow (010). The count is
  local to each computer. Proposals do not sync (019), so the proposals of a check stay on the
  computer that ran it.
- A linked device (012) sees the choice. It can change it only when the server allows it to change
  workflows (012).

## Out of scope

- Memory shared between workflows.
- Notes that the app writes by itself, with no tool call of a node.
- Data of the earlier version of ROBot. Its memory items are not moved (see 000).

## Acceptance

- A text node saves a preference with "Save at once". A later run of a text node reads it with the
  memory tool and uses it. Delete the item: the node does not find it.
- A node prompt asks for no memory tool. The request to the model holds no memory item.
- Set "Ask me first". A text node suggests a preference. The tab Items has no new item, and the tab
  "Waiting" of "Self-improvement" has one card. Press "Accept": the item shows in Items, History
  has a row "added" by a proposal that the user accepted, and the change log has a row Applied. A
  later run finds the preference.
- Reject a proposal: it leaves the tab "Waiting", the change log has a row Rejected, and no item
  and no history row is made.
- Accept a proposal, then press "Undo" in the change log: the item is gone, and History has a row
  for the undo. The Undo of the row "added" in History is then off.
- Edit an item twice. Undo of the first edit is off and shows the reason. Undo the second edit,
  then the first: the item has the text that it had before the first edit. Undo the last undo:
  the item has the text of the first edit again.
- Delete an item, then press Undo on its row: the item is back with its text.
- A text node tries to remember a text that looks like a key: no item and no proposal is made, and
  the node is told to leave the secret out.
- Make 21 proposals: the 21st is refused. The tab "Waiting" shows the first 20 and the line "20
  proposals wait. Answer some before this workflow can suggest more." No proposal is in the change
  log as Rejected.
- Make a new workflow: "Memory saving" is "Ask me first".
- A text node saves a fact twice: the second call adds nothing, and the node is told that the fact
  is known.
- Turn memory off: the text nodes have no memory tools. The items stay in the tab.
- A decision node of a workflow has no memory tool.
- Open the memory page: one muted line says that the model does not learn and that the workflow
  keeps what the user can see and edit.
- Open the same workflow on a linked device: the line "Saved to memory" has no undo control.
- Set "Save at once", and turn "Memory check" on. After 10 done tasks of text nodes, a memory check
  runs when the workflow has no task that runs or waits. A stand-in model suggests 2 facts: the tab
  "Waiting" shows 2 proposals "From a memory check", and no item is made. A failed task does not
  count toward the 10.
- With "Memory check" on and 3 done tasks since the last check, press "Check now": a check runs at
  once. With no task since the last check, "Check now" is off.
- Delete a workflow: its memory, its proposals and its history go with it.
