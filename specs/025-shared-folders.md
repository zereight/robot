# 025 Shared folders

## Purpose

Two or more workflows can use one folder, for example an existing project. Their text nodes must
not write over the work of each other. The app tells each text node which files the other workflows
change now, and refuses a file step on a file that another workflow holds.

## Concepts

- **Shared folder**: the folder (007) of a workflow that is the same folder as the folder of another
  workflow, or that is inside it, or that holds it. Two workflows with the default folders (an
  empty folder for each workflow in the default workspace folder of 013) do not share a folder. Only
  the workflows of one profile (022) count.
- **File claim**: a mark that a task holds on one file in a shared folder. It holds the full path,
  the workflow, the task and the time. A task gets a claim when its text node writes, makes,
  renames or deletes the file with a file step. A rename claims the old and the new path.
- **Holder**: the workflow whose task holds a claim.
- **Shared folder note**: a short text that the app gives to a text node at the start of each turn
  when the folder of its workflow is a shared folder. See "Shared folder note".

## Flows

1. Pick a folder: the user picks the folder of a workflow in the editor of the workflow (007). If
   the folder is shared, one muted line under the field says "Shares this folder with <names>."
   This is not an error. The user can save.
2. Work: a text node writes a file in a shared folder. The app gives the task a claim on the file.
   A task of another workflow reads the file with no limit.
3. Refusal: a text node tries to write, make, rename or delete a file that the task of another
   workflow holds. The step does not run. The tool card shows "Refused: in use by <holder>". The
   node gets the refusal as a failed step with the name of the holder, the name of its node and the
   first words of the prompt of that node. The turn goes on. The node can work on other files, or
   end the task as Blocked (005).
4. Release: the claims of a task end when the task is final (done, failed, blocked, cancelled).
   After that, any workflow can change the files.

## Shared folder note

- The note holds: the names of the other workflows that share the folder, and the claims of their
  tasks now, newest first, at most 50 paths, then "and N more" when there are more.
- The note tells the node:
  - do not change a file that another workflow holds, also not with a shell command;
  - when the work cannot go on without such a file, end the task with a "Blocked:" line (005)
    that names the file and the holder.
- A text node on a vendor runtime (006) gets the note too. The app cannot see or stop the steps of
  a vendor program, so the note is its only guard. See "Rules".
- The note is not words of the user (007). It holds no message text.

## States

- **Not shared**: nothing shows.
- **Shared**: the muted line in the editor of the workflow.
- **Refused**: the tool card "Refused: in use by <holder>". The action log (007) has the step with
  the result Refused, and "shared folder" as the one who decided.

## Rules

- The app compares paths after it resolves links, in the way that the file system of the folder
  compares names.
- A claim belongs to a task, not to a workflow. One workflow runs one task at a time (005), so a
  workflow never holds a claim against itself.
- A task holds at most 1000 claims. A file step that needs claim 1001 is refused with the reason
  "This task changed 1000 files. Finish it."
- A task that waits for the user (an approval or a question) keeps its claims. Every other task is
  final after a restart, a task that waited too (005), so its claims end.
- Claims cover the file steps of the tools of the app. A shell command is not checked, because the
  app cannot know before the command runs which files it changes. The shared folder note covers
  shell commands.
- A text node on a vendor runtime makes no claims, and the app cannot refuse its steps. The editor
  of a workflow with such a node in a shared folder shows one muted line: "<program> does not take
  part in file claims." A text node that uses the tools of the app is still refused when it tries to
  change a file of a task that the app claimed.
- The user, outside programs (023), the responsible document and workflows of another profile take
  no part in claims.
- The folder of a workflow changes only by the user (010). A change of the folder does not move a
  claim.

## Surfaces

- **Ways in**: the folder field in the editor of the workflow. Claims need no action of the user.
- **Ways out**: the user stops the task that holds the claims. The user can pick another folder
  for a workflow only when no run of that workflow works (007).
- **Devices**: a linked computer (012) and the phone (011) show the lines and the refused tool
  cards.
- **Runtimes**: see "Rules".
- **Seeing the state**: the tool card and the action log. A task that waits keeps its claims until
  it ends.
- **Data**: claims are stored with the task in the local database (014). They do not sync and an
  export does not hold them.
- **Words**: "shared folder" and "file claim" are in the glossary.

## Out of scope

- A lock on a whole folder.
- A separate copy of a repository for each workflow.
- A message from a node to the holder. A workflow has no tool for it (007).

## Acceptance

- Workflows A and B use one folder. The editor of A shows "Shares this folder with B."
- A task of A writes `notes.md`. A task of B tries to write `notes.md`: the tool card shows
  "Refused: in use by A", the file keeps the text of A, and the turn of B goes on. B reads
  `notes.md` with no refusal.
- The task of A ends as Done. The task of B writes `notes.md` again: it runs.
- The task of A waits for an approval. The task of B tries to delete a file that A wrote: it is
  refused.
- A task writes 1000 files in a shared folder. It tries to write one more: the step is refused
  with the reason about 1000 files.
- A text node in a shared folder starts a turn. The note names the other workflow and lists its
  claims, newest first.
- Two workflows have the default folders: the editor shows no "Shares this folder" line, and no
  claim refuses a step.
