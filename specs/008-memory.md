# 008 Memory

## Purpose

An agent remembers useful facts across chats, and the user can see and change what it keeps.

## Concepts

- **Memory item**: a short text, the agent it belongs to, when it was made, and where it came from
  (a message, or the user).
- **Scope**: one agent. Agents do not read each other's memory.

## Flows

1. The agent saves a memory when it learns a lasting fact (a preference, a name, a decision). The
   chat shows a muted "Saved to memory" line with an undo control.
2. The user opens the agent's memory page: a list, newest first, with search. The user can add,
   edit, or delete items.
3. Before each turn, the agent gets the memory items that relate to the new message, up to a
   limit set by the size of the model's context.

## Rules

- Memory is stored locally with the agent.
- Deleting an agent deletes its memory. Archiving keeps it.
- The user can turn memory off per agent; existing items stay but are not used.
- A save in a turn that holds outside content asks first (see 007, "Outside content"). So a web
  page cannot put a lasting order into the memory of an agent.

## Acceptance

- Tell an agent a preference, open a new chat: it uses the preference. Delete the item: it does
  not.
