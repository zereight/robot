# 016 Sync between two computers

## Purpose

The user has the same agents, chats, channels, memory, routines and workflows on two computers,
for example MacBook 1 and MacBook 2. A change on one computer reaches the other. The user can
switch computers and carry on. Data goes straight between the two computers (012). No other
service holds it.

## Concepts

- **Sync pair**: two linked computers (012) that the user set to sync. A computer is in at most
  one pair. A phone is never in a pair; it opens a computer as a client (011).
- **Copy**: after a sync, each computer holds all the data in the "Syncs" list. Each copy is
  complete and works alone, also when the other computer is off.
- **Origin**: the computer where a message was made or a task ran.
- **Runs on**: the one computer where a routine or a workflow runs.
- **Change list**: the newest 100 changes that came from the other computer, with the time, the
  kind and the name of the item. It shows in Settings → Devices.

### Syncs

| Item | Notes |
| --- | --- |
| Agents | Face, name, role line, instructions, model choice, archive state. |
| Model accounts | Name, vendor and address only. Each computer connects the account itself. |
| Channels | Name, topic, members, lead, archive state. |
| Messages | Direct chats and channels, with tool cards, plan steps and reply chips. |
| Tasks | State and result. They show on the tasks page with the name of the origin. |
| Memory | The items of each agent. |
| Routines and workflows | The definition, the run history, and the "Runs on" computer. |
| Read state | The last place that the user read in each chat. |

### Does not sync

| Item | Why |
| --- | --- |
| Keys, tokens and the sign-in of vendor programs | Secrets stay on their computer (014). |
| Permission levels and "Always allow" rules | A change on one computer must not give another computer more power over its files. |
| Workspace folders and the files in them | They are large and belong to a computer. Use git or a file service. |
| Browser windows and their sessions | They belong to a computer. |
| Settings, theme, language, notification choices, mutes | Settings are local (013). |
| Usage numbers | They count what ran on this computer. |
| Linked devices and their keys | They are not data of the agents. |

## Flows

### Turn sync on

1. Settings → Devices → pick a linked computer → "Sync with this computer". The computer must
   be online. The link must go both ways. If it goes one way, the dialog says that the other
   computer will also be able to open this one.
2. The dialog shows what each computer holds: agents, channels, messages. The user picks how to
   start:
   - "Merge" (default): both computers keep their data and get the data of the other.
   - "Use the data of <name> here": this computer takes the data of the other one. Data of the
     "Syncs" list that only this computer has is removed. The dialog shows how many items.
   - "Send my data to <name>": the other computer takes the data of this one. Data that only
     the other computer has is removed.
3. The other computer shows "Sync with <name>?" with the choice, the "Syncs" and "Does not sync"
   lists in short, and how many items it will drop. The text says that <name> can change its
   agents, chats, memory, routines and workflows, and that the user can stop at any time. The
   buttons are Allow and Deny.
4. On Allow, each computer first saves a backup of its data (a ROBot export, 014) in a
   "backups" folder in its data folder. The app keeps the newest 3 sync backups. Then the copy
   starts. The user can keep working. The row shows "Copying 340 of 1,200".
5. When the copy ends, the row shows "Up to date". The agents that came from the other computer
   use the permission level "Ask for everything" and a new, empty workspace folder on this
   computer. Their model accounts show "Not connected" until the user connects them here.

### Every day

- A change reaches the other computer within 5 seconds when both are online. A reply that
  streams grows on both computers as it comes.
- When one computer is off or away, changes wait and go when both are online again. The user
  does nothing.
- A task runs on the computer where the user started it. On the other computer it shows the
  same state and text, and cannot run there. The user can stop it or answer its approval cards
  and questions from the other computer. The answer goes to the origin, as a client answer
  does (012). If the origin is offline, the card shows "<name> is offline."
- A message that came from the other computer never starts a task here.
- Retry on a task from the other computer makes a new task that runs here.
- A message or a card that was made on the other computer shows "from <device name>" (012).

### Routines and workflows

1. A routine or workflow that comes from the other computer shows "Runs on <name>". It does not
   run here, also not at a schedule time.
2. "Run on this computer" moves it. The other computer shows "Runs on <name>" at once. The
   "Missed" rule of 009 counts only on the computer where it runs.
3. A workflow with a channel trigger fires on its "Runs on" computer for a message from either
   computer. A message that is older than 5 minutes when it arrives does not fire it.

### Files of messages

- A file on a message shows its name and size on both computers. If the file is not on this
  computer, it shows "Not on this computer". When the user opens it, the app copies it from the
  origin and keeps it. If the origin is offline, the open fails with a plain line.

### Stop sync

- Settings → Devices → the computer → "Stop syncing". Both computers keep all their data. The
  other computer shows "<name> stopped syncing." Removing the link (012) also stops the sync.
- A new sync after a stop starts as "Merge". Items with the same origin match, so no copies
  appear. An item that the user deleted on one computer while sync was off comes back from the
  other.

## States

The row of a computer in Settings → Devices shows one state:

| State | What the user sees |
| --- | --- |
| Off | "Sync with this computer". |
| Waiting for Allow | "Waiting for <name> to allow." with Cancel. |
| Copying | "Copying 340 of 1,200" with Pause. A stop in the middle goes on from where it stopped. |
| Up to date | "Up to date" and the time of the last sync. |
| Waiting | "Waiting for <name>." The other computer is off, away, or has "Let other devices connect" off. |
| Paused | "Paused" with Resume. Changes wait on both computers. |
| Needs attention | A plain line: "Update the app" (012), "The clock of <name> is 12 minutes off." (more than 5 minutes), or "Waiting for you to decide on deletions." |

The Denied case shows "<name> did not allow the sync." and returns the row to Off.

## Rules

- Both computers must hold the same data version. A computer with another version gets "Update
  the app", and sync waits.
- **One result**: when both computers have all changes, both hold the same data.
- **Newest change wins**, per field of an item. A change made after the user saw another change
  always wins over it. For two changes that were made while the computers were apart, the one
  with the later time wins. Both computers pick the same one. The time is the time of the
  clock of the computer that made the change, so a wrong clock can make an older change win.
  The app warns when the clocks differ (States).
- **No lost text**: if two computers edit the same memory item while apart, the newest text
  stays. The other text is saved as a new memory item of the same agent.
- Messages are made on one computer only, so they do not clash. Messages show in the order of
  their send time. Messages from one computer keep their order.
- **Names**: a name stays unique on its server (002), and the rule ignores case. When two
  different agents with one name meet in a merge, the one that comes in gets the name of its
  origin computer in brackets, for example "Writer (MacBook 2)". The same holds for channels.
  Model accounts with the same name, vendor and address are one account.
- **Delete**: deleting an agent or a channel deletes it on the other computer too. The delete
  dialog says so. Sync never deletes files: the workspace folder of an agent that sync removes
  stays on disk, and the change list shows its path. If one sync would delete 5 or more agents
  and channels on a computer, that computer asks first: "<name> wants to delete 8 agents and
  channels here." with Delete and Keep. Keep leaves them here, and they come back to the other
  computer.
- **One task per agent**: while both computers are online, an agent runs one task at a time
  across both (005). A task that waits shows "Waits for the task on <name>."
- Unread counts follow the read state: reading a place on one computer clears its count on the
  other. Data that arrives by sync makes no system notification. An approval or a question of a
  task on the other computer does (015).
- A copy of data that arrives never changes the permission level, the "Always allow" rules, the
  workspace folder or the secrets of this computer.
- Only a linked computer that the user set to sync can send changes. Turning "Let other devices
  connect" off, or removing the link, stops the flow at once.
- The tasks page lists tasks of both computers, with the name of the origin and a filter.
- Sync data is not part of an export (014).
- A big history, for example 50,000 messages, copies in batches. The app stays usable while it
  copies.

## Out of scope

- More than two computers in one sync pair.
- Sync of workspace folders and files.
- Sync of settings, secrets, permission levels, browser sessions and usage numbers.
- Choosing single agents, channels or kinds of data to sync.
- Sync through a service on the internet. The two computers must reach each other as in 012.
- A phone in a sync pair. The phone opens a computer as a client.
- Undo of one change. The backup and the change list are the way back.

## Acceptance

- MacBook 2 is new. On MacBook 2: sync with MacBook 1, choose "Use the data of MacBook 1 here".
  After the copy, MacBook 2 shows the same agents, channels, messages and memory. Its model
  accounts show "Not connected". Its agents use "Ask for everything". A backup folder exists on
  both computers.
- Both computers have an agent named "Writer". Merge. Both computers show "Writer" and "Writer
  (MacBook 2)" with the right history, and the two lists are equal.
- Rename an agent on MacBook 1. MacBook 2 shows the new name within 5 seconds, and the change
  list shows it.
- Send a message to an agent from MacBook 2. The task runs on MacBook 2, the reply streams on
  both computers, and MacBook 1 starts no task. The message on MacBook 1 shows "from MacBook 2".
- Quit the app on MacBook 2. On MacBook 1 add a memory item and send a message. Start the app on
  MacBook 2: both arrive with no new pairing.
- Edit one memory item on both computers while MacBook 2 is off. After the next sync both show
  the same newest text, and the older text exists as a second item.
- A task on MacBook 1 waits for an approval. Answer it on MacBook 2. The task goes on.
- A routine from MacBook 1 does not run on MacBook 2 at its time. "Run on this computer" on
  MacBook 2 moves it, and MacBook 1 shows "Runs on MacBook 2".
- Delete an archived agent on MacBook 1. It is gone on MacBook 2, and its workspace folder is
  still on the disk. Delete 8 agents at once: MacBook 2 asks before it deletes them.
- Stop syncing. A change on MacBook 1 does not reach MacBook 2. Remove the link in the same
  way: sync ends.
- After a sync, MacBook 2 holds no key and no token of MacBook 1.
- Stop the app in the middle of a big copy. Start it again: the copy goes on and does not start
  over.
- Open a file of a message from MacBook 1 on MacBook 2: the file is copied and opens.
