# Repository guidance

These rules are for every agent. Each role has more rules in `.agents/roles/`. Read the file of
your role before you start. If nobody names a role, you are the implementer.

| Role | File |
| --- | --- |
| Orchestrator (splits work, gives it to child agents) | `.agents/roles/orchestrator.md` |
| Implementer (changes code) | `.agents/roles/implementer.md` |
| Reviewer (reviews a pull request, in a new context) | `.agents/roles/reviewer.md` |
| Spec writer | `.agents/roles/spec-writer.md` |
| Tester | `.agents/roles/tester.md` |

An orchestrator names the role file in line 1 of the task of each child.

## Rules for all roles

- Check the spec first: read the specs for the area before you change behaviour. If no spec
  names the change, stop and ask for a spec change before you write code.
- Specs describe behaviour, never implementation.
- Dependencies: MIT-compatible licenses only. The allowed list is in `host/tests/licenses.rs` and
  in the `licenses` scripts of `apps/desktop` and `apps/mobile`. No PolyForm, and no copyleft that
  would bind the app.
- Write in ASD-STE100 Simplified Technical English. Be concise.
- Never add AI co-author trailers to commits.
- When the session has full permissions, do the work. A rebase of a shared branch, a push, or a
  merge that the task needs is allowed. Do not stop with "Blocked" for lack of a direct
  instruction. Stop only for a real obstacle (a conflict you cannot resolve, a failing check) and
  say what it is.
