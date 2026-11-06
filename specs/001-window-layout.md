# 001 Window layout

## Purpose

One window shows everything the user needs to build and run workflows, in the layout of a chat
server, so a new user knows where to look. The app opens on the workflow list.

## Concepts

- **Server rail**: a narrow column at the far left edge of the window. One round tile per server,
  then an add button. The selected server has a short bar at its left side. The first tile is
  the open profile on this computer (see 022). Tiles of linked computers (012) follow in the
  order of pairing. A linked tile shows the first letter of the computer's name and the
  connection state (012).
- **Page buttons**: under the servers, icon buttons open the workflow list (010), tasks (005, 038),
  test devices (032) and usage. Each button shows only its own content. The Tasks page holds the
  tabs "Tasks" and "Events" (005, 038); the Tasks button opens the first tab. At the bottom: help
  and settings, then the profile button when the computer has two or more profiles (see 022).
- **Workflow list**: the list of workflows, with one card for each workflow. The workflows button
  shows it. A card shows the name, the state of the last run and the state of the check (see 010).
  With no workflow, the list shows one button, "New workflow", and one line that says what a
  workflow is. Where the list shows is not decided (see the questions for 001).
- **Workflow view**: the view of an open workflow. It shows the canvas of the workflow, and beside
  it the chat of that workflow (see 010). A new workflow opens here at once (010, "New workflow").
- **Activity panel**: a panel that the user can open beside the workflow view. It uses the panel
  column. Its content is not decided (see docs/spec-questions.md, rows for 001).
- **Panel column**: an optional column at the right of the window, used by one panel at a time: the
  activity panel, or the panel of the test devices connection (032). Each panel keeps its own width
  and its own open state. The user drags the left edge of the column to change its width, between 320
  and 720 px. The header buttons switch between the two panels.
- **Frame**: the part of the window that shows a panel of a program of another vendor (018, 032). It
  has a thin border, it fills the column, and it has no address of its own: the app gives it the
  addresses it may reach.

## Flows

1. The user clicks a server tile. The workflow list and the pages change to that server. On a
   linked computer, the pages work as 012 says.
2. The user opens a card in the workflow list. The workflow view shows that workflow, with its
   canvas and its chat.
3. The user clicks "New workflow" on the workflow list (010, "New workflow").
4. The user hides or shows the panel column with a header button. The app remembers this, and which
   panel it holds.
5. The user clicks the add button on the rail. A dialog opens: "Connect to a computer" (012).
   The user can also remove a linked tile with its context menu.

## States

- No server connected: the rail shows only the add button; the main area explains how to start.
- A linked server that is offline: its tile is muted. The workflow list and the run view do not
  show. A chat that the user opened shows its cached messages, marked "Offline" (012).
- No workflow: the workflow list shows "New workflow" and one line that says what a workflow is.

## Rules

- Window width under 800 px: the rail narrows to 56 px, and the panel column closes. The rail width
  and the panel column at 800 px and wider are not decided (see the questions for 001).
- The panel column shows one panel. A press on a header button of the other panel switches to it.
  The app remembers which one is open.
- The rail leaves room for the window buttons at the top left.
- The rail, the workflow list and the open workflow belong to the open profile. A switch of
  profile changes all of them, and each profile keeps its own selection (022).
- Keyboard: Cmd+F finds in the open chat (003); on a page that is not a chat it does nothing.
  Cmd+Shift+D starts and stops dictation (027). The help button opens a page that lists these keys.
  The keys for search and for moving through the list are not decided (see docs/spec-questions.md,
  rows for 001).
- **Quit**: Cmd+Q, and "Quit" in the menu of the menu bar item (015), quit the app. When no run
  works and no task waits for the user, the app quits at once. When a run works or a task waits,
  the first press shows a short note over the window: "Press Cmd+Q again to quit. N tasks are
  running." A second press within 3 seconds quits. Holding the keys down for 1 second quits too.
  A quit stops the running tasks as a restart of the app does (005).
- **Closing the window**: it does not quit the app. The runs go on working. The user opens the
  window again from the Dock icon or from the menu bar item (015).

## Acceptance

- Selecting a server, then a workflow, opens the right workflow; the selection survives a restart.
  This also holds for a linked computer.
- The add button opens the connect dialog.
- The Workflows button opens the workflow list. With no workflow, the list shows "New workflow" and
  one line that says what a workflow is.
- The window has no page for agents, chats or routines.
- At 760 px width, the panel column is closed and the rail is 56 px wide.
- Press Cmd+Q while a run works: the note shows and the app stays. Press it again within 3 seconds:
  the app quits. With nothing running, the first press quits.
- Press Cmd+F on the Settings page: nothing happens. Hold Cmd+Q for 1 second while a run works: the
  app quits. Close the window while a run works: the run goes on, and the Dock icon opens the
  window again.
