# Behaviour specs

Each spec describes one area of ROBot from the user's side. Implementers build from these files
only. Follow the limits in [CLEANROOM.md](../CLEANROOM.md#what-a-spec-must-not-contain).

## Index

| No. | Area | State |
| --- | --- | --- |
| 000 | [Product](000-product.md) | Draft |
| 001 | [Window layout: server rail, place list with user sections, conversation, activity panel](001-window-layout.md) | Draft |
| 002 | [Agents: create, starters, face, name, role, edit, archive, main agent, agent files, recent work](002-agents.md) | Draft |
| 003 | [Direct chat with one agent: send, stream, stop, attach, reply, threads, context](003-direct-chat.md) | Draft |
| 004 | [Channels: several agents, one job, lead agent, split work, check and verdicts, `@all`, fast pick](004-channels.md) | Draft |
| 005 | [Tasks and plan steps: queue, run, wait, finish, fail, retry, moments](005-tasks.md) | Draft |
| 006 | [Providers: connect a model account, choose a model per agent, switch](006-providers.md) | Draft |
| 007 | [Agent workspace and tools: files, shell, browser, approvals, permission rules, action log, other agents, computer use](007-workspace-and-tools.md) | Draft |
| 008 | [Memory: what an agent keeps between chats, and how the user edits it](008-memory.md) | Draft |
| 009 | [Routines: scheduled jobs, calendar, missed runs, limits and pause on repeated failure](009-routines.md) | Draft |
| 010 | [Workflows: a graph of steps and triggers, with an assistant, workflow files and starters](010-workflows.md) | Draft |
| 011 | [Phone app: pair with a computer, read and send, notifications](011-phone-app.md) | Draft |
| 012 | [Device link: pair phones and computers, messages, identity, offline behaviour](012-device-link.md) | Draft |
| 013 | [Settings, themes, languages, decision model and roles](013-settings.md) | Draft |
| 014 | [Local data, privacy, secrets and export](014-local-data.md) | Draft |
| 015 | [Notifications and the status island](015-notifications.md) | Draft |
| 016 | [Knowledge: linked articles an agent writes, cites and reads again](016-knowledge.md) | Draft |
| 017 | [Skills: saved instructions that the user calls with a slash](017-skills.md) | Draft |
| 018 | [Connections: outside tools for agents, with approvals, and tool search for many tools](018-connections.md) | Draft |
| 019 | [Sync between two computers: what syncs, conflicts, where tasks run](019-sync.md) | Draft |
| 020 | [Saved secrets: keys and passwords that an agent uses and the model never sees](020-saved-secrets.md) | Draft |
| 021 | [Today: what waits for the user, what went wrong, what ran today, what runs next](021-today.md) | Draft |
| 022 | [Profiles: separate spaces on one computer, switch, background work, what is apart and what is shared](022-profiles.md) | Draft |
| 023 | [Outside programs: read and send work from another program on this computer, through MCP](023-outside-programs.md) | Draft |
| 024 | [Board: one board for all agents, work of every agent as it runs, planned cards, start a card as a task, tools for agents](024-board.md) | Draft |
| 027 | [Voice: dictate into the message box, read a reply aloud, voice chat on the phone](027-voice.md) | Draft |

## Milestones

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
| M25 | The changes to 000, 003, 005, 007, 008, 011, 012, 014, 016, 017, 018 and 019 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S80 to S84: pictures from the web, sensitive places, review of connection tools, handover of a chat, make a skill from work |
| M28 | 027, and the changes to 001, 002, 003, 004, 005, 006, 007, 009, 010, 011, 012, 013, 014, 015, 019, 020 and 022 listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S86 to S100: backup model, keep going on open steps, channel turns and picture, browser details, voice, quiet phone notices, web hook, effort levels and model list, ACP programs, saved logins, menu bar and sound, phone extras, place list extras, idle work, busy provider |

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
