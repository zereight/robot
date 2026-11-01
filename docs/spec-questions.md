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
