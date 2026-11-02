# 008 Memory

## Purpose

An agent remembers useful facts across chats. The user sees what it keeps, decides what it may
keep, and can undo a change.

## Concepts

- **Memory item**: a short text, the agent it belongs to, when it was made, and where it came from
  (a message, the user, or a proposal).
- **Scope**: one agent. Agents do not read each other's memory.
- **Memory saving**: a choice for each agent. It sits on the memory page of the agent, above the
  tabs. "Save at once" is the default: the agent saves a fact as a memory item. "Ask me first":
  the agent can only suggest a fact, and the user decides.
- **Proposal**: a fact that an agent suggests and the user has not accepted. A proposal is not
  memory. The agent does not read it.
- **History**: the list of changes to the memory of one agent.

## Flows

1. The agent finds a lasting fact (a preference, a name, a decision).
   - With "Save at once", it saves a memory item. The chat shows a muted "Saved to memory" line
     with an undo control. The control does the same as "Undo" in the history (see 4).
   - With "Ask me first", it makes a proposal. The chat shows a muted "Suggested for memory"
     line with a link that opens the tab Proposals.
2. The user opens the memory page of the agent. Under the page title, above the choice "Memory
   saving" and the tabs, one muted line says how an agent gets better: through its instructions,
   memory and knowledge, and through skills that the user saves. The line also says that ROBot
   does not train the model (see 000). It shows on every tab, when the list is empty, and when
   memory is off. The page has three tabs.
   - **Items**: a list, newest first, with search. The user can add, edit, or delete items.
   - **Proposals**: the proposals, oldest first. The tab shows when the choice is "Ask me first"
     or when a proposal waits.
   - **History**: the changes, newest first.
3. A proposal row shows the text, the time, and the chat where it came from. It has three
   buttons: "Save", "Edit and save", and "Dismiss". Save and Edit and save make a memory item.
   Dismiss removes the proposal and makes no item.
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

## Rules

- Memory is stored locally with the agent.
- Deleting an agent deletes its memory, its proposals and its history. Archiving keeps them.
- The user can turn memory off per agent. Existing items stay but are not used. An agent with
  memory off has no tool to save, to suggest or to search past chats (see 007). The tabs stay
  open and the user can still change items.
- The memory tool accepts a text of at most 500 characters, for an item and for a proposal. It
  refuses a longer text and tells the agent. The user can type longer items by hand.
- A proposal with the same text as an item or as another proposal is not added. Spaces at both
  ends and the case of letters do not matter. The tool tells the agent that the fact is known.
- An agent has at most 20 proposals. A new proposal replaces the oldest one when 20 wait. A
  proposal that nobody answers ends after 30 days.
- A change of the choice leaves the proposals as they are. After the change to "Save at once",
  the proposals stay in the tab until the user answers them.
- The memory tool refuses a text that looks like a secret (see 014). It does not save it and does
  not suggest it, and it tells the agent to leave the secret out. The user can type such a text
  by hand.
- A save in a turn that holds outside content asks first (see 007, "Outside content"). So a
  web page cannot put a lasting order into the memory of an agent. This holds for "Save at
  once". A proposal is not memory, so a proposal in such a turn needs no card. The user still
  decides in the tab Proposals.
- Each change to an item makes a history row. A change that arrives by sync (019) makes none.
  Such a change can turn an Undo off, because the item is not as that row left it.
- History keeps 90 days and at most 1000 rows for each agent. The oldest rows go first. Removing
  a row does not change an item.
- A history row whose text looks like a secret shows "[redacted]" in place of the text and has no
  Undo.
- The link in the line "Suggested for memory" and the undo control in the line "Saved to memory"
  work on the computer where the change was made. On a linked device (012) and on the other
  computer of a sync pair (019), the lines are plain text with no link and no undo control.

## Out of scope

- Memory shared between agents.
- Notes that the app writes by itself, with no tool call of the agent.

## Acceptance

- Tell an agent a preference, open a new chat: it uses the preference. Delete the item: it does
  not.
- Set "Ask me first". Tell the agent a preference. The tab Items has no new item, and the tab
  Proposals has one. Press "Save": the item shows in Items, and History has a row "added" by a
  proposal that the user accepted. A new chat uses the preference.
- Dismiss a proposal: it leaves the tab, and no item and no history row is made.
- Edit an item twice. Undo of the first edit is off and shows the reason. Undo the second edit,
  then the first: the item has the text that it had before the first edit. Undo the last undo:
  the item has the text of the first edit again.
- Delete an item, then press Undo on its row: the item is back with its text.
- Ask the agent to remember a text that looks like a key: no item and no proposal is made, and
  the agent says that it left the secret out.
- Make 21 proposals: the tab shows 20, and the oldest one is gone.
- Ask the agent to save a fact twice: the second call adds nothing, and the agent is told that the
  fact is known.
- Turn memory off: the agent has no memory tools. The items stay in the tab.
- Open the same agent on a linked device: the line "Saved to memory" has no undo control.
