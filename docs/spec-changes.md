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
| 003 | A message sent while the agent works waits in a queue until the turn ends. | By default it joins the running turn and the agent reads it at the next step. A message answers a waiting question card. The queue stays as a setting, with "Send now". |
| 007 | Allow rules and permission levels decide every step the same way in every turn. | A turn that holds outside content asks before guarded steps (own settings, memory, secrets), also when an Allow rule matches, except at "Full access". |
| 009 | A routine has a schedule and uses the model of its agent. | A routine has a schedule or a watch. It can have its own model and effort. A late run gets the planned time and the start time. |
| 002, 010 | Import lists what it will make, and the user confirms. | A review screen with tick boxes, routines not ticked, "Not imported", and a checklist after the import (014). |
| 015 | The island shows faces and a count while agents work, and the first waiting request. | A detail card with one row for each working agent (place, what it does, time). The attention card shows the place and the kind of step, and the user can go through all waiting requests ("1 of N"). In the mode "always", a result card shows when a reply ends or a task or routine fails. |
| 005, 007, 013 | Nothing limits a chain of agent messages, the steps of a task, or repeated reads. | A message chain stops at depth 8. A task stops at 300 steps by default (a setting from 20 to 2000). The third read with the same target and the same result is refused. |
| 005, 003, 004 | Retry starts a new task at once. | Retry shows a note first when the earlier try ran steps that may have changed things. |
| 006 | A runtime shows as found or not found, and signed in or not. | Five states: Checking, Ready, Needs sign-in, Needs repair, Not installed. "Check again" changes nothing. "Repair" is the only action that changes the program. |
| 007 | Three permission levels. Full access needs no confirm. | A fourth level, "Read only", the strictest. Full access asks for a confirm. The action log says whether a file step read or wrote. |
| 004, 005 | A part ends as done, failed or cancelled. | A channel can ask for review. A part is then in review until the user accepts it or asks for changes. |
| 005, 009 | A turn that ends with no error is done. | A task from a part, a message of another agent, a routine or a workflow ends as Blocked when the agent says it could not do the work. A blocked run counts as failed for the pause of a routine. |
| 001, 003, 007, 008 | Search looks at place names only. An agent cannot search its past chats. | The search field also lists matching messages, and a click opens the message. An agent has the tool "search chats" while its memory is on. |
| 003, 005 | A failed row tells the reason, and the retry note. After a restart the notice has "Continue" only. | A failed row also tells how far the turn went (not sent, sent, started). If the request never reached the model, the notice has "Send again" in place of "Continue". |
| 005, 013 | A turn that shows nothing runs without end. | A turn with no sign of life for 10 minutes (the user can change this) is stopped and fails. A wait for the user and a running tool step do not count. The failed row also tells how far the turn went, next to the retry note. |
| 006 | A vendor program from a crashed run can stay. | The app ends its own leftover programs at start. A runtime with a hung check never delays a turn of another provider. |
| 008 | The agent saves memory at once. The only undo is the chat line. The agent can save any text. | A choice for each agent: save at once, or ask first with a tab for proposals. A history tab with undo. The memory tool refuses a text that looks like a secret. |
| 001, 021 | Pages: agents and chats, workflows, tasks, usage. | Also the Today page, with a badge on its button for the items that wait in "Needs you". |
| 000, 008, 016 | The texts say that an agent "learns". | One rule: ROBot does not train or change a model. An agent gets better through its instructions, memory, knowledge and the skills that the user saves. The memory page and the knowledge page show one muted line with this fact. |
| 004, 005 | A part has a label. The check of the lead nudges, asks or does nothing. The summary names blocked parts. | A part can have a done test. In the check the lead gives a verdict, "Met" or "Not met", to each part that ended as Done and that the user did not decide on. "Not met" can lead to a nudge. The summary also names a part that stays "Not met". The verdict is a field, not a state. |
| 005, 019 | The task view shows the prompt, the steps, the messages, the child tasks and the three times. | It also shows the done test and the verdict of a part, and a list of moments (given, started, ended, decided, judged, closed). The fields sync. |
| 002 | The agent profile lists no work. | The profile has a block "Recent work" with the last 20 tasks, their state in words, and the time since the last change. |
| 002, 009, 017 | Three templates: general assistant, code reviewer, researcher. | Five starters: Assistant, Briefer, Researcher, Reviewer, Organizer. A starter can also make a paused routine and skills for the new agent. |

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
| S35 | Limits of a task: message chain depth, step limit and its setting, refusal of repeated reads. The retry note in chat, channel and Tasks page, with the read or write mark of file steps in the action log that the note reads. | 005, 007, 003, 004, 013, 019 |
| S36 | Runtime states with "Check again" and "Repair", and the disabled message box. The level "Read only", the confirm for "Full access", the line under the level. | 006, 007, 003, 012, 019 |
| S37 | Review of parts and the state Blocked: the channel setting, the eye and stop sign icons, the actions on the part and on the Tasks page, labels in routines, workflows and notices. Also the action log entries (result Refused) for steps that "Read only" refuses. Needs S35 and S36. | 004, 005, 009, 010, 012, 015, 019 |
| S38 | Messages during a turn: the setting, "Read at the next step", Delete before it is read, a message that answers a question card, the queue with "Send now", the queue for runtimes that take no input during a turn, the message in the task detail. | 003, 005, 013 |
| S39 | Outside content: the mark of a turn, the guarded steps, the card with "This turn holds outside content" and no "Always allow", turns that the user did not start, the log entries. The guard of memory saves. | 007, 008 |
| S40 | Changes from the chat: the settings tool for the agent and for the app settings, loose model names, the line with Undo, the fields the agent cannot change, instruction history with restore, export and sync of the history. Needs S39. | 002, 007, 013, 014, 019 |
| S41 | Saved secrets: the three tools, the protected card, the origin check, no redirects, the switch for local addresses, limits, redaction of the answer, the Saved secrets part of settings, the rules for requests, export without values. Needs S39. | 020, 007, 013, 014, 015 |
| S42 | Task times: wait, first reply and total, the task detail, the median on the usage page. The performance command and report of `docs/performance.md`, and the size check in CI. | 005, 006 |
| S43 | Watch routines: the trigger form with the confirm, the three kinds of watch, checks and the change text, "Post when nothing changed", failed checks, the model and effort of a routine, the times of a late run. Needs S39. | 009, 007, 014 |
| S44 | Review before an import: the review screen for agent files and workflow files, ticks at the start, "Not imported", the checklist after the import. | 014, 002, 010 |
| S45 | Teach a task: the form, the recording bar, the steps and the hidden secrets, the limits, the draft skill card, Save and "Try it". | 017, 007, 014 |
| S46 | Message search: the group "Messages" under the search field, the hit row, the jump to the message, search on a linked server and in the cache, the tool "search chats" for agents with memory on. | 001, 007, 012, 011, 014 |
| S47 | Silent and cut turns: the progress of a turn, the lines on a failed row, "Send again" in the restart notice, the silent limit and its setting, leftover programs ended at start. Follows S35: the line for the progress sits next to its retry note. | 005, 003, 006, 013, 019, 011 |
| S48 | Today page: the page button and badge, the four groups, live update, the line for a group that cannot be read, the line on a linked server. | 021, 001, 012, 015 |
| S49 | Memory control: the choice "save at once" or "ask me first", the tabs Items, Proposals and History, undo, the refusal of secrets, the limits, what syncs and what exports. | 008, 012, 014, 019 |
| S50 | Honest wording: the rule that ROBot does not train a model, the muted line on the memory page (under the title, above "Memory saving" and the tabs) and on the knowledge page, "learns" removed from the texts of 008 and 016, and the same fact in the README. No data change. | 000, 008, 016 |
| S51 | Verdicts in the check: the done test in the plan, the check of the lead (nudge, ask, nothing, the limit of 3 looks), the verdict "Met" or "Not met", the summary that waits for a nudge, the fields in the task view, and their sync. The check is not built yet. S51 builds only the check of S19. `@all`, the fast pick, the line "waits behind" and the archive of a channel stay in S19. | 004, 005, 019, 000 |
| S52 | Work record: the list of moments in the task view, and the block "Recent work" in the agent profile with its words for what a task waits for. Needs S51 for the moment "Judged". | 005, 002 |
| S53 | Starters: five starters with their own English and Korean text, the paused routine and the skills that a starter makes, the note in the chat when a part is not made, and the rule for a linked device. The limit of 50 routines is not built (S29): a starter checks it by itself, and the refusal in the form stays in S29. Skills are built (S31). | 002, 009, 017 |

S18 first: it is the largest gain for channels. S20 needs threads before fork can work. S32 needs S30. S37 needs S35. S40, S41 and S43 need S39.
S46 to S49 do not depend on each other, except that S47 follows S35. S46 and S47 give the largest gain for the effort. A slice that adds a data step takes the next free number at the time it merges.
S50 needs no code change in the app besides text, and can go first. S52 follows S51. S53 does not depend on S50 to S52.

## Decided against

- The app writes an agent setup from a text that describes a job, and the user then reviews it and
  presses a "Hire" button. Decided against on 2026-11-02. A starter (S53) is the way to begin a
  job. The words "agent", "member" and "New agent" stay in the interface.
- A new state for the review of the lead. The state "in review" belongs to the review of the user
  (S37). The lead gives a verdict, which is a field. So a restart, a stop, or a blocked lead needs
  no rule for a part that waits for the lead.
- A coaching card, with which an agent proposes a change of its own instructions after the user
  corrects it, is not in this list. It is open for a later change.
