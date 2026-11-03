# 024 Board

## Purpose

The user sees all the work of all agents on one board. The board has two kinds of card. The user
plans work on cards, hands a card to an agent, and the card follows the work of the agent. Every
other task of every agent (a chat, a channel, a routine, a workflow, a message of another agent)
shows on the board by itself, as a work card. Agents can read the planned cards, add ideas, take a
card and write comments. So the user and the agents plan and watch in one place.

## Concepts

- **Board**: a page of the window. The page button "Board" opens it (see 001). Each profile (022)
  has one board. It is the only board: it holds the planned cards and the work of every agent of
  the profile, with no board for each agent.
- **Column**: the board has four columns, in this order. The user cannot add, rename, delete or
  move a column.
  - **Backlog**: ideas. Agents leave it alone.
  - **To do**: work that is ready. An agent may take a card from here.
  - **Doing**: work that someone does now.
  - **Done**: work that ended.
- **Card**: one piece of planned work that the user or an agent wrote. In this spec, "card" alone
  means this kind. A work card is another kind (see below). A card has:
  - a number, such as "#12". It is unique on the board and is never used again;
  - a title (1 to 120 characters);
  - a description (plain text, up to 10,000 characters, may be empty);
  - a column and a place in the column;
  - an agent (optional, one agent that is not archived);
  - the switch **Mine** (see below);
  - the writer: the user, or the agent that added it;
  - comments and tasks (see below);
  - the time it was made and the time it last changed.
- **Mine**: a card that the user does alone. Agents do not see it and cannot start it. A Mine
  card has no agent and shows a person icon.
- **Comment**: plain text (1 to 4,000 characters) with the writer (the user, or an agent with its
  face and name) and the time. A comment has no edit. The user can delete a comment after a
  confirm.
- **Card task**: a task (005) that the user started from the card, or that an agent took with the
  card. A card can have many tasks over time. The card follows the newest one.
- **Work card**: a card that the app makes by itself for a task (005) that has no card. It shows
  the agent, what the agent does, where the work came from, and the state. The user cannot edit
  it, move it, comment on it or delete it. It leaves the board by the rules in "Work cards".

## The page

- A header line: the title "Board", a search field, a filter "Agent" (all, none, or one agent), a
  switch "Work of agents" (on at the start), a switch "Only mine", and the button "New card".
- Below, the four columns side by side. A column has its name, the number of its cards (work
  cards too), its cards, and a plus button at its foot. When the window is too narrow, the
  columns scroll sideways.
- Order in a column: "Backlog" and "To do" keep the order that the user sets. "Doing" and "Done"
  list the newest entry first, planned cards and work cards together. The user cannot reorder
  these two columns.
- A card in a column shows its title (two lines at most), the number, the face of its agent, the
  person icon when it is Mine, a mark when its task needs attention (see "Marks"), and the number
  of comments.
- A work card shows the face and name of the agent, the label of the task (one line, cut at 90
  characters with "…"), where the work came from, the mark, and, while the task is live, the time
  since it started (see "Work cards"). A click opens the task (005).
- The switch "Work of agents" off hides all work cards. "Only mine" shows only cards with Mine
  on, so it hides work cards too. The choice of "Work of agents" stays after a restart.
- A click on a card opens the card view in a panel at the right of the page. The view shows all
  fields, the comments, the list of card tasks (agent, state and time; a click opens the task),
  and the buttons "Start" and "Stop".
- Search looks in titles, descriptions and comments of cards, and in the labels and agent names
  of work cards. The filters and the search only hide cards. They never change a card. The
  filter "Agent" with "none" shows only cards that have no agent, so it hides work cards.
- A column shows 50 cards. If more exist, its last row is "Show more", which shows 50 more.
- Empty board: the four columns are empty, and "To do" shows the muted line "Add a card to plan
  work."

## Flows

1. **Make a card**: "New card" opens a short form with a title. Enter makes the card at the foot
   of "To do". The plus at the foot of a column makes the card at the foot of that column. A
   description, an agent and Mine are set in the card view.
2. **Edit**: the user changes the title, the description, the agent and Mine in the card view. A
   change saves at once. A title cannot be empty. When the user turns on Mine, the agent is
   cleared. Mine cannot be turned on while the card has a live task. The switch is off and says
   "Stop the task first."
3. **Move**: the user drags a card to another place in "Backlog" or "To do", or to another
   column. A card dropped in "Doing" or "Done" goes to the top. The card menu has "Move to" with
   the four column names, for the keyboard. A card with a live task (queued, running or waiting)
   cannot move: the card shows "Stop the task first." A move to another column makes no task. A
   work card cannot move.
4. **Start**: "Start" is on the card view and in the card menu. It shows when the card has no live
   task and is not Mine.
   - A card with no agent opens a list of agents. The pick sets the agent of the card.
   - An archived agent cannot start. The button is off and says why. The user picks another agent.
   - The app makes a task (005) for the agent. The source is "Board", the label is the title of
     the card, and the depth is 0. The prompt is the title, an empty line, and the description.
     The prompt also tells the agent that the work comes from card "#12" and that the tool "read
     a card" gives the comments.
   - The card moves to the top of "Doing" at once, also when the task waits in the queue.
5. **Follow**: while a card has a task, the card follows the newest one (see "How a card follows
   its task").
6. **Stop and retry**: "Stop" on a card with a live task stops the task as in 005. "Retry" shows
   when the newest task failed, was blocked or was stopped. It makes a new task, as retry does in
   005, and the card follows it.
7. **Comment**: the user writes a comment in the card view. It shows at once. Agents see it when
   they read the card.
8. **Delete**: "Delete card" in the card menu asks first and says that the card, its comments and
   its links to tasks go. The tasks stay in the Tasks page and show "Card removed." A card with a
   live task cannot be deleted.
9. **Watch the work**: any task of any agent shows by itself as a work card (see "Work cards"). The
   user opens a work card to see the task. "Stop", "Retry" and "Dismiss" are on the card.

## How a card follows its task

| State of the newest task | Column | Mark on the card |
| --- | --- | --- |
| Queued | Doing | Waits |
| Running | Doing | Working |
| Waiting for the user, or in review (005) | Doing | Needs you |
| Done | Done, at the top | none |
| Failed | Doing | Failed, with the reason |
| Blocked | Doing | Blocked, with the reason |
| Cancelled | Doing | Stopped |

- The mark leaves when the card has no task, or when the card is in "Done".
- The card shows no copy of the reply. The task shows the reply (005).
- A user can drag a card out of "Done" or any other column after the task ended. This starts no
  task and does not change the task.
- A work card follows its task by the same table, with the differences in "Work cards".

## Work cards

- Each task (005) of each agent of this profile that has no card gets a work card from the moment
  the task is made. This holds for every source: a direct chat, a channel and its parts, a
  routine, a workflow, a message of another agent, a memory check (008), and an outside program
  (023). A task that has a card shows on that card only, and has no second card.
- The board also shows the tasks of the computer that this one syncs with (019). Such a card
  shows the name of that computer, as the Tasks page does.
- A work card shows the source and its place: "Chat", "Channel <name>", "Routine <name>",
  "Workflow <name>", "Agent <name>" for a message of another agent, "Memory check", or "Outside
  program <name>". A task that is a part or a child of another task also shows "Part of <label of
  the parent>".
- The column and the mark follow the table above, with these differences:
  - A work card has no number.
  - Done: the card goes to "Done" and leaves the board at midnight (the day of this computer, as
    in 021). A task of a direct chat (003) is the exception: when it ends as Done its card leaves
    at once, because the chat holds the reply. A live task of a direct chat shows in "Doing".
  - Failed, Blocked and Cancelled: the card stays in "Doing" with its mark until the user retries
    the task, the user presses "Dismiss", or midnight passes. When the user retries, the old card
    leaves and the new task gets its own card.
- Actions on a work card are the actions of the Tasks page (005): "Stop" for a live task, "Run
  next" for a queued task (see 005, "Queue"), and "Retry" for a failed, blocked or cancelled
  task. A queued card shows the line of 005 that tells what the task waits behind. "Dismiss"
  shows on a failed, blocked or cancelled card. It hides the card on this computer only. It does
  not change the task, and the task stays on the Tasks page and on the Today page (021).
- A card that waits for the user ("Needs you") opens the task at the question or the approval,
  as a row of the Today page does. The board answers nothing by itself.
- The tools for agents do not list work cards. The tool "list agents" (007) gives the state of
  each agent.

## Tools for agents

An agent that uses the tools of the app, and an agent on a vendor runtime (006), get the same five
tools. Each call runs through the same tool code (007). The tools change data of the app only.
They need no approval and they work at every permission level, also "Read only" (007).

Agents do not see cards in "Backlog" and cards that are Mine. No tool lists, reads, takes or
comments on such a card.

- **Read the board**: the cards of "To do" and "Doing", and the 10 newest cards of "Done". For each
  card: the number, the title, the column, the agent, the mark, and the number of comments. At
  most 50 cards.
- **Read a card**: gives the title, the description, the column, the agent, the writer, and the
  newest 20 comments with their writers.
- **Add a card**: gives a title and, if the agent wants, a description. The card goes to the foot
  of "Backlog". Its writer is the agent. The user decides what happens next. One task can add at
  most 5 cards. The tool gives the number of the new card back.
- **Take a card**: gives a number, or no number for the first card of "To do" that the agent may
  take. The card moves to the top of "Doing", gets this agent as its agent, and follows the task
  of the turn. The tool fails with a short reason when:
  - the card is not in "To do";
  - the card has another agent ("This card is for <name>.");
  - the task already has a card, because it was started from one or took one before. A task has
    one card at most.
- **Comment on a card**: gives a number and a text. It works for a card in "To do", "Doing" or
  "Done". The comment shows the face and name of the agent.

Text that an agent wrote is not trusted (007, "Outside content"):

- The title, the description and the comments of a card that an agent added, and every comment of
  an agent, count as a message from another agent for the agent that reads them. The turn holds
  outside content from that read.
- The card that an agent added keeps this mark for good, also after the user edits it. A task
  that the user starts from such a card holds outside content from its start. To get a card
  without the mark, the user makes a new card by hand.
- The text that the user wrote on a card, and the comments of the user, are words of the user
  (007). A task that the user starts from such a card has the title and the description as words
  of the user.

## States

- **Cannot read the board**: the page shows the muted line "Could not read the board." in place of
  the columns.
- **Limit of cards**: a board holds 1,000 cards, "Done" included. Work cards do not count,
  because the app makes and removes them by itself. At the limit, "New card" and the
  tool "add a card" fail with the reason "The board is full. Delete some cards." Sync can bring
  the board above the limit (019); then only adding stops.
- **Limit of comments**: a card holds 200 comments. At the limit the user and the tools get the
  reason "This card has too many comments."
- **Archived agent**: the card keeps the agent and shows "Archived" next to the name. Restore of
  the agent (002) ends it.
- **After a restart**: the board, the marks and the links to tasks are the same. A task that a
  restart stopped is handled as 005 says, and the card follows it.

## Rules

- The board is local data of the computer. A change shows on the page within 1 second, also a
  change that an agent makes and also a task that starts or ends. The user does not reload the
  page.
- A work card is not data of its own. It shows the task. Only "Dismiss" is stored, and it stays
  on this computer.
- Numbers start at 1 and go up. On a sync (019) two cards can get one number. Then the card that
  was made first keeps the number, and the other gets the next free number on both computers.
- Search and filters never start a turn of an agent and send nothing off the computer.
- Text on the page comes from the translation catalogue, in English and Korean (013).
- The page makes no notification. A task from a card notifies as any task does (015).

## Surfaces

- **Ways in**: the page button "Board" (001), the button "New card", the plus at the foot of a
  column, and the five tools of agents. Work cards come by themselves, and the user makes none.
  The search field of the place list (Cmd+K) does not look at cards in this version. A message
  has no "Make a card" in this version. The message box has no command for cards.
- **Devices**: the computer shows and does everything on this page. A linked computer or phone
  that is a client (012) shows the page button and, on the page, the muted line "Open this on
  <server name>." The phone has no board in this version. A task from a card shows on the phone
  as any task, with the source "Board". A computer that syncs (019) holds the cards and shows
  them on its own page. It also shows the work cards of both computers, and a "Dismiss" on one
  computer does not reach the other.
- **Profiles**: each profile has its own board (022). The tools and the tasks of a profile use
  the board of that profile. A card never moves to another profile.
- **Runtimes**: both kinds of agent get the same five tools (see "Tools for agents"). The permission
  level changes nothing for them.
- **Ways out**: a card leaves "Doing" by its task or by the user. Delete asks first. Mine on has
  Mine off. A comment can be deleted. Stop has Retry. "Work of agents" off has on. A dismissed
  work card comes back only as a new card of a new task.
- **Seeing the state**: the mark on the card and the column show the state also after a restart.
  The Tasks page filter "Source" has the choice "Board". The task view shows a link "Card #12" that
  opens the card, or "Card removed."
- **Data**: the cards, the comments, the numbers, the writers and the links to tasks sync (019)
  and go into an export (014). Work cards are not stored, because the tasks hold the same facts.
  The choice "Work of agents" and the dismissed work cards stay on this computer: they do not
  sync and they are not in an export. An agent file and a workflow file hold no cards. A
  workflow has no step for cards in this version.
- **Words**: Board, Card, Backlog, To do, Doing, Done, Mine and the marks (see the glossary).

## Out of scope

- More than one board, a board for each agent, or boards for projects. Columns that the user
  makes. A grouping of the cards by agent.
- Labels, due dates, checklists, files and images on a card.
- A card that starts a task by itself, by a drag or by a time.
- A planned card that an outside program (023), a message or a workflow makes. (The tasks of an
  outside program do show as work cards.)
- Answers to approvals and questions on the board. The user answers them on their cards (007).
- A history of work cards. The Tasks page (005) keeps the history.
- A badge on the page button, a Cmd+K search of cards, and a board on the phone.

## Acceptance

- A new profile: the board shows four empty columns and the line "Add a card to plan work."
- The user sends a message to an agent in a direct chat: within 1 second a work card of that agent
  shows at the top of "Doing" with the mark "Working". When the reply ends, the card leaves.
- Two agents work at once, one in a channel job and one on a routine run: "Doing" shows two work
  cards, each with the face of its agent and its source ("Channel <name>", "Routine <name>").
  The filter "Agent" with the first agent shows only the first card.
- A part of a channel job ends as Done: its work card moves to "Done" and stays there until
  midnight. At midnight it leaves.
- A task fails: its work card stays in "Doing" with the mark "Failed" and the reason. "Dismiss"
  hides it, and the task still shows on the Tasks page. "Retry" on another failed task makes a new
  task, and the old card leaves while the new card shows "Working".
- A task waits for an approval: its work card shows "Needs you". A click opens the task at the
  approval card.
- A task from a card shows on that card only. The board shows no work card for it.
- Try to drag a work card: it does not move. Open its menu: it has no "Delete" and no comment
  field.
- Turn off "Work of agents": all work cards hide, and the planned cards stay. Restart the app: the
  switch is still off.
- Two computers sync and an agent works on the other one: the board shows the work card with the
  name of that computer. "Dismiss" of a failed card on one computer does not hide it on the other.
- Press "New card", type "Fix the footer", press Enter: the card is at the foot of "To do" with
  number "#1".
- Open the card, pick an agent, press "Start": a task with the source "Board" and the label "Fix
  the footer" exists, and the card is at the top of "Doing" with the mark "Working". When the
  agent ends the turn, the card is at the top of "Done" with no mark.
- The agent is busy: "Start" makes a queued task, and the card shows "Waits" in "Doing".
- A task from a card fails: the card stays in "Doing" with the mark "Failed" and the reason.
  "Retry" makes a new task, and the card shows "Working".
- Drag a card with a running task: it does not move, and the line "Stop the task first." shows.
  Press "Stop": the card shows "Stopped" and can move.
- Turn on Mine on a card: its agent clears, and "Start" is gone. The tool "read the board" does
  not list the card.
- A card is in "Backlog": "take a card" with its number fails. The tool "read the board" does not
  list it.
- In a direct chat the user says "take the next card". The agent calls "take a card" with no
  number. The first card of "To do" that has no agent, or has this agent, moves to "Doing" with
  this agent. When the turn ends done, the card moves to "Done".
- "Take a card" for a card with another agent fails with "This card is for <name>."
- The agent adds a card: it shows at the foot of "Backlog" with the line "Added by <agent>". The
  user starts a task from that card: the turn holds outside content from its start.
- An agent adds a 6th card in one task: the tool fails.
- The agent comments on a card: the comment shows with the face and name of the agent within 1
  second.
- Archive the agent of a card: the card shows "Archived" and "Start" is off. Restore the agent:
  "Start" works.
- Delete a card with no live task: after the confirm, the card is gone, its task stays on the
  Tasks page with "Card removed."
- A board has 1,000 cards: "New card" fails with "The board is full. Delete some cards."
- Two computers that sync add a card each, both as "#7" while apart: after the sync both computers
  show the same two cards with different numbers.
- Open a linked server on the rail and press "Board": the page shows the line "Open this on
  <server name>."
- Change the language to Korean: the page has no English text except names.
