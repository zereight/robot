# Teams bridge (first step)

A separate program for the computer of the user. It is **not part of the app**. The app does not
start it, and it changes no behaviour of the app.

It reads one Microsoft Teams chat in a browser where the user signed in, and it answers in the
same chat. It needs no app registration with the company: it uses the sign-in that the user made
by hand.

**Status: first step (M0).** It echoes a message back. It has no link to ROBot yet. The next step
is to give each new message to an agent through the outside program helper (spec 023).

> Use of a company account in this way can break the rules of the company or of Microsoft.
> Check them before you use this program.

## Use

```bash
bun run --cwd packages/teams-bridge login     # 1. Sign in by hand in the window. The sign-in stays in the profile folder.
bun run --cwd packages/teams-bridge inspect   # 2. Open a chat, press Enter. Prints the shape of the page.
bun run --cwd packages/teams-bridge watch     # 3. Reads only. Prints each new message. Sends nothing.
EXPECT_TITLE="(You)" bun run --cwd packages/teams-bridge echo   # 4. Answers each new message.
```

- The page selectors in `src/selectors.ts` are **guesses**. They are not checked against the real
  Teams page. Step 2 prints attribute names and counts, with no message text. Use it to fix the
  selectors. If step 3 says "No message found" in a chat that has messages, the selectors are wrong.
- `echo` does not start without `EXPECT_TITLE`. Before each send, the program reads the title of
  the open chat. If the title does not contain that text, or no title is found, it refuses to send.
  This stops a message from going to the wrong chat.
- The program marks its own text with a marker (default `[ROBot]`) and never reads text with that
  marker again. At the start it ignores the messages that are already in the chat.
- Limits: 20 answers in one minute, 4000 characters in one message (longer text is split), one
  read each 3 seconds.

## Settings (environment)

| Name | Default | Meaning |
| --- | --- | --- |
| `TEAMS_URL` | `https://teams.cloud.microsoft/` | Address of Teams on the web |
| `PROFILE_DIR` | `~/.teams-bridge/profile` | Folder of the browser profile |
| `BROWSER_CHANNEL` | `chrome` | `chrome` or `msedge`, the browser that is installed |
| `MARKER` | `[ROBot]` | Start of each text that the program writes |
| `POLL_MS` | `3000` | Time between reads, at least 500 |
| `CHUNK_MAX` | `4000` | Most characters in one message |
| `EXPECT_TITLE` | none | Text that the chat title must contain for a send |

## The profile folder

The profile folder holds the sign-in. It gives access to the account, so treat it as a secret. The
program makes it with mode 0700. Keep it on an encrypted disk, and keep it out of backups and sync.

## Tests

`bun test packages/teams-bridge` runs the pure logic and a fake chat page. The fake page uses the
guessed selectors, so the tests show nothing about the real Teams page. The browser tests need
Google Chrome and skip with a note when it is not installed.
