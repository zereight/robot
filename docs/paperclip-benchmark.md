# Paperclip: what it does and what ROBot can take

This note compares one public project with ROBot. It is not a spec. It was written on 2026-11-06
from public documents. Check a fact again before a spec relies on it.

How sure a fact is:

- **Read**: the author read the public README, ROADMAP or source file.
- **Not run**: nobody installed or ran the app. No claim here comes from a test run.
- **Proposal**: the author's idea for ROBot. The user has not decided it.

## Source

- Project: Paperclip (`github.com/paperclipai/paperclip`). It manages teams of AI agents as a
  company. License MIT. About 111000 stars on 2026-11-06. Created 2026-03-02.
- Read: README, ROADMAP, the file list of `ui/src/pages`, and `OrgChart.tsx` (690 lines).
- Not read: the server code, the plugin code. Not run: the app (`npx paperclipai test-drive`
  needs a model key and was not run).

## What Paperclip does (Read, not run)

| Part | What it does |
| --- | --- |
| Org chart | A tree of agents by reporting line. Each node has a title, a role and a status dot. Tree layout, SVG, pan, zoom, touch pinch, import and export buttons. |
| Goals | Tasks link to projects and to company goals. An agent reads the reason for its work. |
| Heartbeat | An agent wakes on an assigned task, a follow-up or a schedule. |
| Budget | Limits for a company, an agent and a project. Alerts at thresholds. Auto-stop. |
| Governance | Approval gates, approval of a hire, rollback of a config change, review stages, an activity log with who did what. |
| Routines | Cron, webhook and API triggers. |
| Company import and export | Moves an org structure and its agents between instances. |
| Other | Plugins, a skills store, a secrets manager with access for each agent, an MCP tool gateway, sandbox runners. |

## What ROBot already has (Read of the specs)

| Paperclip part | ROBot today |
| --- | --- |
| Org chart | Spec 029 (chart) and 030 (organization). The tree is a tree of organizations, not a reporting line. Spec 029 says ROBot makes no boss-and-report field. This stays. |
| Goals | The field "Goal" of an organization (030). Members read it before their own instructions. |
| Budget | A daily token limit for each organization, with a note at 80 percent and a stop at the limit (030). A token limit for each routine run (009). Tokens for each task (005). |
| Approval gates | Approval steps in workflows (010). Review of parts (004). Permission levels (007). Requests for changes by an agent need approval (037). |
| Activity log | The action log of tool steps, 90 days (007). Moments of a task (005). |
| Import and export | Export and import of a profile holds organizations and their access (014, 029, 030). Agent files (002). |
| Undo | Undo after a change of an agent, a channel or a routine (037, 030). |

## Gaps (Proposal)

These are the only items that no spec names. Each one needs a spec change before any code.

1. **Share one organization.** The export holds a whole profile. Paperclip moves one company.
   Ask: add "Export this organization" with its agents, so that the user shares or reuses a team?
2. **Image or text export of the chart.** Spec 029 lists it as not included. Paperclip has no
   such export either, as far as the README says. No action unless the user asks.
3. **Heartbeat.** ROBot has routines with a schedule or a watch (009). No gap found.

## Do not take

- A reporting line, a title or a "CEO" agent. Spec 029 and the glossary decided against them.
- A cloud sign-up, plugins from outside, and sandbox runners. They break the rule that data stays
  on the computer (000, 014).

## Next step

The user dropped the limit gaps (money budget, limit for one agent) on 2026-11-06. The user picks which of the rest to spec. Then a spec author changes specs 030 and 009 (and
014 for gap 3), adds the change to `docs/spec-changes.md`, and the code follows in one slice for
each change.
