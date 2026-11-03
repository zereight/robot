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
| 002, 017 | Deleting an agent leaves a skill that was only for it. It is listed nowhere and counts in the limit of 100. | The delete removes the agent from the list of every skill. A skill that was only for it is deleted, and the confirm text says how many. |
| 000, 001, 011, 012, 015 | The desktop app is built for macOS, Windows and Linux. Search opens with Cmd or Ctrl+K. | The desktop app is for Macs with Apple silicon only. Search opens with Cmd+K. The phone app is for iOS and Android. A phone with no such Mac cannot be used. |
| 012, 010 | A computer client cannot open the workflows of a linked server. | It sees the workflows and their runs, runs and stops them, and answers approval steps. With the switch "Can create and change agents" it also edits them. The assistant and the workflow file stay on the server. |
| 000, 001, 011, 012, 013, 014, 015, 019 | One computer holds one set of data, and it is one server. | A computer can hold up to 5 profiles. A profile has its own data, accounts, settings, linked devices and sync pair, and it is the server that a phone pairs with. The window shows one profile. The rail has a profile button when there are 2 or more. A profile that is not open keeps working, and makes no notice on the computer. The first profile is the data that exists today. |
| 003, 004, 005, 012, 015 | A quiet turn shows "Working…" until the silent limit stops it. | After 90 seconds with no sign of life (or half the silent limit, when shorter), every place that shows the turn reads "No answer from <name> for <time>". The turn goes on. |
| 007, 013, 014 | Four permission levels. | A fifth level, "Ask when unsure", between "Ask for risky steps" and "Full access". The decision model checks risky steps against the words of the user. Hard steps always ask. |
| 018 | Every call of a tool of a connection is risky. | With the switch "Trust read-only marks" of a connection, a tool that the connection marks as read only runs with no card at "Ask for risky steps" and "Ask when unsure". |
| 005, 009 | Usage shows per agent and day only. | Each task keeps its tokens. The task view shows the total of a tree with a line for each agent. A routine can have a token limit for each run. |
| 008 | An agent saves facts only in its turns. Its memory is the same in every place. | A memory check can suggest facts after every 10 done turns. A channel note is read only in its channel. |
| 002, 004, 013 | Each agent has only its own instructions. | A handbook for every agent of a server, and instructions for each channel. |
| 002, 014, 017 | An agent file holds agents and routines. | It can also hold channels, skills (made off) and the handbook (not ticked on import). |
| 023, 000, 005, 013, 014 | No program on the computer can talk to ROBot. | An outside program that the user adds can read, send work, wait and stop through a helper over MCP. It cannot answer approvals or change anything else. |

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
| S53 | Starters: five starters with their own English and Korean text, the paused routine and the skills that a starter makes, the note in the chat when a part is not made, and the rule for a linked device. The limit of 50 routines is not built (S29): a starter checks it by itself, and the refusal in the form stays in S29. The storage of skills exists (it came with S45), but the Skills page and the command list are S31 and are not built. So the skills of a starter are made and counted, and the user cannot call them until S31 lands. | 002, 009, 017 |
| S54 | Skills go with their only agent: the confirm text of the delete names the count, the agent leaves the list of every skill, and a skill that was only for it is deleted. It covers skills of starters and of "Teach a task". Archive changes nothing. | 002, 017 |
| S55 | Apple silicon only: packaging, the release workflow, CI, the README and `docs/release.md` list the macOS arm64 build only. The build for Intel Macs (x64) and its runner go. The code paths, tests and texts for Windows, Linux and Intel go (program search, path rules, key storage, the Ctrl key for search, the platform test for the island). The rows of `docs/spec-questions.md` for the delivery of the app (000) and for the default of the island (015) lose "x64", "Windows", "Linux" and "on macOS only". The end-to-end suite runs on an Apple silicon runner, so the CI jobs for it need one. The phone app (M5b) is for iOS and Android. It is not built yet, and this slice adds none of it. | 000, 001, 011, 012, 015 |
| S56 | Workflows on a linked computer: the Workflows page of a linked server, the list, canvas, run history, run details and live run state, run and stop, approval steps, "Started by <device name>", changes with the switch only, read-only canvas and "Not allowed" without it, the muted line for the assistant and the workflow file, "Runs on <name>" through sync, the offline line, the new messages and pushes. | 012, 010, 019 |
| S57 | Profiles on one computer: the first profile made from the data that exists today, with a phone that stays paired. The profile button and menu, the switch of the whole window, Settings → Profiles (add, rename, face, delete with the typed name, the limit of 5, the muted line), and data, keys, logs and the default folder for workspaces apart for each profile. Export and import for one profile. The delete moves the workspace folders to the system trash, so check where the default folder lies now before the delete removes data. | 022, 000, 001, 013, 014 |
| S58 | Profiles with linked devices and sync: every profile runs while the app runs, with its own device identity, name, switch, pairing code and device list. A phone or computer sees one profile only. The refusal to link two profiles of one computer. A sync pair of two profiles. No notice, sound or island card on the computer for a profile that is not open, and the dot in the menu. Needs S56. A link that exists before this slice must still work. | 022, 011, 012, 015, 019 |
| S59 | Quiet line: the quiet time, the line "No answer from <name> for <time>" in the chat, the plan step, the Tasks page row, the island detail card, and on the phone and a linked device. No notification. The line goes at the next sign of life. Needs S47 for the clock of the silent limit. | 005, 003, 004, 015, 011, 012 |
| S60 | Phone performance: the setup, the measures, the traces and the "before" and "after" reports of the phone app in `docs/performance.md`, with the compare command. No change to the app. | 011 |
| S61 | Usage of a task: tokens and cost of each task, the total of a tree with the line of each agent, the cached share, the total on the card of the lead, the run details, and the token limit of a routine with its 80 percent line and its failure. | 005, 009, 019, 011, 012 |
| S62 | Ask when unsure: the level and its place in the picker, hard and checked steps, the steps that never go to the check (outside content, no words of the user, a command over 500 characters, a workflow step), the request to the decision model and what it never holds, the data folder of ROBot as a risky step, the 3-second limit, "Allowed by the check" and "The check was not sure", the switch "Permission checks", the fall back to "Ask for risky steps", the log entries. Needs S18, S30 and S39. | 007, 013, 014, 012 |
| S63 | Read-only marks: the mark in the tool list, the switch "Trust read-only marks", the tool card text, the levels where the mark counts, and the call that is risky again in a turn that holds outside content. Needs S32 and S39. | 018, 007 |
| S64 | Memory check: the choice, the count, the task with the source "memory check", what it reads, the one tool, at most 5 proposals, "Check now", the muted line for a vendor runtime that cannot use it. Needs S49. | 008, 005, 012, 019 |
| S65 | Channel notes: the channel of an item, what a turn reads, the filter and the move, "Not a member", the delete of a channel. Needs S49. | 008, 004, 014, 019 |
| S66 | Handbook and channel instructions: the settings page with the history and restore, the switch "Read the handbook", the order of the texts, the refusal of secrets, the channel field, what a linked device can change. | 002, 004, 013, 012, 019, 014 |
| S67 | Team file: the three tick boxes of the export, channels, skills and the handbook in the file, their limits, the review screen and the import rules. Update `docs/agent-file-format.md` to version 2, and keep reading version 1. Needs S44 and S66. | 002, 014, 017 |
| S68 | Outside programs: the settings part, entries and keys, the helper, the tools for "Read" and "Read and send work", the mark "Sent by", a message that never joins a running turn, outside content from the start, changes of settings that ask at every level, the limits, the log, the profile of an entry. Needs S39. | 023, 000, 005, 013, 014 |

S18 first: it is the largest gain for channels. S20 needs threads before fork can work. S32 needs S30. S37 needs S35. S40, S41 and S43 need S39.
S46 to S49 do not depend on each other, except that S47 follows S35. S46 and S47 give the largest gain for the effort. A slice that adds a data step takes the next free number at the time it merges.
S50 needs no code change in the app besides text, and can go first. S52 follows S51. S53 does not depend on S50 to S52. S54 follows S53.
S57 does not depend on S55, but both change the same packaging and data code, so do S55 first when both are open. S58 needs S57.
S55 does not depend on the other slices. It removes code, so it goes best when no other slice is open on the same files.
S59 follows S47. S60 does not depend on the other slices.
S61 to S68 do not depend on each other, except as listed. S66 and S61 give the largest gain for the effort.

## Decided against

- Temporary helpers: an agent that gives parts of a request to short-lived helpers and joins their
  results. Decided against on 2026-11-03. Vendor programs already start their own helpers (015,
  "another agent"), and a channel with a lead splits a job between agents that the user can see.
  Open for a later change if agents that use the tools of the app need it.
- A password, a PIN or a lock for a profile. Not in the first version (022). A profile keeps work
  apart and does not lock anyone out; a separate user account of the system is the wall. Open for
  a later change.
- A rule that computer use (007) never looks at a window of ROBot. Open: with profiles, an agent of
  one profile with computer use can look at the window that shows another profile. 022 says this
  in "What is shared". 007 may need a rule later.
- The app writes an agent setup from a text that describes a job, and the user then reviews it and
  presses a "Hire" button. Decided against on 2026-11-02. A starter (S53) is the way to begin a
  job. The words "agent", "member" and "New agent" stay in the interface.
- A new state for the review of the lead. The state "in review" belongs to the review of the user
  (S37). The lead gives a verdict, which is a field. So a restart, a stop, or a blocked lead needs
  no rule for a part that waits for the lead.
- A coaching card, with which an agent proposes a change of its own instructions after the user
  corrects it, is not in this list. It is open for a later change.
