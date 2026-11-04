# Repository guidance

- Check the spec first: read the specs for the area before you change behaviour. If no spec
  names the change, stop and ask for a spec change before you write code.
- Specs describe behaviour, never implementation.
- Dependencies: MIT-compatible licenses only. The allowed list is in `host/tests/licenses.rs` and
  in the `licenses` scripts of `apps/desktop` and `apps/mobile`. No PolyForm, and no copyleft that
  would bind the app.
- Development process: when you write or change code, follow the ub-mode skill
  (`.agents/skills/ub-mode/SKILL.md`): first make it work, then make it right, then follow
  practice.
- Write in ASD-STE100 Simplified Technical English. Be concise.
- Interface text comes from translation keys in English and Korean, never literals.
- Styles: use the tokens of `global.css` for text size, radius, motion time and easing, and a `--c-*` token for colour. `style-rules.test.ts` fails on a raw value. Add an exception to its list only with a reason in the pull request.
- Run narrow checks only: the changed test file and lint for changed files.
- Never add AI co-author trailers to commits.
