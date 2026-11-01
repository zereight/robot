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
