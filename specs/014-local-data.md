# 014 Local data, privacy and export

## Purpose

The user owns their data. It lives on their computer, it is easy to back up, and nothing leaks.

## Rules

- One local database file holds servers, workflows (with their nodes, responsible documents,
  versions and runs), the chat of each workflow, tasks, memory (with its proposals and history,
  see 008), the proposals and the change log of self-improvement (010), settings, permission
  rules, the action log (007), skills (017) and connections (018). Attachments are files next to
  it.
- The data folder is in the system's app data location under the name "ROBot".
- Each profile (022) has its own database, attachments, logs and keychain entries, apart from
  the other profiles. The rules of this spec hold for each profile.
- The database is the source of truth. Nothing remote is a cache of it. Two computers that sync
  (019) each hold a full copy of the shared data. Both are sources of truth, and the rules of
  019 make them equal. A device that opens a linked server (012) keeps a local cache of recent
  messages for offline reading. The cache is deleted when the link ends and is never exported.
  The state of a sync (019) is not exported either. Backups that sync makes are in a "backups"
  folder in the data folder. The one exception is the articles and sources of knowledge (016):
  they are files in the workspace folder of a workflow. An export copies sources as they are, so the app
  refuses to add a source that holds a stored key (016).
- The app never sends conversation content, files, or commands anywhere except the model provider
  a node uses, the pages a node visits, and the devices that the user linked (012). Traffic
  to a linked device is end-to-end encrypted. There is one more exception, and it is off by
  default: the decision model that the user sets up (see 013). When the user sets it up:
  - For the fast path of computer use (see 007), when the user turns it on, the app sends the goal
    that the text node wrote and the role, label and value of each control of one window. It sends no
    screenshot. It sends no value of a secret control.
  - For permission checks (see 007, "Ask when unsure"), when the user turns them on, the app sends
    the words of the user in the turn (at most 2000 characters), the kind of the step, and the
    full command, the host, or the name of a connection and a tool. A command of more than 500
    characters is not sent, and the step asks.
  - A local server on this computer is the only choice that sends nothing off the computer.
  - There is one more exception: a connection that the user adds on purpose (see 018). The app
    sends data to it only when a text node calls one of its tools. The data is what the node wrote
    in that call, and it can hold content from the conversation. The app sends no other
    conversation text to it. A connection of the kind
    "program on this computer" starts a program on this computer. That program can use the network
    by itself, and the app cannot see this.
- An outside program that the user adds on purpose (023) gets what its tools give: lists, messages,
  tasks and reply text. It runs on this computer, and it can send what it gets to its own model
  provider. The app cannot see this. It is off until the user turns it on.
- A Teams link that the user turns on on purpose (028) is one more exception. The app sends to the
  linked Microsoft Teams chat the answers to work that a message of that chat started: reply text
  and short status lines. It sends nothing else, and it sends nothing when the link is off. The
  text passes through the service of Microsoft. The app reads no password and stores none. The
  sign-in is in a browser profile of this computer. It gives access to the account, so it is
  handled as a secret: an export does not hold it, and sync does not carry it.
- The app sends no usage events and no failure reports. It has no analytics at all.
- A download that the user starts, for a vendor runtime (006) or for test devices (032), is one more
  exception. It sends no content of the user. Test device data (032 to 034) stays on this computer,
  per profile, in the data folder of the profile, and is not in an export. The export holds the
  switch "Test devices" only.
- Voice (027) keeps no sound. Recognition runs on the device. A trigger of a workflow that listens
  for a call (not decided, see the questions for 010) listens on this computer only. Its secret is
  in the keychain, and the file of a workflow and an export hold none.
- The app does not ask other sites for icons or other assets. Every request goes to a service that
  the user set up, to a page that a node visits, or to a download that the user starts (see the
  download exception below).
- Secrets (keys, tokens, secret values of environment variables, secret values of a connection)
  are in the system keychain. Logs and exports redact anything that looks like a secret. A text
  looks like a secret when it equals a stored key, or holds a key or token of a known form: for
  example a long string that starts with "sk-", "ghp_" or "xox", or a block from "-----BEGIN" to
  "PRIVATE KEY-----". The keys of device links are secrets. A linked device never receives
  provider keys. The values of saved secrets (020), and the user names and passwords of saved logins, are in the
  keychain too.
- A service that a saved secret (020) is for gets what a text node writes in a request with that
  secret. The app sends it nothing else.
- The local database also holds the earlier versions of each workflow (010), with the text of its
  responsible document and its prompts, and the times of each task (005). The times hold no
  message text.
- A recording of "Teach a task" (017) stays on this computer. The app sends its list of steps once
  to the model that answers in the chat of the workflow (not decided, see the questions for 014),
  to write the draft skill. The app deletes the recording when the
  user saves or discards the draft.

## Logs

- Logs are files in a logs folder inside the data folder. The user opens the folder from settings
  (see 013). Each log has a size limit; the oldest lines go first.
- There is one log for each of these areas: browser, workflows, outside programs, and the Teams
  link.
  - Browser: failed tool calls, Stop requests with their result, warnings, and live view input
    that the app dropped or refused (see 007).
  - Workflows: retries, final failures of the model calls of text nodes and decision nodes (see
    010).
  - Outside programs: one line for each call (see 023): the time, the entry, the tool, the place
    or task, and the result. It keeps 90 days.
  - Teams link: one line for each event (see 028): the time, the event, the reason and the place.
    It holds no message text and no name of a sender. It keeps 90 days.
- A log line never holds a secret, a key, the text of a message, or a search text (see 001).

## Export and backup

- Export: one archive for one profile (022), with the database, attachments, the knowledge files
  of workflows, and a readme of the format. Secrets are not included. The Teams link and its sign-in (028) are
  not included, and an import brings none back. The archive holds the rules, the action log, the
  skills and
  the connections without their secret values.
- The memory history in the archive follows the rule for secrets above: text that looks like a
  secret is replaced with "[redacted]".
- The archive holds the proposals of self-improvement and the change log of each workflow (010),
  as it holds the rest of the database. An import brings them back. A workflow file (010) holds
  neither.
- Import of a ROBot export into an empty profile (022) restores everything except secrets. Every
  connection comes back turned off (see 018), so an import never starts a program or sends data.
  It comes back with no reviewed tools, so the user reviews its tools again (018). An archive of
  an earlier version, with agents and routines, is not moved to workflows (000, "Out of scope").
  What an import does with it is not decided (see the questions for 014).

## Review before an import

An import of a workflow file (010, `docs/workflow-file-format.md`) shows a review screen before it
makes anything. The user sees each part that the file holds and picks what to keep. The check
(010) has read the file before the screen shows (see the questions for 014).

- The screen lists each workflow of the file with a tick box. Under each workflow are its trigger,
  the number of its nodes, the number of its decision nodes, and the rules that the file holds
  beyond the standard rules of the app (010, "Check"), each with a tick box.
- Ticks at the start:
  - Workflows are ticked. An imported workflow is off, so it starts nothing (010, "File").
  - A part whose text had a secret that the app hid (see "Secrets in text" in
    `docs/workflow-file-format.md`) is not ticked. It shows the mark "A secret was removed".
- A workflow that is not ticked takes its parts with it. A part that is not ticked is left out of
  the new workflow.
- The screen has a part "Not imported". It lists what the file holds that ROBot does not make,
  each with the reason, for example a field that this version does not know.
- The screen shows the counts that it will make, for example "2 workflows (off), 3 rules". The
  import button is off when nothing is ticked.
- After the import, the chat of each new workflow shows one message from the app, not from the
  responsible document: a checklist of what still needs the user. For example "Turn on" for the
  workflow, which is off, or "Set up the decision model" (013) for a workflow with a decision node
  when the choice of the decision model is off. Each item opens the place where the user does it.
  An item ticks itself when it is done. A new workflow shows the same checklist at the top of its
  canvas. A new workflow with nothing to do makes no checklist.
- The review changes nothing in the rules of the file format. A file that the format refuses is
  still refused before the review screen.

## Acceptance

- After an export, searching the archive for a stored key finds nothing.
- Add a connection with a secret value, export, and search the archive for the value: it finds
  nothing. Import the archive into an empty profile: the connection shows and is turned off, and its
  secret value is missing.
- Copy the data folder to a new computer, start the app: all workflows and history are there; the
  providers ask to sign in again.
- Import a workflow file with two workflows. The review screen lists both, ticked, with the number
  of nodes of each. Untick one: one workflow is made, and it is off. Its chat shows a checklist
  with "Turn on". Turn it on: the item ticks.
- A workflow file whose prompt held a key: the review shows that workflow not ticked, with "A
  secret was removed".
- Import a workflow file with a decision node while the decision model is off: the checklist shows
  "Set up the decision model". Set it up: the item ticks.
- A run of a workflow with a text node: the log of the workflows holds a line for each retry of the
  model call, and no message text.
