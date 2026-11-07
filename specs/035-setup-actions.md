# 035 Setup actions

## Purpose

A repository can name commands that prepare a folder before a text node works in it. The user runs
one from the workflow view. After the user allows the list, the start of a task runs the commands
marked for a turn, and the first task in a linked Git worktree runs the commands marked for an own
copy. The user makes and changes the list in the app: in the menu of the workflow view and in
Settings.

## Concepts

- **Setup action**: one named command in the file `robot.json`. It has a name, a command, and two
  marks: "on an own copy" and "on a turn". A mark that is absent is off. The file sits in the folder
  of the workflow (007), or, when the folder is inside a Git repository and has no file of its own,
  at the root of that repository. A linked worktree with no file of its own uses the file in the
  main checkout.
- **Start of a task**: the first turn of a task of a text node (005). The model has not been called
  yet. A later turn of the same task (005, "Keep going") is not a start. A decision node has no
  folder and no start. A turn of the chat (003) is not a start.
- **Allow**: the user's choice that this list may run by itself on this computer. It follows the
  text of the list. A change of that text needs a new allow. It does not sync and an export does
  not hold it.
- **Setup editor**: the form that makes and changes the list of one folder. It shows the path of
  the file it writes, or that it will make the file in the folder. It lists the actions: each row
  runs its action, shows the name and the command, and opens the row for a change. "Add action"
  opens a new row. A row holds the name, the command, and the two marks. The form has "Save" and
  "Cancel".

The command starts in the folder of the workflow. The environment variable `ROBOT_WORKSPACE` is
that folder. `ROBOT_ORIGIN` is the main checkout when the folder is a linked worktree, and is
absent otherwise.

## Flows

1. The header of the workflow view always shows the setup entry. When the folder has a file with at
   least one action, it shows "Run <name>" for the first action. The menu lists every action. The
   pointer on a row shows its command. The user picks one. The command runs in the folder. A
   success shows "Ran <name>". A failure shows "Setup failed: <name>", or the same line with the
   reason when the command did not start or took too long. When the folder has no list, the header
   shows "Manage setup actions", which opens the empty editor of flow 5.
2. Allow: the menu has "Allow automatic setup" while the list is not allowed and an action is
   marked. The pointer on it shows the commands that would run by themselves. The user picks it.
   "Stop automatic setup" removes the allow.
3. Start of a task: the start of a task whose list is allowed runs every action marked for a turn,
   in the order of the file, before the model is called. The task waits. A success adds no line. A
   failure adds a muted line on the task in the run view, and the task goes on. The model does not
   read the line.
4. Own copy: the first task whose folder is a linked Git worktree, and whose list is allowed, runs
   every action marked for an own copy before the actions of flow 3. An action that already ran at
   this start does not run again. A later task in the same copy does not run the own-copy actions
   again, while the list is unchanged. A failure is the same line as in flow 3, and the next task
   tries those actions again.
5. Manage in the workflow view: the menu of flow 1 has "Manage setup actions". It opens the editor
   for the file of the folder of this workflow. The editor lists the actions. Each row runs its
   action, shows the name and the start of the command, and opens the row for a change. "Add
   action" opens a new row, until 20 rows. The row holds the name, the command, and the two marks;
   a row that exists also holds "Delete". A name or a command that breaks the limits blocks the
   save of the row and says why. "Save" writes the file and the menu reads the new list. "Cancel"
   leaves the file unchanged. A save changes the text of the list, so the allow is gone and flow 2
   starts again.
6. Manage in Settings: the section "Setup actions" lists the workflows of this computer. The user
   picks one. It shows the path of the file of its folder, or that a save will make the file there,
   the same editor, and the allow with "Allow automatic setup" or "Stop automatic setup". A folder
   with no file starts with an empty editor, so the first action is made here or in the header of
   the workflow view.

## States

- **No file**: the header shows "Manage setup actions", which opens the empty editor. The
  first action is made here or in Settings.
- **Unreadable**: the file is there but is not a setup list. The header shows "Setup actions could
  not be read." No command runs. The editor shows the same line and offers "Replace with a new
  list". It asks first and names the file. On confirm the editor starts empty and "Save" writes
  the new list.
- **Editing**: the editor holds changes that are not saved. Leaving it without "Save" changes
  nothing.
- **Not allowed**: the menu can run one action. A task runs none by itself.
- **Allowed**: the start of a task runs the marked actions.
- **Running**: the menu items are off until the command ends or the user stops the task.
- **Failed**: the muted line or the toast names the action. The output of the command is not shown.

## Rules

- At most 20 actions. A further action is ignored. An action with no name, no command, a name
  longer than 80 characters, a command longer than 4000 characters, or a mark that is not true or
  false, is ignored.
- The file is ignored when it is larger than 64 KiB.
- The actions of one start share two minutes. A command that is still running at the end of that
  time is stopped, and the later actions of that start do not run. Stop of the task stops the
  command. A failed action does not stop the later actions, except when the time is used up.
- One folder runs one setup at a time. A second task that starts in that folder waits for the first.
- The permission level of the workflow and of the node does not apply. The actions are not steps of
  a node, so they are not in the action log (007). Writing `robot.json` is a control place (007), in
  any folder.
- The app does not run a list that the user has not allowed, except when the user picks the
  action in the menu.
- A save writes only the setup list. Other content of `robot.json` stays as it is. A save to a
  folder with no file makes the file in that folder. The editor always names the file it will write,
  so the user sees when folders share one file.
- Only the user sets the allow. A node can change the list only as a write to a control place. That
  write follows the rules of 007 for a change to a control place (007, "Change to a control
  place"). A changed list loses its allow. A proposal of self-improvement (002) and the responsible
  document, which has no file tools, cannot change the list or the allow.

## Surfaces

- **Ways in**: the file `robot.json`, the menu "Run <name>" in the header of the workflow view,
  "Allow automatic setup", "Manage setup actions" in that menu, and the section "Setup actions" in
  Settings.
- **Ways out**: "Stop automatic setup". "Cancel" leaves the file unchanged. Deleting the file
  leaves the header entry, which opens the empty editor. There is no undo for a command that
  already changed files, or for a save that replaced the list. Replacing an unreadable file
  asks first.
- **Devices**: the menu and the editor are on the computer that holds the folder. A linked
  computer and the phone show neither, also with the switch "Can create and change workflows". The
  muted line of a failure is part of the task in the run view, so a linked computer shows it.
- **Runtimes**: every runtime. The command runs before the program of a vendor starts.
- **Seeing the state**: the menu, the toast, and the muted line. The allow is still in force after a
  restart.
- **Data**: the allow stays on this computer. It does not sync and an export does not hold it. The
  workflow file (010) does not hold the list.
- **Words**: "setup action" is in the glossary. The file name `robot.json` stays in English.

## Out of scope

- A command that runs when a run ends, a preview address, and an icon for each action.
- Making the own copy. This spec only runs the actions when a task starts in one.
- Running the actions on a linked computer or on the phone.
- Setup before a turn of the chat. The chat has no file tools (007).

## Acceptance

- A folder with `robot.json` of one action "Copy .npmrc and configurations/env" shows "Run Copy
  .npmrc and configurations/env". Picking it runs the command in the folder. The files the
  command writes are there. The toast says it ran.
- The same list is not allowed. A task of a text node starts. The command does not run.
- The user allows the list. An action marked for a turn writes a line into a file. Two tasks write
  two lines. The task has no line when the command succeeds.
- A turn of the chat starts: no action runs. A second turn of one task (a continuation) runs no
  action.
- A task of a decision node runs: no action runs.
- The command exits with an error. The run view shows "Setup failed:" and the name on the task. The
  task goes on.
- The user changes the command. The next task does not run it until the user allows the list again.
- A linked worktree is the folder of a workflow, and an action is marked for an own copy that
  copies a file from the main checkout. The file is not in the worktree. The list is allowed. The
  first task copies it once. The second task does not copy it again.
- The command of that action fails. The next task tries it again.
- "Stop automatic setup", then a task: the marked actions do not run. The menu still runs one.
- A file that is not JSON shows "Setup actions could not be read." No command runs.
- A text node writes `robot.json`. The write follows the rules of 007 for a change to a control
  place: the level of the workflow, and an Allow rule, decide if it asks, runs or is refused. A
  refusal leaves the file as it was. When the file changes, a changed list loses its allow.
- The responsible document is asked to change `robot.json`: it has no tool for it, and the file
  does not change.
- The menu has "Manage setup actions". It opens the editor, which lists the actions of the
  file. The user opens a row, changes its command, saves the row, and saves. The file holds the
  new command, and the menu reads the new list. The allow is gone until the user allows the
  list again.
- Settings lists the workflows. The user picks a workflow whose folder has no file. The editor is
  empty and names the folder. The user opens "Add action", fills the name and the command,
  saves the row, and saves. The file is made, and the header of that workflow shows "Run <name>".
- The editor shows the path of the file. Two workflows in one repository share it, and a save from
  either workflow changes the list of both.
- A row with no name blocks the save of the row and says why. "Cancel" leaves the file
  unchanged.
- A row of the editor runs its action. The toast says it ran.
- The file is not JSON. The editor offers "Replace with a new list", asks first with the path,
  and on confirm a save writes the new list.
- A folder with no file shows "Manage setup actions" in the header of the workflow view. It opens
  the empty editor. The user adds one action and saves. The file is made, and the header shows
  "Run <name>".
