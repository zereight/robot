# Rebuild plan: bots, workflows and routines

The org chart plays a role game. It does not help the user. ROBot keeps two things: bots that
do a role, and workflows and routines that are checked with `tla-ts`.

## Decisions of the owner

| No. | Decision |
| --- | --- |
| 1 | The local database is erased. No migration. The new version starts with a new schema. |
| 2 | Everything that exists for the org chart is removed: organizations, the org chart, the organization prefix, channels, channel starters, the board and Today. |
| 3 | `tla-ts` (MIT) is a check tool for workflows and routines. It is not the engine that runs them. |
| 4 | Soul and self-improvement are part of the agent, in spec 002. |

## What stays

- **Bot** = agent + skills + Soul + self-improvement (002, 017, 008).
- **Direct chat** (003) with one bot.
- **Task** (005) as the record of one run of a bot. Parent and child tasks stay only as far as a
  bot hands work to another bot (007). Nothing about leads or organizations stays.
- **Routine** (009) and **workflow** (010), each with a check by `tla-ts`.
- Providers (006), workspace and tools (007), memory (008), settings (013), local data (014).
  The specs of these areas lose only the words about the removed parts.

## What goes

029 org chart, 030 organization, 031 channel starters, 036 organization prefix, 004 channels,
024 board, 021 Today. The org parts of 001, 002, 005, 007, 011, 012, 013, 014, 019, 037, 038.
Spec 028 (chat bridge) and 015 (notifications) lose the parts that name channels.

## Assumptions to confirm

- Task (005) stays. A bot needs it for a run, a routine and a workflow step.
- Chat bridge (028) stays for direct chats only.
- Sync (019) and the phone (011) stay, with the new data.

## Slices

| Slice | Role | Work |
| --- | --- | --- |
| R1 | spec-writer | Remove the specs and the parts above. Update `specs/README.md`, `docs/glossary.md`. |
| R2 | spec-writer | Soul and self-improvement in 002. Join 008 and 017 to it. Update 000. |
| R3 | spec-writer | `tla-ts` check for workflows (010) and routines (009). Replace the starter "TLA+ check". |
| C1 | implementer | New schema, data reset on first start of the new version. |
| C2 | implementer | Remove the code of R1. |
| C3 | implementer | Soul and self-improvement. |
| C4 | implementer | The check with `tla-ts`. |

C slices start after the R slices are merged.
