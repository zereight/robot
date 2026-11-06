# 008 Memory

## Purpose

An agent remembers useful facts across chats. The user sees what it keeps, decides what it may
keep, and can undo a change.

## Concepts

- **Memory item**: a short text, the agent it belongs to, when it was made, and where it came from
  (a message, the user, or a proposal).
- **Scope**: one agent. Agents do not read each other's memory.
- **Memory saving**: a choice for each agent. It sits on the memory page of the agent, above the
  tabs. "Ask me first" is the default: the agent can only suggest a fact, and the user decides.
  "Save at once": the agent saves a fact as a memory item. "Save at once" is a choice that the user
  makes on purpose for one agent (002, "Self-improvement", "No change without approval").
- **Proposal**: a fact that an agent suggests and the user has not accepted. It is a proposal of
  the kind "Memory item" of self-improvement (002, "Self-improvement"). That section holds the
  card, the states, the change log and the limits that all proposals share. A proposal is not
  memory. The agent does not read it.
- **History**: the list of changes to the memory of one agent.
- **Memory check**: a choice for each agent, off by default. When it is on, the app gives the
  agent a short turn after every 10 done turns, to find facts that it did not save.

## Flows

1. The agent finds a lasting fact (a preference, a name, a decision).
   - With "Save at once", it saves a memory item. The chat shows a muted "Saved to memory" line
     with an undo control. The control does the same as "Undo" in the history (see 4).
   - With "Ask me first", it makes a proposal. The chat shows a muted "Suggested for memory"
     line with the link "Review", which opens the card (002, "Self-improvement").
2. The user opens the memory page of the agent. Under the page title, above the choice "Memory
   saving" and the tabs, one muted line says how an agent gets better: through its Soul, memory,
   knowledge and skills, and through the proposals that the user accepts. The line also says that
   ROBot does not train the model (see 000). It shows on every tab, when the list is empty, and
   when memory is off. The page has two tabs.
   - **Items**: a list, newest first, with search. The user can add, edit, or delete items.
   - **History**: the changes, newest first.
   When a proposal of a memory item waits, the page shows the link "Proposals (N)" above the tabs.
   It opens the tab "Waiting" of the page "Self-improvement" (002).
3. The user answers a proposal on its card (002, "Self-improvement"): "Accept", "Edit and accept",
   or "Reject". Accept and Edit and accept make a memory item. Reject makes no item.
4. A history row shows the time, who made the change (the user, the agent, a proposal that the
   user accepted, or an undo), and the kind (added, edited, deleted) with the text. An edit shows
   the text before and after. A row has the button "Undo".
   - Undo of "added" removes the item. Undo of "edited" puts back the text before. Undo of
     "deleted" makes the item again with its text.
   - Undo is on only while the item is exactly as that change made it. After an edit, the item
     has the new text. After a deletion, the item is missing. Otherwise Undo is off, and the row
     says: "A newer change exists. Undo that one first."
   - An undo is a change too. It has its own row, and the user can undo it.
5. Before each turn, the agent gets the memory items that relate to the new message, up to a
   limit set by the size of the model's context.
6. Memory check: the choice "Memory check" is on the memory page, under "Memory saving". Its text
   says that each check is a turn of the model and uses the account of the agent. "Check now" runs
   a check at once with the turns since the last check. It is off when there are none.
7. Make a skill: the menu of a row in the tab Items has "Make a skill". The model of the agent
   writes a draft skill from the text of the item, and the draft is a proposal of a new skill (see
   017, "Make a skill from work"). It is on the computer only.

## Rules

- Memory is stored locally with the agent.
- Deleting an agent deletes its memory, its proposals and its history. Archiving keeps them.
- The user can turn memory off per agent. Existing items stay but are not used. An agent with
  memory off has no tool to save, to suggest, to search or to read past chats (see 007). The tabs
  stay open and the user can still change items.
- The memory tool accepts a text of at most 500 characters, for an item and for a proposal. It
  refuses a longer text and tells the agent. The user can type longer items by hand.
- A proposal with the same text as an item or as another proposal is not added. Spaces at both
  ends and the case of letters do not matter. The tool tells the agent that the fact is known.
- How many proposals wait, and when they expire, is in 002, "Self-improvement", "Limits". The
  limit is for all kinds of proposals of the agent together. When 20 wait, a new memory proposal is
  refused. It does not replace a proposal that waits.
- A new agent starts at "Ask me first". No agent, starter, import or sync sets "Save at once". Only
  the user sets it, on the memory page of one agent. An agent that had "Save at once" from the old
  default, before this version, has "Ask me first" after the update, because the user did not
  choose it.
- "Save at once" is the choice of the user for new memory items of this agent. It does not cover a
  Soul change or a skill (002). With "Save at once", an item is saved with no card, and Undo stays.
- "Save at once" counts only while the switch "Self-improvement" of the agent is on (002). With the
  switch off, a new fact is a proposal, as with "Ask me first". The choice stays as the user set it.
- A change of the choice leaves the proposals as they are. After the change to "Save at once",
  the proposals wait until the user answers them.
- The memory tool refuses a text that looks like a secret (see 014). It does not save it and does
  not suggest it, and it tells the agent to leave the secret out. The user can type such a text
  by hand.
- A save in a turn that holds outside content asks first (see 007, "Outside content"). So a
  web page cannot put a lasting order into the memory of an agent. This holds for "Save at
  once". A proposal is not memory, so a proposal in such a turn needs no approval card. The user
  still decides on the card of the proposal, which says that the work read outside content (002).
- Each change to an item makes a history row. A change that arrives by sync (019) makes none.
  Such a change can turn an Undo off, because the item is not as that row left it.
- History keeps 90 days and at most 1000 rows for each agent. The oldest rows go first. Removing
  a row does not change an item.
- A history row whose text looks like a secret shows "[redacted]" in place of the text and has no
  Undo.
- The link in the line "Suggested for memory" and the undo control in the line "Saved to memory"
  work on the computer where the change was made. On a linked device (012) and on the other
  computer of a sync pair (019), the lines are plain text with no link and no undo control.
- Memory items sync (019) and an export holds them (014). An agent file (002) holds no memory.

### Memory check

- The count: each turn of the agent that ends as done adds 1: a chat, a routine and a workflow
  step. A turn that fails, stops, is cancelled or ends as Blocked adds nothing. A turn of a
  memory check adds nothing. A restart keeps the count. The count is 0 when the choice goes on.
- At 10, the app adds a check to the queue of the agent (005). It runs when the agent has no other
  task. The count goes to 0 when the check starts.
- The check is a task with the source "memory check". It shows on the Tasks page and on the usage
  page. It posts no message in any place, and it makes no notification, also when it fails.
- What the check reads: the messages of the user and the replies of the agent in the turns that it
  counted, at most 20000 characters, the newest first; and the items and proposals of the agent.
  It reads no tool output, no web page and no file.
- In the check, the agent has one tool: suggest a fact. It can make at most 5 proposals. It makes
  proposals also when the choice "Memory saving" is "Save at once", so the user decides each one.
  The proposal rules above and in 002 hold: 500 characters, no duplicates, no secrets, at most 20
  that wait. The card shows "From a memory check" as the source. A check makes no Soul change and
  no skill.
- The check uses the model and effort of the agent. It needs the tool "suggest a fact" of the app.
  An agent on a vendor runtime (006) that cannot call the tools of the app cannot use the check:
  the choice is off for that agent, with the muted line "<program> cannot use the memory check."
- With memory off, no check runs and the count does not grow.
- On a sync pair (019), the check runs on the computer that ran the turn that made the count 10.
  The count is local to each computer. Proposals do not sync (019), so the proposals of a check
  stay on the computer that ran it.
- A linked device (012) sees the choice. It can change it only with the switch "Can create and
  change agents".

## Out of scope

- Memory shared between agents.
- Notes that the app writes by itself, with no tool call of the agent.

## Acceptance

- Tell an agent a preference, open a new chat: it uses the preference. Delete the item: it does
  not.
- Set "Ask me first". Tell the agent a preference. The tab Items has no new item, and the tab
  "Waiting" of "Self-improvement" has one card. Press "Accept": the item shows in Items, History
  has a row "added" by a proposal that the user accepted, and the change log has a row Applied. A
  new chat uses the preference.
- Reject a proposal: it leaves the tab "Waiting", the change log has a row Rejected, and no item
  and no history row is made.
- Accept a proposal, then press "Undo" in the change log: the item is gone, and History has a row
  for the undo. The Undo of the row "added" in History is then off.
- Edit an item twice. Undo of the first edit is off and shows the reason. Undo the second edit,
  then the first: the item has the text that it had before the first edit. Undo the last undo:
  the item has the text of the first edit again.
- Delete an item, then press Undo on its row: the item is back with its text.
- Ask the agent to remember a text that looks like a key: no item and no proposal is made, and
  the agent says that it left the secret out.
- Make 21 proposals: the 21st is refused. The tab "Waiting" shows the first 20 and the line "20
  proposals wait. Answer some before this agent can suggest more." No proposal is in the change log
  as Rejected.
- Make a new agent: "Memory saving" is "Ask me first".
- Ask the agent to save a fact twice: the second call adds nothing, and the agent is told that the
  fact is known.
- Turn memory off: the agent has no memory tools. The items stay in the tab.
- Open the same agent on a linked device: the line "Saved to memory" has no undo control.
- Set "Save at once", and turn "Memory check" on. After 10 done turns, a task "memory check" runs
  when the agent is free. A stand-in model suggests 2 facts: the tab "Waiting" shows 2 proposals
  "From a memory check", and no item is made. A failed turn does not count toward the 10.
- With "Memory check" on and 3 done turns since the last check, press "Check now": a check runs at
  once. With no turn since the last check, "Check now" is off.
