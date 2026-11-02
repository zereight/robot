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
| 2026-11-02 | Fix: channel start text keeps the same side padding as the messages | Implementer | — |
| 2026-11-02 | Missing features: decision model and fast pick, `@all`, lead check, end a request, waits-behind line, threads and fork, command list, context meter, restart notice, roles, main agent, agent files, agent messaging, workflow assistant, step effort, computer use, Claude variables, logs, phone parity; list of slices in `docs/spec-changes.md` | Spec author | 000, 001, 002, 003, 004, 005, 006, 007, 009, 010, 011, 012, 013, 014 |
| 2026-11-02 | Fix: pi models offer the effort levels that pi tells for each model. Written from the output of `pi --help` and the RPC commands in the public pi documentation, as run on the machine. No code of other apps was read | Implementer | 006 |
| 2026-11-02 | Spec 016: agent knowledge: linked articles an agent writes, cites and reads again, with sources, a change list, protection of the user's edits and a check; a source that holds a stored key is refused | Spec author | 016, 014 |
| 2026-11-02 | S26: agent knowledge: articles and sources as files in the workspace, change list with undo (an undo is a new change), agent tools, contents list, protection of the user's edits, Knowledge page, check, export. Follow-up to the changed 016 and 014: a source that holds a stored key is refused, the chosen-workspace rule follows Settings, the first-save card has no Always allow, Open folder waits for the first article, file tools stay out of sources and the folder, the check message, the contents list limits, files of other apps, and a rebuild of the database copy in the export | Implementer | 016, 014, 007, 008 |
| 2026-11-02 | D1: design foundation: neutral palette, one text scale, one radius scale, one strong curve, one press scale, quiet bot tag, rounded hover on messages, thin scrollbars, composer without a stray scrollbar | Implementer | 000, 001, 003, 013 |
| 2026-11-02 | D2: sliding thumb for choice controls, template chips as buttons with press feedback, place list edge resists past its limits and springs back | Implementer | 001, 013 |
| 2026-11-02 | D3: agent faces react once when a reply ends, fails or asks, and land when new; new face shapes come in softly in the form; first start steps move in from the side | Implementer | 000, 002, 003 |
| 2026-11-02 | D4: activity panel of a direct chat shows the running tasks of the agent with time and stop; plan steps and member cards of a channel come in one after the other, status icons change with motion, the done check is drawn on | Implementer | 001, 004, 005 |
| 2026-11-02 | Channels: search in the member list of the channel form (name or role line), the choice stays when a search hides a member, count of chosen members | Implementer | 004 |
| 2026-11-02 | Fix: name suggestions are English first names in every interface language, from a list of at least 80 | Implementer | 002 |
| 2026-11-02 | Fix: Claude models take all five effort levels, up to extra high and max. An API account reads the levels of each model from the model list and sends the level as the effort setting, with adaptive thinking, and not as a thinking budget; Claude Code models show their version. Written from the public Anthropic documentation (effort, thinking, models list, Claude Code model configuration) and the output of `claude --help`. No code of other apps was read | Implementer | 006 |
| 2026-11-02 | Fix: a Muse Code account whose usage data is not sent yet still reads as signed in. Written from the output of `muse usage --json` as run on the machine, for a signed-in and a signed-out account. No code of other apps was read | Implementer | 006 |
| 2026-11-02 | Claude Code gets the chat as one block for each message, in an order that stays the same from turn to turn, and the memory with the message instead of in the instructions, so that the model reads most of the history from its cache; the oldest messages go in steps. Written from measurements of `claude` as run on the machine. The public T3 Code and TokenEconomizer repositories were read for the idea of cache-friendly requests; no code was taken. No code of OpenBot or OpenOwnBot was read | Implementer | 006, 003, 008 |
