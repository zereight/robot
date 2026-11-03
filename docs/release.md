# Release

Role: Implementer. This page describes how ROBot desktop builds are made and published.

## Builds

| Platform | Files | Signature |
| --- | --- | --- |
| macOS Apple silicon | `ROBot-<v>-mac-arm64.dmg`, `.zip` | Developer ID and notarized when the signing secrets are set (see Signing). Ad-hoc when they are not |

The desktop app is for Macs with Apple silicon only (specs/000-product.md). There is no build for
an Intel Mac, for Windows or for Linux.

`SHA256SUMS.txt` lists a checksum for each file.

## Steps

1. On a branch `release/v<v>`, run `bun run version <v>` (for example `0.2.0`, or `0.2.0-beta.1`
   for a pre-release). Open a PR and squash-merge it when the checks pass.
2. Tag the merge commit on `main` and push the tag:
   `git checkout main && git pull && git tag v<v> && git push origin v<v>`.
   A tag on a commit that is not in `main` fails the run.
3. The **Release** workflow runs:
   - `verify`: the tag must be on `main` and equal the version in `apps/desktop/package.json`;
     then lint, typecheck and unit tests.
   - `package`: starts at the same time as `verify`. It builds on one Apple silicon runner, signs
     (see Signing), then runs `apps/desktop/scripts/check-dist.ts` and the whole end-to-end suite
     against the packaged app. The check opens the disk image and the zip file, the files that
     users get, and fails when a version is wrong, a file is not for arm64 only, the host program
     is missing, the signature does not hold, or the two files are not one build. A signed run
     also needs the Developer ID, the hardened runtime, the notarization ticket and Gatekeeper's
     yes.
   - `release`: starts only when `verify` and `package` pass. It makes a **draft**
     release with the files, checksums and generated notes. A version with `-` is marked as a
     pre-release.

   Packages, the Electron download and the files of electron-builder are kept in the Actions
   cache for each runner, keyed by `bun.lock`.
4. Download one build, start it, and check the version in Settings > About.
5. Publish the draft: `gh release edit v<v> --draft=false`, or use the GitHub page.

A failed run makes no release. Fix the cause on `main`, delete the tag
(`git push origin :refs/tags/v<v> && git tag -d v<v>`), and tag again.

## Dry run

Actions > Release > Run workflow builds and tests the app and keeps it as a workflow artifact
for 14 days. It makes no release. A PR that changes the packaging files runs the same
dry run. A PR never signs with a Developer ID, so it never reads a secret. It is signed ad-hoc like a tag build (electron-builder would skip all signing in a PR, so the workflow turns it on for that step), and the check of the disk image and the zip file runs on it.

Run workflow with **sign** on is the dry run of the signed build: it signs, notarizes and checks
with `--signed`. It fails at once when the signing secrets are not set.

## Signing

Set these in Settings > Secrets and variables > Actions of the repository:

| Name | Kind | Value |
| --- | --- | --- |
| `CSC_LINK` | secret | The "Developer ID Application" certificate with its private key, exported from Keychain Access as `.p12`, as base64 text |
| `CSC_KEY_PASSWORD` | secret | The password of that `.p12` file |
| `APPLE_ID` | secret | The Apple ID of the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | secret | An app-specific password of that Apple ID |
| `APPLE_TEAM_ID` | secret | The 10-character team ID |
| `MAC_IDENTITY` | variable | The full name of the certificate, for example `Developer ID Application: Name (TEAMID)` |

With `CSC_LINK` set, a tag build signs with the Developer ID, turns the hardened runtime on and
notarizes. Without it, the tag build stays ad-hoc and the run shows a warning. The flags are on
the command line of the workflow, so `electron-builder.yml` and every build that is not a tag
stay as they are.

The signed path has not run yet: it was written before a certificate existed. Before the first
real release, run the dry run with **sign** on and read the log. Likely places to fix are the
name in `MAC_IDENTITY` and the entitlements of the hardened runtime (the default set of
electron-builder is used). Check the result on another Mac: download the artifact, open the disk
image, and start the app. There must be no warning of Gatekeeper.

## Local build

`bun run dist` builds for the current computer into `dist/desktop`. To run the end-to-end suite
against it: `cd apps/desktop && ROBOT_E2E_APP="$(bun scripts/packaged-path.ts)" bunx playwright test`.
To check the disk image and the zip file as the release does: `cd apps/desktop && bun scripts/check-dist.ts`
(add `--signed` for a signed build).

## First start on an unsigned build

- macOS: the app is not notarized. Open it once with Control-click > Open, or run
  `xattr -dr com.apple.quarantine /Applications/ROBot.app`.

## Later

- Automatic updates need a signed build, and a spec for what the user sees (a question for the
  spec author is in `docs/spec-questions.md`). The release then also needs an update feed
  (`latest-mac.yml` and block maps from electron-builder) on a published release.
- A pre-release is never "latest" on GitHub. A download link that does not change needs a file
  with a name that has no version, attached to each release.
