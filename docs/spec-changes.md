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

S18 first: it is the largest gain for channels. S20 needs threads before fork can work.
