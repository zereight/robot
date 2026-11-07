# Behaviour specs

Each spec describes one area of ROBot from the user's side. It describes behaviour, never
implementation (see [AGENTS.md](../AGENTS.md)).

## Index

| No. | Area | State |
| --- | --- | --- |
| 000 | [Product](000-product.md) | Draft |
| 001 | [Window layout: server rail, workflow list, workflow view with its chat, activity panel](001-window-layout.md) | Draft |
| 002 | [Responsible document: the text that answers for a workflow, its history, progress and feedback in the chat, and self-improvement](002-agents.md) | Draft |
| 003 | [Workflow chat: send, stream, stop, attach, reply, progress of a run, results and feedback, threads, context](003-direct-chat.md) | Draft |
| 005 | [Tasks: one run of a node, queue, wait, finish, fail, retry, reasons and results](005-tasks.md) | Draft |
| 006 | [Providers: connect a model account, choose a model per agent, switch](006-providers.md) | Draft |
| 007 | [Workflow folder and tools: files, shell, browser, approvals, permission rules, action log, computer use, and the tools of the chat for a run](007-workspace-and-tools.md) | Draft |
| 008 | [Memory: what a workflow keeps between runs, how the user edits it, and memory proposals](008-memory.md) | Draft |
| 010 | [Workflows: a graph of nodes with a responsible document, one chat and one memory, a TLA file, and a check of the TLA form](010-workflows.md) | Draft |
| 011 | [Phone app: pair with a computer, run workflows, ask and give feedback, read and send, notifications](011-phone-app.md) | Draft |
| 012 | [Device link: pair phones and computers, what a client does with workflows, messages, identity, offline behaviour](012-device-link.md) | Draft |
| 013 | [Settings, themes, languages, decision model and roles](013-settings.md) | Draft |
| 014 | [Local data, privacy, secrets, export, and the review before an import of a workflow file](014-local-data.md) | Draft |
| 015 | [Notifications and the status island: notices of replies, approvals, failed nodes, finished runs and proposals, each leading to the chat of the workflow](015-notifications.md) | Draft |
| 016 | [Knowledge: linked articles that the nodes of a workflow write, cite and read again](016-knowledge.md) | Draft |
| 017 | [Skills: saved instructions that the user calls with a slash, and that a prompt can include](017-skills.md) | Draft |
| 018 | [Connections: outside tools for agents, with approvals, and tool search for many tools](018-connections.md) | Draft |
| 019 | [Sync between two computers: what syncs, conflicts, where workflows run](019-sync.md) | Draft |
| 020 | [Saved secrets: keys and passwords that the nodes of a workflow use and the model never sees](020-saved-secrets.md) | Draft |
| 022 | [Profiles: separate spaces on one computer, switch, background work, what is apart and what is shared](022-profiles.md) | Draft |
| 023 | [Outside programs: read and send work from another program on this computer, through MCP](023-outside-programs.md) | Draft |
| 025 | [Shared folders: file claims between agents in one folder](025-shared-folders.md) | Draft |
| 026 | [Token savings: three switches, check with edit, big results aside, compact at finished steps, and which agents each one reaches](026-token-savings.md) | Draft |
| 027 | [Voice: dictate into the message box, read a reply aloud, voice chat on the phone](027-voice.md) | Draft |
| 028 | [Chat bridge: talk to the responsible document of one workflow from a Microsoft Teams chat, who may call, answers and the outbox, states, data rules](028-chat-bridge.md) | Draft |
| 032 | [Test devices: the downloaded program of another vendor, its panel in the window, the built-in connection, and the rules and cards of a device step](032-test-devices.md) | Draft |
| 033 | [Logs and measurements of test devices: what an agent may read, redaction, the limits, CPU and memory, Display FPS](033-test-device-logs-and-measurements.md) | Draft |
| 034 | [App data, screen map and performance files: stores and changes, erase steps, the screen map and the screen walk of a project, the analysis of a file](034-app-data-and-performance-files.md) | Draft |
| 035 | [Setup actions: commands a repository names, run from the chat, at the start of a turn, and on the first turn in an own copy](035-setup-actions.md) | Draft |
| 037 | [Manage tools: the responsible document and an outside program make workflows, each change a request that the user allows](037-manage-tools.md) | Draft |
| 038 | [Events: what arrived from a schedule, an outside program or Teams, which workflow took it, and the reason when nothing did](038-events.md) | Draft |
| 039 | [Looping motion: spinners and pulses that show running work move at one pace and stop with reduce motion](039-looping-motion.md) | Draft |

## Milestones

The specs 004, 021, 024, 029, 030, 031 and 036 are deleted, and the other specs lost their parts
about organizations, the org chart, channels, channel starters, the board and Today (decision 2
of [docs/rebuild-plan.md](../docs/rebuild-plan.md)). Spec 009 is deleted too (decision 12 of
[docs/proposal-workflow-first.md](../docs/proposal-workflow-first.md)): a routine is now a trigger
of a workflow (010). The rows below are a record of past slices. Their words about those areas do
not apply now.

| Milestone | Specs | Result |
| --- | --- | --- |
| M1 | 000, 001, 002, 003, 006, 013, 014 | Desktop app: agents and direct chat with one API provider |
| M2 | 004, 005 | Channels, split work, tasks page |
| M3 | 007, 008 | Workspace tools, approvals, browser, memory |
| M4 | 009, 010 | Routines and workflows |
| M5a | 012, 001, 013, 014, 015 | Link between computers, on one network or through a VPN |
| M5b | 011, 012 | Phone app that pairs with one or more computers (version Phone 1 of 011) |
| M5c | 019, 012 | Sync between two computers (after M5a) |
| M6 | 015 | Notifications and status island |
| M7 | Changes listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S18 to S25 |
| M8 | 016 | Agent knowledge: articles, sources, check |
| M9 | 017, 018, and the changes to 007 and 009 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S29 to S32: routine limits, permission rules and action log, skills, connections |
| M10 | The changes to 003, 004, 005, 006, 007, 009, 010, 012, 013, 015 and 019 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S35 to S37: limits of a task and the retry note, runtime states and the level "Read only", review of parts and Blocked |
| M11 | 020, and the changes to 002, 003, 005, 007, 008, 009, 013, 014 and 017 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S38 to S45: messages during a turn, outside content, changes from the chat, saved secrets, task times, watch routines, review before an import, teach a task |
| M12 | 021, and the changes to 001, 003, 005, 006, 007, 008, 011, 012, 013, 014, 019 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S46 to S49: message search, silent and cut turns, the Today page, memory control |
| M13 | The changes to 000, 002, 004, 005, 008, 009, 016, 017 and 019 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S50 to S54: honest wording, verdicts in the check, work record, starters, skills that go with their agent |
| M14 | The changes to 000, 001, 011, 012 and 015 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slice S55: the desktop app is for Macs with Apple silicon only; the phone app is for iOS and Android |
| M15 | 022, and the changes to 000, 001, 011, 012, 013, 014, 015 and 019 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S57 and S58: profiles on one computer, and profiles with linked devices and sync |
| M16 | The changes to 003, 004, 005, 012 and 015 listed in [docs/spec-changes.md](../docs/spec-changes.md), and the phone plan of [docs/performance.md](../docs/performance.md) | Slices S59 and S60: the quiet line, and the measures of the phone app |
| M17 | 023, and the changes to 000, 002, 004, 005, 007, 008, 009, 012, 013, 014, 017, 018 and 019 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S61 to S68: usage of a task and token limits, "Ask when unsure", read-only marks, memory check, channel notes, handbook and channel instructions, team file, outside programs |
| M18 | The change to 010 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slice S69: the workflow starter "TLA+ check" |
| M19 | The changes to 003, 005, 013 and 019 listed in [docs/spec-changes.md](../docs/spec-changes.md), with S20 | Slices S20, S70, S71 and S72: threads, context meter and compact, automatic compact, the order of the task queue with "Run next", and the number of slots ("Agents working at once") |
| M20 | 024, and the changes to 001, 005, 007, 012, 014, 019 and 022 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slice S73: the board |
| M21 | 025, and the changes to 004, 005, 007, 011, 014, 015, 019, 021 and 024 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S74 to S76: the lead answers questions of members, file claims in shared folders, own copies for parts |
| M22 | The changes to 007, 008, 022 and 023 listed in [docs/spec-changes.md](../docs/spec-changes.md), and the plan of [docs/memory-evaluation.md](../docs/memory-evaluation.md) | Slices S78 and S79: the tools "search chats" and "read chat", and the measure of memory against search |
| M25 | The changes to 000, 003, 005, 007, 008, 011, 012, 014, 016, 017, 018 and 019 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S80 to S84: pictures from the web, sensitive places, review of connection tools, handover of a chat, make a skill from work |
| M26 | The changes to 002 and 006 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slice S85: the effort of a new agent |
| M27 | 026, and the changes to 003, 006, 007, 013 and 015 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slice S77: token savings |
| M28 | 027, and the changes to 001, 002, 003, 004, 005, 006, 007, 009, 010, 011, 012, 013, 014, 015, 019, 020 and 022 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S86 to S100: backup model, keep going on open steps, channel turns and picture, browser details, voice, quiet phone notices, web hook, effort levels and model list, ACP programs, saved logins, menu bar and sound, phone extras, place list extras, idle work, busy provider |
| M29 | 028, and the changes to 000, 002, 003, 005, 007, 013, 014, 015, 019, 021 and 022 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S101 to S105: the Teams link, calls from Teams, answers and the outbox, answers for a channel, pause and notices |
| M30 | 029, and the changes to 001, 011, 012, 014 and 019 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slice S106: the org chart |
| M31 | The changes to 001, 002, 011, 012 and 013 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slice S107: the role label, the role badge and the filter of places by role |
| M32 | 030, and the changes to 002, 004, 005, 006, 007, 011, 012, 013, 014, 017, 018, 019 and 029 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S108 to S112: edit on the org chart, sub-channels, the hand-off rule, ask up the line, tools and daily token limit of a channel |
| M33 | The changes to 003, 011 and 013 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slice S113: folded tool steps |
| M34 | 032, 033, 034, and the changes to 000, 001, 007, 013, 014 and 018 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S115 to S117: the built-in connection, its download and its panel, the cards and the classes of the device steps, and the limits of logs, measurements, app data and the analysis of a performance file |
| M35 | The changes to 002, 004, 005, 006, 007, 011, 012, 013, 014, 017, 018, 019, 029, 030 and 031 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S126 to S129: organizations replace the channel tree, the org chart of organizations, access with inherited values, and the hand-off rule and ask up the line by organizations |
| M36 | 036, and the changes to 001, 003, 004, 011, 012, 013, 019, 029 and 030 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S130 and S131: one line of organizations for the members of an agent, and the organization prefix |
| M37 | 037, and the changes to 002, 004, 007, 009 and 023 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S133 to S137: make an agent for the main agent, tools for agents, tools for channels, tools for routines, manage tools for outside programs |
| M38 | The changes to 001, 011 and 036 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slice S138: agents by organization |
| M39 | 038, and the changes to 001, 005, 009, 010, 023 and 028 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slice S139: the tab "Events" and "Check where this goes" |
| M40 | The changes to 014, 019 and 029 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S140 to S143: org chart arrange, outlines, details and step |
| M41 | The changes to 002, 010 and 030 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S144 to S146: the owner of a workflow and the participants of its agent steps, the workflows of organizations and agents, and the button "New agent" in the form of an organization |
| W1 | The changes to 000, 001 and 010. The slice is in the table of slices of [docs/proposal-workflow-first.md](../docs/proposal-workflow-first.md). The open points are in [docs/spec-questions.md](../docs/spec-questions.md), under the heading "W1". | Slice W1: the workflow is the product. It is a graph of nodes with a responsible document, one chat and one memory, and a TLA file that the check reads. |
| W2 | The changes to 002, 003, 005, 007, 008, 017 and 037, and the end of 009. The slice is in the table of slices of [docs/proposal-workflow-first.md](../docs/proposal-workflow-first.md). The open points are in [docs/spec-questions.md](../docs/spec-questions.md), under the heading "W2". | Slice W2: the agent is no longer an object. The responsible document, the chat, the memory and self-improvement belong to the workflow. Spec 009 is deleted (decision 12). |
| R2 | The changes to 015, 016, 020, 028 and 038. The open points are in [docs/spec-questions.md](../docs/spec-questions.md), under the heading "R2". | Slice R2: a secret, an article, a notice, an event and a Teams chat belong to a workflow or to the user. A Teams message talks to the responsible document of one workflow. |

## Surfaces check

A change that works in one place and is missing in the others is the most common gap. Before a
spec goes to an implementer, the author answers each line below in the spec. "Not in this version"
is a valid answer when the spec says it.

- **Ways in**: the place where the user starts the action, and the other ways to the same action:
  a menu, the search field (Cmd+K), a key, a setting, a command of the message box.
- **Devices**: the computer, a linked computer (012), the phone (011), and a second profile (022).
  Say what each one shows and what each one can do.
- **Runtimes**: an agent that uses the tools of the app, and an agent on each vendor runtime (006).
  Say what changes, or say that nothing changes.
- **Ways out**: each way in has a way out. Pause has resume, hide has show, archive has restore,
  on has off. A change that the user cannot undo asks first and says so.
- **Seeing the state**: the place where the user sees that the thing is on, waits, runs, or failed,
  also after a restart.
- **Data**: what syncs (019), what an export holds (014), what a file of agents or workflows
  holds, and what the phone keeps in its cache.
- **Words**: new words go in [docs/glossary.md](../docs/glossary.md), in English and Korean.

## Template

```markdown
# NNN Area

## Purpose
One paragraph: what the user gets.

## Concepts
The things the user knows about, with their fields in plain words.

## Flows
Numbered steps for each thing the user does.

## States
Empty, loading, working, done, failed, offline. What the user sees in each.

## Rules
Limits, order, permissions, storage.

## Surfaces
Where the feature shows and how the user leaves it. See "Surfaces check" above.

## Out of scope
What this area does not do.

## Acceptance
Checks an end-to-end test can make.
```
