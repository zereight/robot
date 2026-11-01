# Repository guidance

Read [CLEANROOM.md](CLEANROOM.md) first. It is the main rule of this repository.

- Before you start, state your role: spec author or implementer.
- Implementer: do not open, search, fetch or recall code from OpenBot or OpenOwnBot. If a spec is
  unclear, ask for a spec change. Do not guess from memory of the old app.
- Spec author: change only `specs/` and `docs/`. Describe behaviour, never implementation.
- Write in ASD-STE100 Simplified Technical English. Be concise.
- Interface text comes from translation keys in English and Korean, never literals.
- Run narrow checks only: the changed test file and lint for changed files.
- Never add AI co-author trailers to commits.
