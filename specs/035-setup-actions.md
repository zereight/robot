# 035 Setup actions

## Purpose

A repository can name commands that prepare a folder before an agent works in it. The user runs
one from the chat. After the user allows the list, a turn runs the commands marked for a turn,
and the first turn in a linked Git worktree runs the commands marked for an own copy. The user
makes and changes the list in the app: in the chat menu and in Settings.

## Concepts

- **Setup action**: one named command in the file `robot.json`. It has a name, a command, and two
  marks: "on an own copy" and "on a turn". A mark that is absent is off. The file sits in the
  workspace, or, when the workspace is inside a Git repository and has no file of its own, at the
  root of that repository. A linked worktree with no file of its own uses the file in the main
  checkout.
- **Allow**: the user's choice that this list may run by itself on this computer. It follows the
  text of the list. A change of that text needs a new allow. It does not sync and an export does
  not hold it.
- **Setup editor**: the form that makes and changes the list of one workspace. It shows the path
  of the file it writes, or that it will make the file in the workspace. Each row holds a name,
  a command, and the two marks. The form has "Add action", "Save" and "Cancel".

The command starts in the workspace of the turn. The environment variable `ROBOT_WORKSPACE` is
that folder. `ROBOT_ORIGIN` is the main checkout when the workspace is a linked worktree, and is
absent otherwise.

## Flows

1. The chat header of an agent always shows the setup entry. When the workspace has a file
   with at least one action, it shows "Run <name>" for the first action. The menu lists every
   action. The pointer on a row shows its command. The user picks one. The command runs in the
   workspace. A success shows "Ran <name>". A failure shows "Setup failed: <name>", or the same
   line with the reason when the command did not start or took too long. When the workspace has
   no list, the header shows "Manage setup actions", which opens the empty editor of flow 5.
2. Allow: the menu has "Allow automatic setup" while the list is not allowed and an action is
   marked. The pointer on it shows the commands that would run by themselves. The user picks it.
   "Stop automatic setup" removes the allow.
3. Turn: a turn whose list is allowed runs every action marked for a turn, in the order of the
   file, before the model is called. The turn waits. A success adds no line. A failure adds a
   muted line on the reply, and the turn goes on. The model does not read the line.
4. Own copy: the first turn whose workspace is a linked Git worktree, and whose list is allowed,
   runs every action marked for an own copy before the actions of flow 3. An action that already
   ran in this turn does not run again. A later turn in the same copy does not run the own-copy
   actions again, while the list is unchanged. A failure is the same line as in flow 3, and the
   next turn tries those actions again. A turn that goes on after a restart does not run them.
5. Manage in the chat: the menu of flow 1 has "Manage setup actions". It opens the editor for
   the file of this workspace. "Add action" adds a row, until 20. A row with no name or no
   command, or past the limits of the Rules, blocks "Save" and says why. "Save" writes the
   file and the menu reads the new list. "Cancel" leaves the file unchanged. A save changes the
   text of the list, so the allow is gone and flow 2 starts again.
6. Manage in Settings: the section "Setup actions" lists the agents of this computer. The user
   picks one. It shows the path of the file of its workspace, or that a save will make the
   file there, the same editor, and the allow with "Allow automatic setup" or "Stop automatic
   setup". A workspace with no file starts with an empty editor, so the first action is made
   here or in the chat header.

## States

- **No file**: the header shows "Manage setup actions", which opens the empty editor. The
  first action is made here or in Settings.
- **Unreadable**: the file is there but is not a setup list. The header shows "Setup actions could
  not be read." No command runs. The editor shows the same line and offers "Replace with a new
  list". It asks first and names the file. On confirm the editor starts empty and "Save" writes
  the new list.
- **Editing**: the editor holds changes that are not saved. Leaving it without "Save" changes
  nothing.
- **Not allowed**: the menu can run one action. A turn runs none by itself.
- **Allowed**: a turn runs the marked actions.
- **Running**: the menu items are off until the command ends or the user stops the turn.
- **Failed**: the muted line or the toast names the action. The output of the command is not shown.

## Rules

- At most 20 actions. A further action is ignored. An action with no name, no command, a name
  longer than 80 characters, a command longer than 4000 characters, or a mark that is not true or
  false, is ignored.
- The file is ignored when it is larger than 64 KiB.
- The actions of one turn share two minutes. A command that is still running at the end of that
  time is stopped, and the later actions of that turn do not run. Stop of the turn stops the
  command. A failed action does not stop the later actions, except when the time is used up.
- One workspace runs one setup at a time. A second turn waits for the first.
- The permission level of the agent does not apply. The actions are not steps of the agent, so
  they are not in the action log (007). Writing `robot.json` is a control place (007), in any
  folder.
- The app does not run a list that the user has not allowed, except when the user picks the
  action in the menu.
- A save writes only the setup list. Other content of `robot.json` stays as it is. A save to a
  workspace with no file makes the file in that workspace. The editor always names the file it
  will write, so the user sees when workspaces share one file.

## Surfaces

- **Ways in**: the file `robot.json`, the menu "Run <name>" in the chat header, "Allow
  automatic setup", "Manage setup actions" in that menu, and the section "Setup actions" in
  Settings.
- **Ways out**: "Stop automatic setup". "Cancel" leaves the file unchanged. Deleting the file
  leaves the header entry, which opens the empty editor. There is no undo for a command that
  already changed files, or for a save that replaced the list. Replacing an unreadable file
  asks first.
- **Devices**: the menu and the editor are on the computer that holds the workspace. A linked
  computer and the phone show neither, also with the switch "Can create and change agents".
  The muted line of a failure is part of the reply, so they show it.
- **Runtimes**: every runtime. The command runs before the program of a vendor starts.
- **Seeing the state**: the menu, the toast, and the muted line. After a restart the line is still
  on the reply. The allow is still in force.
- **Data**: the allow stays on this computer. It does not sync and an export does not hold it.
  The muted line syncs with the message (019). An agent file does not hold the list.
- **Words**: "setup action" is in the glossary. The file name `robot.json` stays in English.

## Out of scope

- A command that runs when a thread ends, a preview address, and an icon for each action.
- Making the own copy. The copy is 025. This spec only runs the actions when a turn starts in one.
- Running the actions on a linked computer or on the phone.

## Acceptance

- A workspace with `robot.json` of one action "Copy .npmrc and configurations/env" shows "Run Copy
  .npmrc and configurations/env". Picking it runs the command in the workspace. The files the
  command writes are there. The toast says it ran.
- The same list is not allowed. A turn starts. The command does not run.
- The user allows the list. An action marked for a turn writes a line into a file. Two turns write
  two lines. The reply has no line when the command succeeds.
- The command exits with an error. The reply shows "Setup failed:" and the name. The turn answers.
- The user changes the command. The next turn does not run it until the user allows the list again.
- A linked worktree has an action marked for an own copy that copies a file from the main checkout.
  The file is not in the worktree. The list is allowed. The first turn copies it once. The second
  turn does not copy it again.
- The command of that action fails. The next turn tries it again.
- "Stop automatic setup", then a turn: the marked actions do not run. The menu still runs one.
- A file that is not JSON shows "Setup actions could not be read." No command runs.
- An agent writes `robot.json`. The step asks, as a write of a control place.
- The menu has "Manage setup actions". It opens the editor with the actions of the file. The
  user changes a command and saves. The file holds the new command, and the menu reads the new
  list. The allow is gone until the user allows the list again.
- Settings lists the agents. The user picks an agent whose workspace has no file. The editor is
  empty and names the workspace. The user adds one action and saves. The file is made, and the
  chat of that agent shows "Run <name>".
- The editor shows the path of the file. Two agents in one repository share it, and a save from
  either chat changes the list of both.
- A row with no name blocks "Save" and says why. "Cancel" leaves the file unchanged.
- The file is not JSON. The editor offers "Replace with a new list", asks first with the path,
  and on confirm a save writes the new list.
- A workspace with no file shows "Manage setup actions" in the chat header. It opens the empty
  editor. The user adds one action and saves. The file is made, and the header shows
  "Run <name>".
