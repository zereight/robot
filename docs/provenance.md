# Provenance log

One line per merged change: date, pull request, role, and the specs it implements.

| Date | Change | Role | Specs |
| --- | --- | --- | --- |
| 2026-11-01 | Repository start: rules and spec index | Spec author | 000 |
| 2026-11-01 | Project skeleton: Bun workspace, Electron + SolidJS, lint, typecheck, CI, smoke e2e | Implementer | — |
| 2026-11-01 | S1: local database, settings page, English and Korean catalogues, themes | Implementer | 013, 014 |
| 2026-11-01 | S2: window layout: server rail, page buttons, place list, conversation area, activity panel | Implementer | 001 |
| 2026-11-01 | S3: agents: create, templates, faces, edit, duplicate, archive, restore, delete | Implementer | 002, 003 (empty state) |
| 2026-11-01 | S4: model accounts: connect with a key check, keychain storage, model and effort per agent, disconnect | Implementer | 006 |
| 2026-11-01 | S5: direct chat: streaming replies, stop, queue, reply jump, edit, retry, Markdown, unread counts | Implementer | 003 |
| 2026-11-01 | Motion: enter and exit for dialogs, settings, panel, sections, messages and controls; all under 300 ms and off with reduce motion | Implementer | 000, 003, 013 |
| 2026-11-01 | Release: packaging for macOS, Windows and Linux, packaged-app e2e, tag-driven draft releases, app icon | Implementer | 000 |
| 2026-11-01 | Release 0.1.0-alpha.1: first draft pre-release through the release workflow | Implementer | 000 |
| 2026-11-01 | E2E screenshots show motion at its end; motion frames keep their moment | Implementer | 000 |
| 2026-11-01 | README: features, download, data folders, development, architecture, testing, release, roadmap, screenshots | Implementer | 000, 001, 002, 003, 006, 013, 014 |
| 2026-11-01 | S6: first start guide (language, theme, model account, first agent) and usage page (replies and tokens per agent and day) | Implementer | 000, 006 |
| 2026-11-01 | S7: file attachments, export and import of local data, hiding of secrets in logs and exports | Implementer | 003, 014 |
| 2026-11-01 | S8: tasks: one task per agent turn, one task at a time per agent, stop, retry, restart rule, tasks page | Implementer | 005, 003 |
| 2026-11-01 | S9: channels: create and edit, lead, @mentions, split jobs into parts, chips, summary, Now panel with plan steps, stop all | Implementer | 004, 005 |
| 2026-11-01 | S10: agent tools (files, shell, search, fetch, ask), permission levels, approval and question cards, memory | Implementer | 003, 007, 008 |
| 2026-11-01 | S11: browser tool, one window per agent, take control and give back, Stop closes it | Implementer | 007 |
| 2026-11-01 | S12: tools in channel replies, with approval and question cards | Implementer | 004, 007 |
| 2026-11-01 | S13: routines: schedules, missed and skipped runs, run now, calendar | Implementer | 009, 005 |
| 2026-11-01 | S14: workflows: canvas editor, run engine, triggers, approvals, run history | Implementer | 010, 005 |
| 2026-11-01 | S15: system notifications by kind, mutes, status island with Allow on approvals, click opens the message | Implementer | 015, 007 |
| 2026-11-02 | Fix: workflows page keeps the same inner padding as the other pages | Implementer | — |
| 2026-11-02 | S17: subscription accounts: Claude Code and Codex run as the vendor's own program with the user's own sign-in; find, download with checksum, sign in, plan limits, approval cards | Implementer | 006, 007, 013, 014 |
| 2026-11-02 | S17: Muse Code and pi added as runtimes. Written from the output of `muse` and `pi` (`--help`, `usage --json`, `exec --json`, `--mode json`, `--list-models`) as run on the machine, and the public package page of pi (MIT). No code of other apps was read | Implementer | 006, 007 |
| 2026-11-02 | Approval and question cards stay after an app restart; the task waits and goes on after the answer | Spec author | 005, 007, 003, 010, 015 |
| 2026-11-02 | Device link: computers link to each other as servers, a phone pairs with several computers, reach from other networks through the user's VPN and no relay; spec 012 renamed and widened | Spec author | 012, 000, 001, 011, 013, 014, 015 |
| 2026-11-02 | S18: device link: identity and name, "Let other devices connect", pairing screen with QR code and 6-digit code, "Connect to a computer", "Allow <name>?", encrypted link between computers, Settings > Devices. The crypto follows the public RFC 9382 (SPAKE2) and the Noise specification and is checked against their published test vectors. No code of other apps was read | Implementer | 012, 013, 014, 015 |
| 2026-11-02 | S19: linked server in the window: tile states, places, messages, live updates, send, stop, edit, retry, reply, files up and down, read state on the server, “from <device name>”, client cache and offline view, muted lines for what a client cannot do | Implementer | 012, 001, 003, 004, 014 |
| 2026-11-02 | S20: linked server approvals and questions answered from a client (“Allowed by / Denied by <device name>”), tasks list, details and stop, notices of a linked server by the settings of this computer, nearby computers while a code is valid | Implementer | 012, 015, 003, 007 |
| 2026-11-02 | Device link: spec now states the choices made in S18 to S20 (no "Always allow" on a client, cache size, removed-device text, mute row, island scope) and allows common acronyms in Korean screens | Spec author | 012, 013, 015 |
| 2026-11-02 | Fix: s1 e2e allows "VPN" and cuts out "Tailscale" in Korean screens, as spec 013 now allows | Implementer | 013 |
| 2026-11-02 | Sync between two computers: new spec 016; small rules in 000, 002, 005, 009, 010, 012, 013, 014, 015 | Spec author | 016, 000, 002, 005, 009, 010, 012, 013, 014, 015 |
| 2026-11-02 | S21: sync between two computers, first part: change records with stable ids and deletions, turn on (merge, use theirs, send mine) with the Allow question, backups, copy in batches with Pause, Resume and restart, name and account matching, Stop, notices of Deny and Stop | Implementer | 016, 000, 002, 005, 009, 010, 012, 013, 014, 015 |
| 2026-11-02 | S22: live sync between two computers: changes within seconds, streaming replies on both, newest change per field wins, no lost memory text, unique names, read state, “from <device name>”, change list, clock warning, delete on the other computer with the folder kept, ask before 5 or more deletions | Implementer | 016, 002, 003, 004, 008, 012, 013 |
| 2026-11-02 | S23: sync of tasks, routines, workflows, files and notices: origin of tasks, stop and answers go to the origin, one task per agent across both computers, "Runs on" and "Run on this computer", channel trigger on the computer where a workflow runs, files copied from the origin, notices of cards of the other computer | Implementer | 016, 005, 009, 010, 012, 015 |
| 2026-11-02 | Device link: a linked computer can create and change agents, channels and memory of a server when the server allows it per device; no folders, no looser permission levels | Spec author | 012, 001, 002, 007, 013 |
| 2026-11-02 | Sync: choices after review of S21 to S23 (only the running computer chooses where a routine runs, age of a message uses the measured clock difference, sync gives the switch of 012, the Allow text names deletes and approvals, no lock between computers) | Spec author | 016, 012 |
| 2026-11-02 | F1: fixes after review of S21 to S23: type errors in the shared tests; the app ends when it quits, also while a card waits and two computers sync (the close waits for the services, the database takes no more writes, a late message on a stopped connection is dropped); a task that waits for an approval or a question waits on after a restart (spec 005, 007); only the computer that runs a routine or workflow chooses where it runs; the age of a message uses the measured clock difference | Implementer | 005, 007, 016 |
| 2026-11-02 | S24a: server side of create and change agents from a linked device: the switch for each device (Allow dialog, Settings → Devices, at once on open connections, locked on while the computers sync), requests with a strict schema and checks (no folder field, stricter level only, known model only, names, working agent), the record "Last changed by", the folder path kept from clients | Implementer | 001, 002, 004, 007, 008, 012, 013, 016 |
| 2026-11-02 | S24b: client side of create and change agents on a linked computer: the plus buttons, the agent profile (editable with the switch, text only without), the model picker from the server, the channel settings, the memory list, "Workspace: on <server name>", "Last changed by", and the error line that names the server | Implementer | 001, 002, 004, 007, 008, 012 |
