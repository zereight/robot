# Release

Role: Implementer. This page describes how ROBot desktop builds are made and published.

## Builds

| Platform | Files | Signature |
| --- | --- | --- |
| macOS Apple silicon | `ROBot-<v>-mac-arm64.dmg`, `.zip` | Ad-hoc (no Developer ID yet) |
| macOS Intel | `ROBot-<v>-mac-x64.dmg`, `.zip` | Ad-hoc |
| Windows x64 | `ROBot-<v>-win-x64.exe` (installer) | None |
| Linux x64 | `ROBot-<v>-linux-x86_64.AppImage`, `ROBot-<v>-linux-amd64.deb` | None |

`SHA256SUMS.txt` lists a checksum for each file.

## Steps

1. On a branch `release/v<v>`, run `bun run version <v>` (for example `0.2.0`, or `0.2.0-beta.1`
   for a pre-release). Open a PR and squash-merge it when the checks pass.
2. Tag the merge commit on `main` and push the tag:
   `git checkout main && git pull && git tag v<v> && git push origin v<v>`.
3. The **Release** workflow runs:
   - `verify`: the tag must equal the version in `apps/desktop/package.json`; then lint, typecheck
     and unit tests.
   - `package`: builds on four runners (macOS arm64, macOS x64, Windows x64, Linux x64) and runs
     the whole end-to-end suite against each packaged app.
   - `release`: makes a **draft** release with the files, checksums and generated notes. A version
     with `-` is marked as a pre-release.
4. Download one build, start it, and check the version in Settings > About.
5. Publish the draft: `gh release edit v<v> --draft=false`, or use the GitHub page.

A failed run makes no release. Fix the cause on `main`, delete the tag
(`git push origin :refs/tags/v<v> && git tag -d v<v>`), and tag again.

## Dry run

Actions > Release > Run workflow builds and tests all four apps and keeps them as workflow
artifacts for 14 days. It makes no release.

## Local build

`bun run dist` builds for the current computer into `dist/desktop`. To run the end-to-end suite
against it: `cd apps/desktop && ROBOT_E2E_APP="$(bun scripts/packaged-path.ts)" bunx playwright test`.

## First start on an unsigned build

- macOS: the app is not notarized. Open it once with Control-click > Open, or run
  `xattr -dr com.apple.quarantine /Applications/ROBot.app`.
- Windows: SmartScreen may warn. Choose More info > Run anyway.

## Later

- Signing and notarization: set `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as repository secrets, remove `identity: "-"`
  from `apps/desktop/electron-builder.yml`, and add `notarize: true`.
- Automatic updates need signed macOS builds, so they wait for signing.
