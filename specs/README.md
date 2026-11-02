# Behaviour specs

Each spec describes one area of ROBot from the user's side. Implementers build from these files
only. Follow the limits in [CLEANROOM.md](../CLEANROOM.md#what-a-spec-must-not-contain).

## Index

| No. | Area | State |
| --- | --- | --- |
| 000 | [Product](000-product.md) | Draft |
| 001 | [Window layout: server rail, place list, conversation, activity panel](001-window-layout.md) | Draft |
| 002 | [Agents: create, face, name, role, edit, archive, main agent, agent files](002-agents.md) | Draft |
| 003 | [Direct chat with one agent: send, stream, stop, attach, reply, threads, context](003-direct-chat.md) | Draft |
| 004 | [Channels: several agents, one job, lead agent, split work, `@all`, fast pick](004-channels.md) | Draft |
| 005 | [Tasks and plan steps: queue, run, wait, finish, fail, retry](005-tasks.md) | Draft |
| 006 | [Providers: connect a model account, choose a model per agent, switch](006-providers.md) | Draft |
| 007 | [Agent workspace and tools: files, shell, browser, approvals, other agents, computer use](007-workspace-and-tools.md) | Draft |
| 008 | [Memory: what an agent keeps between chats, and how the user edits it](008-memory.md) | Draft |
| 009 | [Routines: scheduled jobs, calendar, missed runs](009-routines.md) | Draft |
| 010 | [Workflows: a graph of steps and triggers, with an assistant](010-workflows.md) | Draft |
| 011 | [Phone app: pair with a computer, read and send, notifications](011-phone-app.md) | Draft |
| 012 | [Desktop-to-phone link: messages, identity, offline behaviour](012-desktop-phone-link.md) | Draft |
| 013 | [Settings, themes, languages, decision model and roles](013-settings.md) | Draft |
| 014 | [Local data, privacy, secrets and export](014-local-data.md) | Draft |
| 015 | [Notifications and the status island](015-notifications.md) | Draft |

## Milestones

| Milestone | Specs | Result |
| --- | --- | --- |
| M1 | 000, 001, 002, 003, 006, 013, 014 | Desktop app: agents and direct chat with one API provider |
| M2 | 004, 005 | Channels, split work, tasks page |
| M3 | 007, 008 | Workspace tools, approvals, browser, memory |
| M4 | 009, 010 | Routines and workflows |
| M5 | 011, 012 | Phone app and link |
| M6 | 015 | Notifications and status island |
| M7 | Changes listed in [docs/spec-changes.md](../docs/spec-changes.md) | Slices S18 to S25 |

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
