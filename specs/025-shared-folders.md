# 025 Shared folders

## Purpose

Two or more agents can work in one folder, for example an existing project. They must not write
over the work of each other. The app tells each agent which files the others change now, refuses
a file step on a file that another agent holds, and can give a part of a channel job its own copy
of a Git repository.

## Concepts

- **Shared folder**: the workspace (007) of an agent that is the same folder as the workspace of
  another agent that is not archived, or that is inside it, or that holds it. Two agents with the
  default workspaces (`~/ROBot Agents/<name>`) do not share a folder. Only the agents of one
  profile (022) count.
- **File claim**: a mark that a task holds on one file in a shared folder. It holds the full path,
  the agent, the task and the time. A task gets a claim when its agent writes, makes, renames or
  deletes the file with a file step. A rename claims the old and the new path.
- **Holder**: the agent whose task holds a claim.
- **Shared folder note**: a short text that the app gives to an agent at the start of each turn
  when its workspace is a shared folder. See "Shared folder note".
- **Own copy**: a separate working copy of a Git repository that Git knows about (a Git
  worktree), on a new branch, that the app makes for one part of a channel job (004). The part
  works in the copy and not in the shared folder. See "Own copies".
- **Branch of a part**: the new branch of an own copy. Its name comes from the part label in a
  short form. A number is added when the name is taken.

## Flows

1. Pick a folder: the user picks a workspace folder in the new agent form or the agent profile. If
   the folder is shared, one muted line under the field says "Shares this folder with <names>."
   This is not an error. The user can save.
2. Work: an agent writes a file in a shared folder. The app gives the task a claim on the file.
   Another agent reads the file with no limit.
3. Refusal: an agent tries to write, make, rename or delete a file that the task of another agent
   holds. The step does not run. The tool card shows "Refused: in use by <holder>". The agent gets
   the refusal as a failed step with the name of the holder, the place of its task and the first
   words of its job. The turn goes on. The agent can work on other files, send a message to the
   holder (007), or end the task as Blocked (005).
4. Release: the claims of a task end when the task is final (done, failed, blocked, cancelled) or
   in review (004). After that, any agent can change the files.
5. Own copy: in a channel with the setting "Own copies for parts" on, the lead can mark a part
   "own copy" in its plan. The app makes the copy when the part starts. See "Own copies".

## Shared folder note

- The note holds: the names of the other agents that share the folder, and the claims of their
  tasks now, newest first, at most 50 paths, then "and N more" when there are more.
- The note tells the agent:
  - do not change a file that another agent holds, also not with a shell command;
  - before you change a file near the work of another agent, send it a message;
  - when the work cannot go on without such a file, end the task with a "Blocked:" line (005)
    that names the file and the holder.
- An agent on a vendor runtime (006) gets the note too. The app cannot see or stop the steps of a
  vendor program, so the note is its only guard. See "Rules".
- The note is not words of the user (007). It holds no message text.

## Own copies

- **Channel setting**: "Own copies for parts", in channel settings, off by default. When it is on,
  the lead is told that it can mark a part "own copy" in its plan. The lead is told to do so for a
  part that changes many files, needs a clean build, or makes a risky change, when another part
  works in the same folder at the same time.
- **When the app makes a copy**: the part is marked "own copy", Git is on the computer, the
  workspace of the member is in a Git repository with at least one commit, and fewer than 8 own
  copies exist in the profile. The workspace does not need to be shared.
- **No copy**: when one of these does not hold, the part runs in the workspace itself, with
  claims. The plan step and the task view show "No own copy: <reason>". The reasons are: Git is
  not found, the folder is not in a Git repository, the repository has no commit, 8 copies are in
  use, and the error of Git.
- **Start**: the app makes the copy from the commit that the repository has checked out at that
  moment, on the branch of the part. Changes in the folder that are not committed are not in the
  copy. The part prompt tells the member that it works in an own copy, the name of the branch,
  and this fact.
- **Where**: in a folder for copies under the default folder for workspaces (013). Never inside
  the repository, and never inside the data folder of ROBot (014).
- **During the part**: the copy is the workspace of the turn. The workspace of the member counts as
  outside the workspace for the permission rules (007). A copy has no claims, because only its
  part uses it.
- **End of the part**: when the part is done, in review, failed, blocked or cancelled, the app
  commits all changes in the copy to the branch of the part. The message of the commit is the part
  label. The app makes no commit when nothing changed. The app does not push and does not merge.
- **Later parts**: a nudge of the lead, "Request changes" (004) and Retry (005) of that part run in
  the same copy and on the same branch, while the copy exists.
- **End of the request**: when the lead posts the summary, or the user picks "End the request",
  the app removes the copies of that request. The branches stay. The summary of the lead names the
  branch of each part with an own copy and the number of changed files.
- **Copy kept**: when the commit at the end fails, the copy stays. The part shows "Copy kept:
  <reason>" with "Remove copy". "Remove copy" asks first: "Changes that are not committed are
  lost." The buttons are "Remove copy" and "Back".
- **Restart**: at start, the app commits the changes of each copy whose part is final, as at the
  end of a part, and then removes the copies of requests that ended.
- **Steps of the app**: the app makes a copy, commits to the branch of a part and removes a copy
  by itself. These are not steps of an agent, so they need no approval and are not in the action
  log (007). A commit runs the hooks of the repository, as Git does. An agent that writes a hook
  writes a control place (007, "Sensitive places"), so that step follows the rules of 007.

## States

- **Not shared**: nothing shows.
- **Shared**: the muted line in the form and the profile. Channel settings show one muted line
  under the members for each group of members that share a folder: "<A> and <B> share a folder."
- **Refused**: the tool card "Refused: in use by <holder>". The action log (007) has the step with
  the result Refused, and "shared folder" as the one who decided.
- **Own copy**: the plan step, the part card and the task view show "Own copy · <branch>". While
  the copy exists, the task view also shows "Open the copy", which opens the copy in the system
  file browser, and "Copy the branch name". After the end of the part it shows the number of
  commits and of changed files.
- **No own copy** and **Copy kept**: see "Own copies".

## Rules

- The app compares paths after it resolves links, in the way that the file system of the folder
  compares names.
- A claim belongs to a task, not to an agent. One agent runs one task at a time (005), so an agent
  never holds a claim against itself.
- A task holds at most 1000 claims. A file step that needs claim 1001 is refused with the reason
  "This task changed 1000 files. Finish it, or use an own copy."
- A task that waits for the user (an approval or a question) keeps its claims. A task that waits
  through a restart (005) keeps its claims. Every other task is final after a restart, so its
  claims end.
- Claims cover the file steps of the tools of the app. A shell command is not checked, because the
  app cannot know before the command runs which files it changes. The shared folder note covers
  shell commands.
- An agent on a vendor runtime makes no claims, and the app cannot refuse its steps. The profile of
  such an agent in a shared folder shows one muted line: "<program> does not take part in file
  claims. Use own copies in channels." An agent that uses the tools of the app is still refused
  when it tries to change a file of a task that the app claimed.
- The user, outside programs (023) and agents of another profile take no part in claims.
- The lead is told which members share a folder. It is told to give parts that change the same
  files to one member, or to mark them "own copy" when the setting is on.

## Surfaces

- **Ways in**: the workspace field of the new agent form and of the agent profile, and channel
  settings for "Own copies for parts". Claims need no action of the user.
- **Ways out**: the user picks another folder for an agent, or stops the task that holds the
  claims. The user turns "Own copies for parts" off. A part that runs in an own copy keeps it.
  "Remove copy" for a kept copy. A branch is never removed by the app.
- **Devices**: a linked computer (012) and the phone (011) show the lines, the refused tool
  cards, "Own copy · <branch>" and "Copy kept". "Open the copy" and "Remove copy" are only on the
  computer that runs the part. A linked device changes "Own copies for parts" only with the switch
  "Can create and change agents" (012).
- **Runtimes**: see "Rules". Own copies work for every runtime: the app starts the program of the
  vendor in the copy.
- **Seeing the state**: the tool card, the action log, the plan step, the part card and the task
  view. After a restart, a task that waits keeps its claims, and the task view shows the own copy
  as before.
- **Data**: claims are stored with the task in the local database (014). They do not sync and an
  export does not hold them. The setting "Own copies for parts" syncs with the channel (019), and
  an export holds it. An agent file (002) does not hold it, and an imported channel has it off.
  The own copy line of a part (the branch, the state of the copy, the numbers) is a field of the
  task. It syncs and an export holds it. The copies are on the computer that runs the part.
- **Words**: "shared folder", "file claim" and "own copy" are in the glossary.

## Out of scope

- Merge, push or pull request of a branch. The user does it with Git, or asks an agent in a later
  message.
- Own copies for a direct chat, a reply to a mention or `@all`, a routine, a workflow, or a
  message from another agent.
- Repositories of other version control systems.
- A lock on a whole folder.

## Acceptance

- Agents A and B use one folder. The profile of A shows "Shares this folder with B."
- In a channel, the part of A writes `notes.md`. The part of B tries to write `notes.md`: the
  tool card shows "Refused: in use by A", the file keeps the text of A, and the turn of B goes
  on. B reads `notes.md` with no refusal.
- The part of A ends as Done. The part of B writes `notes.md` again: it runs.
- The part of A waits for an approval. The part of B tries to delete a file that A wrote: it is
  refused.
- A task writes 1000 files in a shared folder. It tries to write one more: the step is refused
  with the reason about 1000 files.
- An agent in a shared folder starts a turn. The note names the other agent and lists its
  claims, newest first.
- Turn on "Own copies for parts" in a channel whose members work in one Git repository. The lead
  marks a part "own copy". The part runs in a copy on a new branch. A file that it writes does not
  change in the repository folder. The part ends: the branch has one commit with the part label.
  The lead posts the summary: it names the branch, and the copy is gone. The branch stays.
- A part marked "own copy" for a member whose folder is not in a Git repository: the part runs in
  the folder, and the plan step shows "No own copy" with the reason.
- With 8 own copies in use, a ninth part marked "own copy" runs in the folder with the reason
  about 8 copies.
- "Request changes" on a part with an own copy: the new part works on the same branch.
- The commit at the end of a part fails. The part shows "Copy kept" with the reason. "Remove
  copy" asks first. "Back" keeps the copy.
