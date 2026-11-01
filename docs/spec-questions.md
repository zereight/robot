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
