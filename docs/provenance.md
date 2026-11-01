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
| 2026-11-02 | Random name suggestion in the new agent form | Implementer | 002 |
