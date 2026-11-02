# Spec changes after S17

This list helps an implementer find what the specs now ask for and the code does not yet do. The
specs are the source. This list only groups the work into slices. Open one pull request for each
slice, with an end-to-end test.

## Behaviour that changes

These are in the code today and the specs now say something else.

| Spec | Before | Now |
| --- | --- | --- |
| 002 | A duplicate is named "Name copy". | A duplicate gets a random name and keeps the browser session. |
| 003 | The working line reads "Working…". | It reads "Working…" or a playful phrase, and names a routine for a routine run. |
| 004 | Without a mention, the lead gets the job. | The order is `@all`, mentions, fast pick, lead, user pick. |
| 010 | A condition tests for a text only. | A condition can also ask a model. A model step exists. |
| 001, 002, 004 | The place list has two fixed sections, Channels and Agents. | The user can make sections inside each of them, move places into them, and order and delete them. A collapsed header shows the unread sum. |
| 010, 015 | Step kinds are agent, condition, approval and post. | A notify step and canvas notes exist. Workflows can be written to a file and read from a file. |
| 014 | Crash reports may be on. | The app sends no usage events and no failure reports. |
| 000, 014 | No conversation content leaves the computer except to model providers and pages. | One more exception: the decision model, off by default. |
| 000, 014 | The exceptions are the model providers, the pages and the decision model. | One more exception: connections that the user adds on purpose (018). They get data only when an agent calls one of their tools. |
| 007 | "Always allow for this agent" keeps a step allowed. The spec names no place to see or undo it. | It saves a rule. The user sees the rules, adds Allow and Deny rules, and deletes them. A Deny rule wins at every permission level. |
| 007 | No record of what the tools did. | An action log of file, shell, web and connection steps, kept for 90 days and at most 100000 entries. |
| 009 | No limit on routines, and a routine that fails keeps running. | At most 50 routines. A note for a schedule under 15 minutes. A routine pauses after 3 failed runs in a row. |
| 003 | The command list shows commands and runtime skills. | It also shows the skills that the user saved (017). A message can hold a skill chip. |
| 015 | The island shows faces and a count while agents work, and the first waiting request. | A detail card with one row for each working agent (place, what it does, time). The attention card shows the place and the kind of step, and the user can go through all waiting requests ("1 of N"). In the mode "always", a result card shows when a reply ends or a task or routine fails. |

## Slices

| Slice | Content | Specs |
| --- | --- | --- |
| S18 | Decision model: settings section, keys, test, local server, log line. Fast pick in channels. | 013, 004, 014 |
| S19 | Channels: `@all`, lead check, "End the request", waits-behind line, archive a channel, summary fallback, no stuck "working". | 004, 005, 009 |
| S20 | Chat: threads and fork, command list, context meter and compact, restart notice, scroll rules, long chats, working lines, "Mark as read" menu, no separate "needs you" group. | 003, 001 |
| S21 | Agents: random name button, duplicate rule, role list and Roles page, main agent, agent file export and import, tools to list and message agents. | 002, 013, 007 |
| S22 | Workflows: assistant panel and tools, versions, node numbers, step effort, model step, retries, failure reasons. | 010, 007 |
| S23 | Computer use and its fast path. | 007, 013 |
| S24 | Providers and logs: environment variables for Claude Code, Pi-Bolt, logs folder row, channel, browser and workflow logs, browser tab refresh and takeover card rules. | 006, 013, 014, 007 |
| S25 | Phone: same as the computer, "Needs you" list, workflows. | 011, 012 |
| S27 | Workflow file: notify step, canvas notes, export and import of workflows. It takes from S22 only the parts that the file needs: the condition mode "Ask a model" with its retry rule, and the effort of an agent step. The rest of S22 stays open. | 010, 015 |
| S28 | User sections: make, rename, order and delete sections inside Channels and Agents, move a place by menu or by drag, the "Section" choice in the forms, the unread badge and working dot on a collapsed header, the same sections on the phone (read only there). | 001, 002, 004, 011, 012 |
| S29 | Routine limits: 50 routines, the runs-per-day note, pause after 3 failed runs in a row, the paused text, the one notification. | 009 |
| S30 | Permission rules and action log: saved Allow and Deny rules, the decision order, the Permissions page with rules and log, 90-day clean-up. | 007, 013, 014 |
| S31 | Skills: the Skills page, the chip in the message box, the copy stored with the message, the command list order. | 017, 003, 013, 014 |
| S32 | Connections: the Connections page, test, tool cards, risky-step rule, rules for connection tools, time and size limits, import turns them off. Needs S30. | 018, 007, 013, 014, 000 |
| S33 | Status island detail: the detail card of working agents, the richer attention card with "1 of N", the result card in the mode "always". | 015 |
| S34 | Waiting tasks survive a restart: a task with no parent that waits for an approval or a question still waits after the app starts again, its card shows again, the island and the notification ask once, and Allow lets it go on. Other work that was running or queued is still marked failed with the restart reason. | 005, 007, 015 |

S18 first: it is the largest gain for channels. S20 needs threads before fork can work. S32 needs S30.
