# 001 Studio

## Purpose

One window shows everything the user needs to build, test, run, inspect and improve workflows.
The workflow list, the canvas, the runs and the chat show at once, so the user sees progress,
stops and results without opening another page. The app opens on the studio.

## Concepts

- **Server rail**: a narrow column at the far left edge of the window. One round tile per server,
  then an add button. The selected server has a short bar at its left side. The first tile is
  the open profile on this computer (see 022). Tiles of linked computers (012) follow in the
  order of pairing. A linked tile shows the first letter of the computer's name and the
  connection state (012).
- **Page buttons**: under the servers, icon buttons open the tasks page (005, 038), the test
  devices page (032) and the usage page (006). Each button shows only its own content. The Tasks
  page holds the tabs "Tasks" and "Events" (005, 038); the Tasks button opens the first tab. At
  the bottom: help and settings, then the profile button when the computer has two or more
  profiles (see 022).
- **Workflow list**: a column beside the rail. It holds one card for each workflow of the open
  server. A card shows the name, the state of the last run and the state of the check (see 010).
  The list shows workflows in alphabetical order, ignoring case. It has no sections and no pins.
  Its header holds the button "New workflow". With no workflow, the list shows that button and
  one line that says what a workflow is.
- **Workflow view**: the centre column. It shows the open workflow: a header, one part of the
  workflow, and the run strip below. The header shows the name, the state of the check, the
  buttons Run and Stop, the button "Device" (032), and the delete of the workflow (000, 010).
  The view shows one part at a time: the canvas, the responsible document, the memory, the
  proposals, or the settings of the workflow. A row of tabs switches between them.
- **Canvas**: the graph of the workflow (010): its nodes, its connections, its trigger, and the
  path of a failed check. The canvas is the main surface of the studio: it fills the workflow
  view from edge to edge, between the tab row and the run strip, with no frame around it. The
  buttons to add a node and the button for the versions float over its top left corner. The
  user drags nodes onto the canvas, connects outputs to inputs, and edits the selected node in
  the node panel. The canvas has no edge: the user moves the view freely in all directions, past
  the graph, as in a design tool. A drag on an empty part of the canvas, a drag with one finger on
  a touch screen, or a scroll with two fingers on a trackpad or with the mouse wheel moves the
  view. A pinch on the trackpad, or the mouse wheel with Ctrl or Cmd, zooms the view around the
  pointer, from 25% to 200%. A small card over the bottom right corner shows the zoom, with
  buttons to zoom out and in; a press on the zoom value shows the graph at 100% from its top left
  corner again. The view starts there when the workflow opens. A click on an empty part clears
  the selection.
- **Node panel**: a card that floats over the top right corner of the canvas when a node is
  selected. The canvas keeps its full width below it. The card is 320 px wide, is never taller
  than the canvas, and scrolls by itself. Its header shows the number and the name of the node,
  a fold button and a close button. The fold button folds the card to its header, so the user
  sees the canvas below it, and unfolds it again. The app remembers the fold, and the next
  selected node opens folded or unfolded the same way. In a narrow window the card opens over
  the canvas, below the floating buttons. It closes when the selection clears, with its close
  button, or with Escape. With no selection, the canvas shows one muted line: "Pick a node to
  edit it."
- **Run strip**: the lower part of the workflow view, below the part that is open. It shows the
  runs of the open workflow, newest first, and the tasks of the selected run: each node with
  its state, its reason when it is not done, and its result when it has one (005, 010). The run
  strip also shows the result of the check (010): "Problem found" with the path, or the pass
  line. A close button returns to the runs. The user drags the top edge of the strip to change
  its height, or moves the edge with the arrow keys when it has the focus. The strip is at least
  120 px high, and the canvas keeps at least 160 px. A button folds the strip to its tab row, so
  the canvas gets the height, and unfolds it again. The app remembers the height and the fold. A
  run that starts, or a check that finds a problem, unfolds the strip.
- **Panel column**: the column at the right of the window. It shows the chat of the open
  workflow (003), or the panel of the test devices connection (032). It shows one panel at a
  time. The chat is the default. The user drags the left edge of the column to change its
  width, between 320 and 720 px. Each panel keeps its own width and its own open state. The
  header buttons switch between the two panels.
- **Page**: the tasks page, the test devices page, the usage page, or the help page. A page
  replaces the centre column: the tab area and the run strip. The workflow list and the panel
  column stay. Settings opens over the studio. Closing it returns to the studio.
- **Frame**: the part of the window that shows a panel of a program of another vendor (018, 032).
  It has a thin border, it fills the column, and it has no address of its own: the app gives it
  the addresses it may reach.

## Flows

1. The user clicks a server tile. The workflow list and the pages change to that server. On a
   linked computer, the pages work as 012 says.
2. The user clicks a card in the workflow list. The workflow view shows that workflow, the panel
   column shows its chat, and the run strip shows its runs. There is no back button and no
   Forward: the selection in the list is the navigation.
3. The user presses "New workflow" in the header of the list and types a name. The app makes the
   workflow with a short default responsible document (010). The new workflow is selected, and
   the canvas opens with the chat beside it.
4. The user presses Run in the header. The run starts, and the run strip shows its tasks as they
   go. The user presses Stop to end the run that works now.
5. The user switches the part of the workflow with the tab row. The run strip and the chat stay
   where they are.
6. The user presses a page button on the rail. The page shows in the centre column. The user
   returns to the open workflow by picking a card in the list, or by making a workflow. Pressing
   the Tasks button while the tasks page shows opens the tab "Tasks" (005).
7. The user opens the test devices panel (032). It replaces the chat in the panel column. The
   user returns to the chat with the header button.
8. The user hides or shows the panel column with a header button. The app remembers this, and
   which panel it holds.
9. The user clicks the add button on the rail. A dialog opens: "Connect to a computer" (012).
   The user can also remove a linked tile with its context menu.

## States

- No server connected: the rail shows only the add button; the main area explains how to start.
- A linked server that is offline: its tile is muted. The workflow list and the run strip do not
  show. A chat that the user opened shows its cached messages, marked "Offline" (012).
- No workflow: the workflow list shows "New workflow" and one line that says what a workflow is.
  The centre column shows an empty state with the same button. The run strip and the panel
  column show one muted line each.
- No workflow open: workflows exist, and none is selected. The centre column asks the user to
  pick a workflow. The run strip and the panel column show one muted line each.
- A page is open: the centre column shows the page. The list and the panel column stay.
- Narrow window, under 800 px: the rail narrows to 56 px. The workflow list and the panel column
  close. A button in the header of the workflow view opens each one as an overlay. The run strip
  stays below the part that is open. The app remembers the open state of each overlay.
- Medium window, from 800 to 1100 px wide: the rail keeps its width and the panel column stays.
  The workflow list closes and opens as an overlay, as in a narrow window.

## Rules

- The panel column shows one panel. A press on a header button of the other panel switches to it.
  The app remembers which one is open.
- The rail leaves room for the window buttons at the top left.
- The rail, the workflow list and the open workflow belong to the open profile. A switch of
  profile changes all of them, and each profile keeps its own selection (022).
- While a run works, the header shows Stop, and the workflow is read-only until the run ends
  (010).
- The list shows workflows in alphabetical order, ignoring case. It has no sections, no pins,
  no Back and no Forward.
- Only the tab row and the run strip take room from the canvas. The node panel, the buttons, the zoom card and
  the versions float over it. The canvas has no frame and no margin.
- The run strip shows runs newest first. It selects the run that works now, or the newest run.
  A selection by the user stays until the user selects another run or a new run starts.
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

## Surfaces

- **Ways in**: a card in the workflow list, "New workflow" in the header of the list, the page
  buttons on the rail, Run and Stop in the header of the workflow view, and the "Device" button
  (032). Cmd+K and the search of messages are not in this version (see docs/spec-questions.md,
  rows for 001).
- **Devices**: this computer shows the whole studio and changes it. A linked client shows the
  studio of the server as 012 says: it sees the list, the nodes, the runs and the chat, and it
  changes nothing without the switch "Can create and change workflows". The phone has no canvas
  editor (010, 011). Each profile keeps its own selection (022).
- **Runtimes**: nothing changes. The layout is the same whatever answers in the chat or in a
  node.
- **Ways out**: a card picked, or a workflow made, returns to the open workflow. The
  header button returns from the test devices panel to the chat. The close button returns from
  the check result to the runs. An overlay closes to the workflow view. The delete of a workflow
  asks first (000).
- **Seeing the state**: a card shows the state of the last run and the state of the check. The
  header shows the check and whether a run works. The run strip shows each run, each task with
  its state and reason, and each result that a task kept. After a restart, the selection and the
  states of the runs stay (010).
- **Data**: the selection, the widths, the open panels, the height and the fold of the run strip and the fold of the node panel stay on this computer. They do not sync
  (019), and no export holds them (014). The cache of a linked client holds what 012 says.
- **Words**: "Studio" and "Run strip" go in docs/glossary.md, in English and Korean.

## Out of scope

- What the chat shows and does (003). What a task holds and how the user stops or retries it
  (005). What the graph, a run, the check, a version, a proposal or the file holds (010). What
  the memory holds (008). What the test devices panel holds (032). What the usage page holds
  (006). What settings holds (013).
- Cmd+K and the search of messages. They are open questions (see docs/spec-questions.md, rows
  for 001).
- The look beyond 000: themes, lights and motion stay as 000 and 039 say.

## Acceptance

- Open the app with workflows, at 1280 px width: the rail, the workflow list, the canvas, the
  run strip and the chat show at once.
- Click a card: the centre column, the chat and the run strip show that workflow. Quit and open
  the app again: the same workflow is open.
- Press Run in the header: the run strip shows the tasks of the new run as they go. Fail a node:
  the run strip shows its reason without opening another page.
- Make a change that fails the check: the run strip shows "Problem found" with the path, and the
  canvas marks the nodes on the path. Press the close button: the runs show again.
- Click a node: the node panel floats over the top right corner of the canvas, and the canvas
  keeps its full width. Press the fold button: the panel shows only its header. Click another
  node: its panel opens folded. Quit and open the app again: the panel still opens folded.
- Drag an empty part of the canvas far to the left and up: the view moves past the graph, and
  the graph can go off the screen. Scroll with two fingers: the view moves. Pinch, or press
  Ctrl with the wheel: the zoom changes around the pointer, and the zoom card shows the new
  value. Press the zoom value: the graph shows at 100% from its top left corner again.
- Drag the top edge of the run strip up: the strip gets higher and the canvas gets lower. Quit
  and open the app again: the strip has the same height.
- Press the Tasks button: the centre column shows the tasks page, and the list and the chat stay.
  Pick a card: the open workflow shows again.
- Press "New workflow" in the header of the list and type "Weekly": the new workflow is selected,
  and the canvas opens with the chat beside it.
- With no workflow: the list shows "New workflow" and one line that says what a workflow is.
  The centre column shows an empty state with the same button.
- The window has no page for agents, chats or routines. The workflow view has no back button,
  and no activity panel shows anywhere.
- At 760 px width: the rail is 56 px wide, the list and the panel column are closed, and the run
  strip stays. A header button opens the list as an overlay, and another opens the chat.
- At 900 px width: the rail keeps its width and the panel column stays. The list is closed, and
  a header button opens it as an overlay.
- Select a server, then a workflow: the right workflow opens, and the selection survives a
  restart. This also holds for a linked computer.
- The add button opens the connect dialog.
- Press Cmd+Q while a run works: the note shows and the app stays. Press it again within 3 seconds:
  the app quits. With nothing running, the first press quits.
- Press Cmd+F on the Settings page: nothing happens. Hold Cmd+Q for 1 second while a run works: the
  app quits. Close the window while a run works: the run goes on, and the Dock icon opens the
  window again.
- A linked server goes offline: the workflow list and the run strip do not show, and the open chat
  shows its cached messages, marked "Offline".
