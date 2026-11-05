# 014 Local data, privacy and export

## Purpose

The user owns their data. It lives on their computer, it is easy to back up, and nothing leaks.

## Rules

- One local database file holds servers, agents, conversations, tasks, routines, workflows,
  memory (with its proposals and history, see 008), settings, permission rules, the action log
  (007), skills (017) and connections (018). Attachments are files next to it.
- The data folder is in the system's app data location under the name "ROBot".
- Each profile (022) has its own database, attachments, logs and keychain entries, apart from
  the other profiles. The rules of this spec hold for each profile.
- The database is the source of truth. Nothing remote is a cache of it. Two computers that sync
  (019) each hold a full copy of the shared data. Both are sources of truth, and the rules of
  019 make them equal. A device that opens a linked server (012) keeps a local cache of recent
  messages for offline reading. The cache is deleted when the link ends and is never exported.
  The state of a sync (019) is not exported either. Backups that sync makes are in a "backups"
  folder in the data folder. The one exception is the articles and sources of agent knowledge
  (016): they are files in the agent workspace. An export copies sources as they are, so the app
  refuses to add a source that holds a stored key (016).
- The app never sends conversation content, files, or commands anywhere except the model provider
  an agent uses, the pages an agent visits, and the devices that the user linked (012). Traffic
  to a linked device is end-to-end encrypted. There is one more exception, and it is off by
  default: the decision model that the user sets up (see 013). When the user sets it up:
  - For a channel pick (see 004), the app sends to it the channel name and topic, the last few
    messages of the channel, the job, and the name and role line of each member.
  - For the fast path of computer use (see 007), when the user turns it on, the app sends the goal
    that the agent wrote and the role, label and value of each control of one window. It sends no
    screenshot. It sends no value of a secret control.
  - For permission checks (see 007, "Ask when unsure"), when the user turns them on, the app sends
    the words of the user in the turn (at most 2000 characters), the kind of the step, and the
    full command, the host, or the name of a connection and a tool. A command of more than 500
    characters is not sent, and the step asks.
  - A local server on this computer is the only choice that sends nothing off the computer.
  - There is one more exception: a connection that the user adds on purpose (see 018). The app
    sends data to it only when an agent calls one of its tools. The data is what the agent wrote
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
- Voice (027) keeps no sound. Recognition runs on the device. The web hook of a workflow (010)
  listens on this computer only. Its secret is in the keychain, and the file of a workflow and an
  export hold none.
- The app does not ask other sites for icons or other assets. Every request goes to a service that
  the user set up, to a page that an agent visits, or to a download that the user starts (see the
  download exception below).
- Secrets (keys, tokens, secret values of environment variables, secret values of a connection)
  are in the system keychain. Logs and exports redact anything that looks like a secret. A text
  looks like a secret when it equals a stored key, or holds a key or token of a known form: for
  example a long string that starts with "sk-", "ghp_" or "xox", or a block from "-----BEGIN" to
  "PRIVATE KEY-----". The keys of device links are secrets. A linked device never receives
  provider keys. The values of saved secrets (020), and the user names and passwords of saved logins, are in the
  keychain too.
- A service that an agent has a saved secret for (020) gets what the agent writes in a request
  with that secret. The app sends it nothing else.
- A watch routine on a tool of a connection (009) calls that tool at each check, with the
  arguments that the user saved.
- The local database also holds the instruction history of each agent (002) and the times of
  each task (005). The times hold no message text.
- A recording of "Teach a task" (017) stays on this computer. The app sends its list of steps to
  the model of the agent once, to write the draft skill. The app deletes the recording when the
  user saves or discards the draft.

## Logs

- Logs are files in a logs folder inside the data folder. The user opens the folder from settings
  (see 013). Each log has a size limit; the oldest lines go first.
- There is one log for each of these areas: channels, organizations, browser, workflows, outside
  programs, and the Teams link.
  - Channels: one line for each answer of the decision model (see 004), and one line for each
    look of the lead at a question of a member (004), and one line for each look of an agent on the
    line (030). It holds no job text, no question text, no answer text and no key.
  - Organizations: one line for each repair of the tree and one line for each send that the
    hand-off rule refused (030). It holds no message text.
  - Browser: failed tool calls, Stop requests with their result, warnings, and live view input
    that the app dropped or refused (see 007).
  - Workflows: retries, final failures of model steps and conditions (see 010).
  - Outside programs: one line for each call (see 023): the time, the entry, the tool, the place
    or task, and the result. It keeps 90 days.
  - Teams link: one line for each event (see 028): the time, the event, the reason and the place.
    It holds no message text and no name of a sender. It keeps 90 days.
- A log line never holds a secret, a key, the text of a message, or a search text (see 001).

## Export and backup

- Export: one archive for one profile (022), with the database, attachments, agent knowledge,
  and a readme of the format. Secrets are not included. The Teams link and its sign-in (028) are
  not included, and an import brings none back. The archive holds the rules, the action log, the
  skills and
  the connections without their secret values.
- The cards of the board and their comments (024) are in the archive, with their numbers and
  their links to tasks. An import restores them.
- The org chart (029) is drawn from agents, organizations and tasks, which the archive holds. So an
  import into an empty profile draws the same chart. The positions that the user set with "Arrange"
  are the layout of one computer and are not in the archive, so the imported chart starts with the
  computed places.
- The organizations (030) are in the archive: each one with its name, members, lead, parent, hand-off
  range and daily token limit, the hand-off rule, the switch "Ask up the line", and the
  organizations in the agent lists of skills and connections. An import restores them.
- The memory history in the archive follows the rule for secrets above: text that looks like a
  secret is replaced with "[redacted]".
- Import of a ROBot export into an empty profile (022) restores everything except secrets. Every
  connection comes back turned off (see 018), so an import never starts a program or sends data.
  It comes back with no reviewed tools, so the user reviews its tools again (018). The archive
  holds a handover (003) as messages.

## Review before an import

An import of an agent file (002) or a workflow file (010) shows a review screen before it makes
anything. The user sees each part that the file holds and picks what to keep.

- The screen lists each agent or workflow of the file with a tick box. Under each agent are its
  instructions and each of its routines, each with a tick box. Under each workflow are its
  trigger, the number of its steps, and the agent names that ROBot cannot find.
- Ticks at the start:
  - Agents, workflows and instructions are ticked.
  - Routines are not ticked, because they run by themselves. A routine that the user ticks still
    starts paused.
  - A part whose text had a secret that the app hid (see "Secrets in text" in the file formats)
    is not ticked. It shows the mark "A secret was removed".
  - A workflow of a CC Workflow Studio file that lost a connection at a node that became a note
    (see 010) is not ticked. It shows the mark "Connections were lost".
- An agent file can also hold channels, skills and a handbook (002). The screen lists them after
  the agents, each with a tick box. Channels and skills are ticked, and they say which agents they
  need. The handbook is not ticked, and the screen says that it replaces the handbook of this
  server. Skills are made off.
- An agent that is not ticked takes its instructions and routines with it. Instructions that are
  not ticked leave the new agent with empty instructions.
- A file of CC Workflow Studio (010) goes through the same screen. The screen lists its one
  workflow with a tick box, the number of its steps, and the number of its notes. The file names
  no agent, so the line of agent names is the number of agent steps that need an agent. The screen
  has the field "Agent for agent steps": a list of the agents that are not archived, with the
  choice "None" at the start. An agent that the user picks is the agent of every agent step of
  the workflow.
- The screen has a part "Not imported". It lists what the file holds that ROBot does not make,
  each with the reason, for example a field that this version does not know, or a post step that
  has no place. For a file of CC Workflow Studio it also lists each node that became a note.
- The screen shows the counts that it will make, for example "2 agents, 1 routine (paused)". The
  import button is off when nothing is ticked.
- After the import, the chat of each new agent shows one message from the app, not from the
  agent: a checklist of what still needs the user. For example a paused routine ("Turn on"), or a
  workflow step that needs an agent or a place ("Pick"), or a step that lost an input
  ("Connect"). Each item opens the place where the user
  does it. An item ticks itself when it is done. A new workflow shows the same checklist at the
  top of its canvas. A new item with nothing to do makes no checklist.
- The review changes nothing in the rules of the file formats. A file that the formats refuse is
  still refused before the review screen.

## Acceptance

- Run a channel job with the fast pick set up. The channels log holds one line for it. A search
  of the log finds neither the job text nor the key.
- After an export, searching the archive for a stored key finds nothing.
- Add a connection with a secret value, export, and search the archive for the value: it finds
  nothing. Import the archive into an empty profile: the connection shows and is turned off, and its
  secret value is missing.
- Copy the data folder to a new computer, start the app: all agents and history are there; the
  providers ask to sign in again.
- Import an agent file with two agents and three routines. The review screen shows the routines
  not ticked. Tick one routine and untick one agent: one agent is made, with one paused routine,
  and its chat shows a checklist with "Turn on" for the routine. Turn it on: the item ticks.
- An agent file whose instructions held a key: the review shows the instructions not ticked,
  with "A secret was removed".
- Import a workflow file with a post step: "Not imported" names the place of the step, and the
  canvas of the new workflow shows the checklist item "Pick".
- Import a CC Workflow Studio file with a question node between two prompt nodes: the review shows
  the workflow not ticked, with "Connections were lost", and "Not imported" names the question
  node. Tick it and import: the canvas shows a pink note, and the checklist item "Connect" for the
  second prompt step. Pick the agent "Reviewer" in "Agent for agent steps" and import again: no
  item "Pick" shows.
