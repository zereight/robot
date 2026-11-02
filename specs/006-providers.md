# 006 Providers

## Purpose

The user connects the model accounts they already have, and each agent uses one of them.

## Concepts

- **Provider**: a source of models. Two kinds:
  - **Agent runtimes**: coding agent programs from the model vendors (for example OpenAI Codex
    and Anthropic Claude Code). The app downloads the vendor's own runtime on request and the user
    signs in with the vendor's sign-in. These runtimes can read files and run commands themselves.
    Muse Code, pi, and Pi-Bolt are also agent runtimes. Pi-Bolt is a build of pi that reads the
    same agent folder as pi. It has its own row, so its models list under its own name and not
    under pi. The app finds Pi-Bolt by a path variable or on the PATH of the computer. It has no
    download. It runs only on this computer.
  - **API providers**: an HTTPS model API with a key (OpenAI-compatible, Anthropic, and a custom
    base URL).
- **Account**: one sign-in or key. A provider can have more than one account; the user names them.
- **Model list**: fetched from the provider when possible, with an effort level for models that
  support it.
- **Readiness**: the state of an agent runtime on this computer. See "Readiness of an agent
  runtime".

## Flows

1. Connect: in settings, the user picks a provider and signs in or pastes a key. The app checks it
   with one small request and shows "Connected" or the error.
2. Choose: in the agent profile or the chat header, the user picks account, model and effort.
3. Switch: the user changes the model of an agent mid-history. The next turn uses it; the earlier
   turns stay.
4. Disconnect: removes the stored secret. Agents that used it show "Provider not connected".
5. Environment variables for Claude Code: on the Claude Code page, the user keeps a list of rows.
   A row has a name, a value, and a "Secret" switch. The variables belong to the provider on this
   computer, not to one agent. The app reads the list at the start of each run.
   - A variable of this list wins over the same name in the vendor's own settings file.
   - A name that the app needs for itself is refused when the user types it. The message names
     the row.
   - A value that is not a secret is stored as text and shows again. A secret value is stored in
     the system keychain (see 014), is never sent back to the settings page, and shows as hidden.
     A row saved without a new value keeps the old value. To show a secret again, the user types
     the value again.
   - A saved name that a later version of the app refuses is dropped when the list loads, so the
     list never becomes unreadable.
6. Check and repair: on the row of an agent runtime, the user chooses "Check again" to see the
   state, or "Repair" when the state is "Needs repair".

## Readiness of an agent runtime

The row of each agent runtime shows one state, as a tag with text. Colour alone is not enough.

| State | Meaning |
| --- | --- |
| Checking | A check runs now. It is temporary and ends within 15 seconds in one of the other states. |
| Ready | The program is on this computer, it starts and answers, and, if it has a sign-in, someone is signed in. |
| Needs sign-in | The program starts and answers, and nobody is signed in. |
| Needs repair | The app knows where the program is or was, and the check fails. |
| Not installed | The app knows no place for the program and finds none. |

- Found is not Ready. The check runs the program once, with no model turn. It asks only for the
  version or the sign-in state. A program that does not answer is not Ready.
- Needs repair covers a file that is gone or moved, a program that does not start, a program
  that does not answer, and an answer that the app cannot read. The row says which, in plain
  words.
- Not installed shows the download button or the install note, as before.
- The app checks when the Providers page opens, when the user chooses "Check again", after
  Download, Repair and Sign in, and when a turn cannot start the program. In the last case the
  state turns to Needs repair at once.
- "Check again" changes nothing except the state that the row shows and the time of the check.
- "Repair" is the only action that changes the program. It looks for the program again in the
  places that the app already uses for it. For a program that the app downloaded, it downloads
  the program again and checks the checksum. Then it checks the program. It never signs in,
  signs out or removes a sign-in. When it fails, the row shows the reason and what the user can
  do.
- An agent keeps its runtime when the state is Needs repair or Not installed. Its message box is
  disabled, as for "Provider not connected" (003), with a button: "Repair" or "Providers". A task
  of that agent from a channel, a routine or a workflow fails at once with the state in words.
  After the repair, Retry works.
- Needs sign-in works as before.
- A client of a linked server sees the state and has no buttons on the row (012). Sync does not
  carry the state (019). Each computer has its own programs.

## Rules

- Keys and tokens are stored in the system keychain, never in the database or logs.
- The app shows usage that the provider reports (tokens, cost if known, plan limits) on the usage
  page, per agent and per day.
- A runtime that has skills (named sets of instructions) can report them, and the command list
  of the chat shows them (see 003).
- A runtime that can report the size of the context at the end of a turn does so, so the context
  meter works (see 003).
- When a provider says a usage limit is reached, the turn fails with that reason and the time it
  resets, if known. When a provider says the sign-in or key is not valid, the turn fails with that
  reason. The page Today (020) uses these two reasons.
- **Leftover programs**: when the app starts, it ends the vendor programs that it started in an
  earlier run and that still run, for example after a crash. It ends only programs that it
  started itself. It never ends a program that the user started.
- A check of a runtime that hangs or crashes never delays a turn of another provider.

## Acceptance

- Add the row `GREETING` with value `hello` for Claude Code. Start a run: the run sees `GREETING`.
  Add a row with a secret value: the settings page never shows the value again, and the database
  file holds no clear text of it.
- Type the name of a variable that the app needs for itself: the row is refused.
- Connect an API key, pick a model, get a reply. Disconnect: the chat shows the reconnect button.
- No secret appears in the database file, the logs or an export.
- A stand-in program answers the check: the row shows Ready. Remove the program and choose
  "Check again": the row shows Needs repair, the message box of an agent on it is disabled with
  "Repair". Put the program back and choose "Repair": the row shows Ready and the message box
  works.
- A stand-in program that exits at start gives Needs repair with a reason about the start. A
  runtime that was never found gives Not installed.
- The check makes no model turn: the stand-in program counts only a version or sign-in call.
  "Repair" leaves the sign-in of the program as it was.
- A check that does not end gives a state within 15 seconds. The row never stays at Checking.
- Start a turn on a stand-in program, end the app with no warning, and start it again: the
  stand-in program no longer runs. A program with the same name that the user started by hand
  still runs.
- A stand-in runtime never answers its check. A chat with an agent on an API account, opened at
  that time, answers with no delay.
