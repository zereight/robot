# Behaviour specs

Each spec describes one area of ROBot from the user's side. Implementers build from these files
only. Follow the limits in [CLEANROOM.md](../CLEANROOM.md#what-a-spec-must-not-contain).

## Index

| No. | Area | State |
| --- | --- | --- |
| 000 | [Product](000-product.md) | Draft |
| 001 | Window layout: server rail, place list, conversation, activity panel | To write |
| 002 | Agents: create, face, name, role, edit, archive | To write |
| 003 | Direct chat with one agent: send, stream, stop, attach, reply | To write |
| 004 | Channels: several agents, one job, lead agent, split work | To write |
| 005 | Tasks and plan steps: queue, run, wait, finish, fail, retry | To write |
| 006 | Providers: connect a model account, choose a model per agent, switch | To write |
| 007 | Agent workspace and tools: files, shell, browser, approvals | To write |
| 008 | Memory: what an agent keeps between chats, and how the user edits it | To write |
| 009 | Routines: scheduled jobs, calendar, missed runs | To write |
| 010 | Workflows: a graph of steps and triggers | To write |
| 011 | Phone app: pair with a computer, read and send, notifications | To write |
| 012 | Desktop-to-phone link: messages, identity, offline behaviour | To write |
| 013 | Settings, themes and languages (English, Korean) | To write |
| 014 | Local data, privacy, secrets and export | To write |
| 015 | Notifications and the status island | To write |

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
