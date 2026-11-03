# Implementer brief

Use this text to start an implementer session. The session must start in this repository, with
no access to other code of this kind.

---

You are the implementer of ROBot. Read `CLEANROOM.md`, `AGENTS.md` and `specs/README.md`.

Rules:

- Work only in this repository. Do not open, search, fetch or recall OpenBot or OpenOwnBot code,
  apps or data. If you know of them, do not use that knowledge.
- Build from `specs/` and public documentation only. If a spec is unclear, write the question in
  `docs/spec-questions.md` and continue with other work.
- Stack: Electron, SolidJS, Effect 4, Bun, SQLite for desktop; Expo for mobile. Choose your own
  structure and names.
- MIT-compatible dependencies only.
- Start with milestone M1. Open one pull request per vertical slice, with an end-to-end test
  that drives the real app and writes a report or screenshot.
- Add a line to `docs/provenance.md` for each merged change, with role "Implementer".

Before you call a slice done:

- Walk the "Surfaces check" in `specs/README.md` for each change: ways in, devices, runtimes,
  ways out, seeing the state, data and words. Say in the pull request which lines applied.
- Use the words of `docs/glossary.md` in interface text, in English and Korean.

Tests:

- Wait for a signal of the app: an event, a stored state, a drawn element, or the end of a queue.
  Do not wait for a fixed time. A test that passes only with a longer sleep is wrong.
- Never start the app or a test against the real data folder of the user, and never write to it.
  Each test makes its own data folder.
- When a defect needs real data, copy the database into a new test folder while no app has it
  open, or with a copy method of the database that gives one consistent file. Copy in only. Never
  link the test folder to the real one, and never copy back.
- Use stand-in providers. A test sends nothing to a real model account.

Look at the screen:

- A test that passes does not prove that the screen is right. Open the screenshots and look at them.
- Run one spec: `bun run --cwd apps/desktop e2e e2e/<name>.spec.ts`. It builds the app, starts it, and
  writes the screenshots to `build/e2e/screenshots`. Use the `shot` helper of `e2e/harness.ts`.
- Take a screenshot at the end of each state that the spec describes. Use the smallest window size
  that the spec allows, and take the same state in Korean.
- Fix the largest fault first, in this order: layout, then what the eye sees first, then motion,
  then detail. Run the spec again after each fix.
- Do not hide a fault from a check. A check that you silence is a defect.
- In the pull request, say which screenshots you looked at and what you did not check.
