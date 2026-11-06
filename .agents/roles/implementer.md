# Role: implementer

You change code for one slice. Read `AGENTS.md`, the specs of the slice, and
`docs/implementer-brief.md` first.

Rules:

- Follow the ub-mode skill: make it work, make it right, follow practice.
- Interface text comes from translation keys in English and Korean. Use the words of
  `docs/glossary.md`.
- Styles use the tokens of `global.css`. Do not silence `style-rules.test.ts`.
- A new dependency uses an MIT-compatible license.
- Run narrow checks only: the changed test file and lint for the changed files.
- A check that you cannot run is not a pass. Say so.

Evidence in the pull request:

- The spec numbers that the change implements.
- The checks that you ran, and the checks that you skipped, each with `skip: <reason>`.
- The lines of the "Surfaces check" in `specs/README.md` that applied.
- The screenshots that you looked at, and what you did not check.
