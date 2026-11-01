# Spec questions

Questions from the implementer. Each entry gives the spec, the question, and the choice the
implementer made to continue. A spec author answers by changing the spec.

| Spec | Question | Choice for now |
| --- | --- | --- |
| 006 | M1 says "one API provider". Are agent runtimes (vendor coding programs) part of M1? | Not in M1. Build API providers first; runtimes come in a later slice. |
| 000 | "Medium and semibold weights only": does this include body text, or only emphasis? | Body text uses regular (400). Labels, buttons and headings use medium (500) and semibold (600). No bold. |
| 013 | Devices and Notifications belong to M5 and M6. What shows in M1? | The sections show in the list with one muted line: this part comes in a later version. |
| 013 | What is the default folder for agent workspaces? | `workspaces` inside the data folder, so a copy of the data folder (014) also moves the workspaces. |
| 013 | What are the three text sizes? | Root size 13, 14 and 16 px. All sizes scale from it. |
| 001 | Which place list sections exist, and can the user make new ones? | Two fixed sections: Channels, then Agents. No user sections yet. |
| 001 | What does the add button on the server rail do in M1? No spec describes adding a second computer. | It opens a short dialog: this comes in a later version. |
| 001 | What does the help button open? | A help page with the keyboard shortcuts. |
| 001 | What does the activity panel show for a direct chat? | A muted line "Nothing is running." until tasks exist (M2). |
| 001 | How wide is the rail when the window is 800 px or wider? | 72 px. Under 800 px it is 56 px. |
| 002 | The copy suffix " copy" is interface text. Is it translated? | Yes. English " copy", Korean " 사본". The acceptance test runs in English. |
| 002 | Do archived agents count for the unique-name rule? | Yes, so that restore never makes two agents with one name. The rule ignores case. |
| 002 | How many face shapes are there? | Six drawn characters. Ten hues. A new agent's face comes from its name until the user picks one. |
| 002 | Is there a size limit for an uploaded face picture? | The app crops it to a 256 px square PNG; the stored file must be at most 1 MB. |
| 002 | Where is the "New agent" button? | A plus button on the Agents section header in the place list. |
| 006 | Which models take an effort level? The model lists do not say. | OpenAI: o-series and gpt-5 families. Anthropic: Claude 3.7 and later families (effort sets the thinking budget). Custom: none. |
| 006 | Can the user change the base URL of OpenAI and Anthropic accounts? | Yes. The field starts with the vendor address. This also allows proxies. |
| 006 | What does "Disconnect" leave behind? | The account stays in the list as "Not connected" with "Connect again". "Remove" deletes it and clears it from agents. |
| 006 | What if the model list cannot be fetched? | The picker shows a text field for the model ID. |
| 003 | How long can the queue be, and how long can a message be? | Up to 10 queued messages and 100,000 characters per message. More gives a plain error. |
| 003 | Does Stop also cancel the queue? | No. Stop ends the current turn; the next queued message is then sent. |
| 003 | What does "edit" on the user's last message do? | It saves the new text, removes the replies after it, and asks the agent again. Only when the agent is not working. |
| 003 | Which failed turns can be retried? | Only the last reply, when it failed. Retry replaces the failed row. |
| 003 | "Stored as each part arrives": how often? | The partial reply is written at most every 500 ms and when the turn ends. A turn still marked as streaming at start-up becomes "stopped". |
| 003 | Does Markdown allow raw HTML, and where do links and images go? | Raw HTML shows as plain text. Links open in the system browser (http, https, mailto only). Images load only from https addresses. |
| 003 | Attach (flow 4) and Approve (flow 6) | Attach comes in slice S7. Approve needs agent tools (007), which are not in M1. |
| 003 | What makes a chat unread in the place list? | An agent reply that ends while the chat is not open. Opening the chat clears the count. |
| 000 | Which parts of the window move, and how? | Dialogs and settings fade and rise in (200 ms) and fade out (120 ms). New messages rise in; history does not move. The activity panel slides, sections fold, badges and the working dot pop in, the send and stop icons turn in, hover actions fade. Buttons press in a little. Every motion is under 300 ms; only the "Working…" line loops (003). Reduce motion sets every duration to 0. |
| 003 | How does the quoted message "flash"? | It takes the selected colour at once and fades back after about 1.3 s. Each fade is under 300 ms. |
| 000 | How is the desktop app delivered, signed and updated? | Draft GitHub releases from a version tag, for macOS (arm64, x64), Windows x64 and Linux x64, each tested end to end as a packaged app. Ad-hoc signed on macOS until a Developer ID exists; automatic updates wait for signing. See docs/release.md. |
| 000 | What is the app mark? | A white robot face with an antenna on the accent colour (#4f66d9), flat, in a rounded square. |
| 000 | What does the first start guide show, and can the user leave it? | Three steps in one box: language and theme, one model account, one new agent. Every step can be skipped, and "Skip the guide" ends it at once. Escape and a click outside do not close it. It shows once: a data folder that already has an agent or an account counts as done. |
| 006 | Which numbers does the usage page show, and what about cost? | Finished replies, input tokens and output tokens, per agent and per local day, for the last 7 or 30 days. Stopped and failed replies do not count. No cost is shown: the providers in M1 report tokens only. Plan limits come with agent runtimes, which are not in M1. |
| 003 | How many files, how large, and where do they go? | Up to 10 files per message, 20 MB each. A copy goes to the `attachments` folder of the agent workspace; a taken name gets a number. The model sees the file path in the text. Images are not sent to the model as pictures in M1. |
| 003 | Can a message be only files? | Yes. A message needs text or at least one file. |
| 014 | What does the export archive hold, and what is hidden? | A zip with the database, the attachments per agent, a readme and a format version. Text in chats that looks like a key or token, or equals a stored key, becomes "[redacted]". Attached files are copied as they are. |
| 014 | When can data be imported? | Only into an app with no agents and no accounts, and only from the same data version. Agents join this computer's server. Accounts come back as "Not connected". |
| 005 | Is every chat reply a task? | Yes. Each agent turn in a direct chat is one task with source "chat". The prompt is the last message of the user. |
| 005 | What does Retry do for a chat task? | A failed reply is asked again. A stopped one is sent again as a new message. Either way, the new task links to the old one. |
| 005 | Does a chat turn wait for another task of the same agent? | Yes. One agent runs one task at a time, across chats and channels. The waiting task shows as queued. |
| 005 | How many tasks does the page list? | The newest 500 of the server. Filters and search work on this list. |
| 004 | How does a lead split a job? | The lead gets rules in its system text and answers with one JSON object (plan sentence and up to 8 parts with member, label and prompt). A reply that does not parse, or names no member, is an ordinary answer. The app then shows the plan message, starts the parts at once, and asks the lead for one summary when all parts have ended, also when some failed. |
| 004 | Do parts run at the same time? | Parts of different members run together. Parts of one member wait in its queue (005). |
| 004 | What does the user see when no lead exists and there is no mention? | The job shows with a row of member buttons. The user picks one; that member answers. |
| 004 | What happens with several mentions? | Each mentioned member answers. The lead does not read the job. |
| 004 | Can a lead be removed while it works? | No. A member with an active part or job cannot be removed until it ends or the user stops it. Removing the lead clears the lead. |
| 004 | Where is the channel section button? | A plus button on the Channels section header, like the one for agents. |
| 004 | What does "Stop" do in a channel? | The send button turns into Stop while work runs. It stops every job and part of the channel. A step has its own stop button. |
| 007 | Which tools does an agent have in this version? | Files (list, read, write, search), shell command, web fetch (GET), ask the user, save memory. The browser tool comes later. |
| 007 | Which steps are "risky"? | `sudo`, installing software, sending data over the network, piping into a shell, and deleting outside the workspace. Reading or writing outside the workspace also asks. |
| 007 | Do channels use tools? | Not yet. A tool call in a channel fails with a note. |
| 007 | What happens to a card that waits when the turn stops? | The step is marked Failed and the card goes away. |
| 008 | How does an agent choose which memory items to read? | Items that share words with the message, newest first, at most 20 items and 4000 characters. With fewer than 6 items, all are read. |
| 008 | Where does the user change the permission level and memory? | In the agent profile dialog, with the memory list, search, add, edit and delete. |
| 007 | Where is the browser kept, and who holds the controls? | One window per agent, with its own saved session. The chat header shows "Take control" and "Give back". Steps of the agent wait while the user holds the controls. Stop closes the window at once. |
| 007 | Can agents use tools in channels? | Yes, in replies of members. The lead's plan and summary use no tools. Cards show in the channel. |
| 009 | Which reply counts as the missed run on wake? | The newest due run starts if it is under 12 hours late. Older due runs show as Missed. |
| 009 | Where does a routine post when the place is a channel? | The agent answers the prompt in the channel. The agent must be a member. |
| 009 | Does a paused routine count the pause as missed? | No. Resuming or editing a routine starts its checks from that moment. |
| 010 | What does a prompt in a workflow step see? | `{{input}}` is the joined result of the steps before. `{{trigger}}` is the text that started the run. Without `{{input}}`, the input is added at the end of the prompt. |
| 010 | How does a condition step choose a branch? | It tests whether the input contains a text, ignoring case. Yes and No are separate outputs. A step with no active input is Skipped. |
| 010 | What do the "post message" and "approval" steps do? | Post puts a note in a channel. Approval waits for the user to approve or reject in the editor. Reject fails the run. |
| 010 | Which agent chat shows the prompt of a workflow step? | The chat of that agent, as a message. The task has the source Workflow. |
| 015 | When does a system notification show? | Only while no window of the app has the focus. The do-not-disturb of the system is respected by the system. |
| 015 | What is a "mention in a channel"? | A finished reply of an agent that holds `@you` or `@user` as a word. |
| 015 | Which place does a failed task open? | The channel for a channel task, otherwise the agent chat. A routine failure counts as "routine failed". |
| 015 | What is the default of the island, and where is it set? | "Always", on macOS only, in Settings > Notifications. Other choices: only for attention, off. |
| 015 | What shows on the island for a question? | The question and "Open app". Only approvals have Allow and Deny on the island. |
| 015 | How is a mute chosen? | One select per server and per channel in Settings > Notifications: not muted, 1 hour, 8 hours, 1 day, until turned back on. |
