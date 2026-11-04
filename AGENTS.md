# Repository guidance

Read [CLEANROOM.md](CLEANROOM.md) first. It is the main rule of this repository.

- Before you start, state your role: spec author or implementer.
- Implementer: do not open, search, fetch or recall code from OpenBot or OpenOwnBot. If a spec is
  unclear, ask for a spec change. Do not guess from memory of the old app.
- Check the spec first: read the specs for the area before you change behaviour. If no spec
  names the change, stop and ask for a spec change before you write code.
- Spec author: change only `specs/` and `docs/`. Describe behaviour, never implementation.
- Development process: when you write or change code, follow the ub-mode skill
  (`.agents/skills/ub-mode/SKILL.md`): first make it work, then make it right, then follow
  practice.
- Write in ASD-STE100 Simplified Technical English. Be concise.
- Interface text comes from translation keys in English and Korean, never literals.
- Styles: use the tokens of `global.css` for text size, radius, motion time and easing, and a `--c-*` token for colour. `style-rules.test.ts` fails on a raw value. Add an exception to its list only with a reason in the pull request.
- Run narrow checks only: the changed test file and lint for changed files.
- Never add AI co-author trailers to commits.
