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
| 010 | [Workflows: a graph of steps and triggers, with an assistant and workflow files](010-workflows.md) | Draft |
| 011 | [Phone app: pair with a computer, read and send, notifications](011-phone-app.md) | Draft |
| 012 | [Device link: pair phones and computers, messages, identity, offline behaviour](012-device-link.md) | Draft |
| 013 | [Settings, themes, languages, decision model and roles](013-settings.md) | Draft |
| 014 | [Local data, privacy, secrets and export](014-local-data.md) | Draft |
| 015 | [Notifications and the status island](015-notifications.md) | Draft |
| 016 | [Knowledge: linked articles an agent writes, cites and reads again](016-knowledge.md) | Draft |
| 017 | [Skills: saved instructions that the user calls with a slash](017-skills.md) | Draft |
| 018 | [Connections: outside tools for agents, with approvals](018-connections.md) | Draft |
| 019 | [Sync between two computers: what syncs, conflicts, where tasks run](019-sync.md) | Draft |
| 020 | [Saved secrets: keys and passwords that an agent uses and the model never sees](020-saved-secrets.md) | Draft |
| 021 | [Today: what waits for the user, what went wrong, what ran today, what runs next](021-today.md) | Draft |
| 022 | [Profiles: separate spaces on one computer, switch, background work, what is apart and what is shared](022-profiles.md) | Draft |

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

## Out of scope
What this area does not do.

## Acceptance
Checks an end-to-end test can make.
```
