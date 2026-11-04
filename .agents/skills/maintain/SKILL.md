---
name: maintain
description: >-
  Land a change in the robot repository: check it with the end-to-end specs on this computer, open
  the pull request, wait for CI, and squash-merge it. Use only in this repository, when the user
  asks to ship, land, open a PR or merge. Trigger words: maintain, land, ship, merge, PR, 머지,
  PR 올려.
---

# Maintain: land a change

Use this skill in this repository only. CI does not run the end-to-end suite. It runs on this
computer only, so this skill runs it before the pull request.

The user who asks you to land a change has approved the push, the pull request and the merge when
CI passes. If the user asked only for a pull request, stop after step 6. This approval does not
cover the cases in "Stop and ask".

Read `AGENTS.md` first.

## 1. Look at the branch

- Run `git status --short` and `git log --oneline origin/main..HEAD`.
- A commit that you did not make is in the log: tell the user, and ask before you push it. Say who
  made it in the pull request.
- Never use a bare `git stash`. Make a WIP commit.

## 2. Check on this computer

- Lint the changed files: `bunx biome check <files>`.
- Run the unit tests of the changed files: `bun test <files>`.
- Run `bun run typecheck` in each package that you changed.
- Do not run the whole unit suite. The push hook runs it (step 5).
- Run the end-to-end specs that cover the change. The build needs `cargo` in PATH. On this computer
  it is in `/opt/homebrew/opt/rustup/bin`.
  `PATH=/opt/homebrew/opt/rustup/bin:$PATH bun run --cwd apps/desktop e2e e2e/<name>.spec.ts`
  The command builds the app, then runs the spec. Run it again after each code change.
- Find the specs: `grep -l "<test id or text>" apps/desktop/e2e/*.spec.ts`. If no spec covers the
  change, add one, or say in the pull request that none covers it.
- With `--repeat-each`, also use `--workers=1`. Copies that run at the same time can share a
  folder and fail for that reason (`motion.spec.ts`).
- A test that passes does not prove that the screen is right. Open the screenshots in
  `build/e2e/screenshots` and look at them (`docs/implementer-brief.md`, "Look at the screen").
  Look in both themes when the change has colour.
- Show that a new check can fail. Break the code on purpose, run the check, see it fail, and
  restore the code.
- Do not silence a failing check. Find the cause.

## 3. Commit

- Write a short title in the imperative mood. Then write what changed and why.
- Never add an AI co-author trailer.
- The `pre-commit` hook runs Biome on the staged files. Do not use `--no-verify`.

## 4. Rebase

- Run `git fetch origin main && git rebase origin/main`.
- A conflict where both sides add lines: keep both. Remove only the three marker lines, with
  Python (`sed -i` is different on macOS). Then check that `git grep -n '^<<<<<<< '` finds nothing.
  Then run `git add` and `GIT_EDITOR=true git rebase --continue`.
- Any other conflict: read both sides. If you cannot tell which side is right, stop and ask.
- Do the checks of step 2 again after the rebase.

## 5. Push

- The hook `.githooks/pre-push` runs `bun run check`. It takes about 2.5 minutes on a quiet
  computer. A tool call with a shorter time limit ends before the push ends.
- Run `uptime` first. Other sessions use this computer. Wait until the 1-minute load is below 10.
  Tests that start `bun` programs reach their limit of 30 seconds when the load is high.
- Run the push in the background, and read the log:
  `(nohup git push -u origin "$(git branch --show-current)" > /tmp/push.log 2>&1; echo "exit=$?" >> /tmp/push.log) > /dev/null 2>&1 &`
- Another session can use this worktree. It can push your branch and open a pull request before
  you do, and its push does not show in `git reflog`. Before you push, and each time a push
  fails or ends with no answer, run `git ls-remote --heads origin <branch>` and
  `gh pr list --head <branch> --state all`. If the branch or a pull request is there, do not push
  again and do not open a second pull request. Compare `git rev-parse HEAD` with the remote
  commit, and use the pull request that exists (step 6).
- The hook fails: read the `(fail)` lines in the log. For each failed test in a file that your
  change does not touch, run that file alone with `bun test <file>`. If it passes alone, push once
  more after the load falls. Do not use `--no-verify`.
- Force-push only your own branch, after a rebase, with `--force-with-lease`.

## 6. Open the pull request

- Write the body in a file. Run
  `gh pr create --base main --head <branch> --title "<title>" --body-file <file>`.
- A pull request for the branch exists already: do not create another. Read it with
  `gh pr view <number>`. If its body lacks a section of the template, put the missing sections in
  front of the text that is there, and run `gh pr edit <number> --body-file <file>`. Do not remove
  the text of the other session.
- The body keeps the sections of `.github/pull_request_template.md`: Specs, Checks, End-to-end
  check. Tick a box only when it is true.
- In "End-to-end check", name the specs, say which screenshots you looked at, and say what you did
  not check.
- Add what changed, which checks passed, and what is not done.

## 7. Wait for CI, then merge

- Run `gh pr checks <number> --watch --interval 20`. Only the job `check` is required. It takes
  about 2 to 3 minutes.
- The merge is refused while `check` runs. Wait. Never use `--admin`.
- `check` fails: run `gh run view <run id> --log-failed`. Fix the cause and push again. Never merge
  a pull request with a failed check.
- `check` passes: first run `gh pr view <number> --json headRefOid,mergeStateStatus`. The head must
  be the commit that you checked, and the state must be `CLEAN`. Then run
  `gh pr merge <number> --squash`. The squash commit title gets ` (#<number>)`.
- Check the result: `gh pr view <number> --json state,mergeCommit`, then
  `git fetch origin main && git log --oneline -2 origin/main`.
- Do not delete the remote branch unless the user asks.

## Stop and ask

- The hook fails again on a test that your change does not touch. Say that CI runs the same checks.
  Only the user can allow `--no-verify` for that push.
- CI fails, or you cannot tell if the failure is yours.
- A conflict that you cannot solve.
- The change needs a change to a spec that the user did not ask for.
- The branch holds a commit that you did not make, and the user has not said to push it.
- A pull request for the branch exists, and its head is not the commit that you checked.

## Report

Write a short message: the link to the pull request, the merge commit, the checks that you ran,
what you did not check, and what failed on the way.
