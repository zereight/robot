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
EXPECT_TITLE="(You)" ALLOW="Your Name" bun run --cwd packages/teams-bridge echo   # 4. Answers each new message of a sender on the list.
```

- The page selectors in `src/selectors.ts` are **guesses**. They are not checked against the real
  Teams page. Step 2 prints attribute names and counts, with no message text. Use it to fix the
  selectors. If step 3 says "No message found" in a chat that has messages, the selectors are wrong.
- `echo` does not start without `EXPECT_TITLE`. Before each send, the program reads the title of
  the open chat. If the title does not contain that text, or no title is found, it refuses to send.
  This stops a message from going to the wrong chat.
- The program marks its own text with a marker (default `[ROBot]`) and never reads text with that
  marker again. At the start it ignores the messages that are already in the chat.
- `echo` does not start without `ALLOW`. It answers a message only when all of these are true:
  the sender is on `ALLOW`, the sender is not on `BOTS`, and the message calls the bridge. With
  `CALL` empty, the chat is a direct chat and every message calls the bridge. With `CALL` set, the
  message must contain that text. A sender with no name gets no answer. The lists come only from
  the environment: the text of a message cannot change them. A message never answers an approval.
- Each answer goes in an outbox before it goes out. The answers go out in the order in which the
  bridge made them. A failed send tries again after 5 seconds, then after a time that doubles each
  try, up to 5 minutes. An answer holds back the later answers until it failed 3 times in a row.
  Then the program prints a problem line and the later answers go out. When the open chat is not
  the expected chat, the answer is dropped at once and never sent again. The program prints when,
  why and for which message. The outbox is in memory: it is gone when the program ends.
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
| `ALLOW` | none | Names of the senders that the bridge answers, with commas between them, as the chat shows them |
| `BOTS` | none | Names of senders that are bots, with commas between them. They never get an answer |
| `CALL` | none | Text that a message must contain to call the bridge, for example `@ROBot`. Empty: every message calls it |

## The profile folder

The profile folder holds the sign-in. It gives access to the account, so treat it as a secret. The
program makes it with mode 0700. Keep it on an encrypted disk, and keep it out of backups and sync.

## Tests

- `bun test packages/teams-bridge` runs the 25 tests of the pure logic. The shared test run of the
  repository (CI) includes them.
- `bun run --cwd packages/teams-bridge test:browser` runs 14 more tests on a fake chat page in
  Chrome without a window. They are not in the shared test run, because a browser loads the
  computer and can slow the tests that run at the same time. They need Google Chrome, and they
  skip with a note when it is not installed.

The fake page uses the guessed selectors, so these tests show nothing about the real Teams page.
