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
    download. It runs only on this computer. Cursor is an agent runtime too. The user installs
    it. The app does not download it and does not sign in for it. See "Cursor".
    Any program that speaks the Agent Client Protocol (ACP, an open standard) can be added as an
    agent runtime too. See "Programs with ACP".
  - **API providers**: an HTTPS model API with a key (OpenAI-compatible, Anthropic, and a custom
    base URL).
- **Account**: one sign-in or key. A provider can have more than one account; the user names them.
- **Model list**: fetched from the provider when possible, with an effort level for models that
  support it.
- **Backup model**: a second choice of account, model and effort for an agent. See "Backup model".
- **Readiness**: the state of an agent runtime on this computer. See "Readiness of an agent
  runtime".

## Flows

1. Connect: in settings, the user picks a provider and signs in or pastes a key. The app checks it
   with one small request and shows "Connected" or the error.
2. Choose: in the agent profile or the chat header, the user picks account, model and effort. In
   the form of a new agent, the effort starts as 002 says (flow 1).
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

## Backup model

An agent can have a backup model. The app uses it when the main model cannot answer because its
limit is spent.

- The choice "Backup model" is under "Model" in the agent form and in the agent profile (002). It
  starts as "None". The user picks an account, a model and an effort from the same lists as for the
  main model. The backup may use another account or another provider. The form refuses the same
  account, model and effort as the main choice, and says why.
- A **limit reason** is one of these: the plan limit is reached, the credit is spent, or the quota
  is spent. The provider says which.
- When a turn of the agent fails with a limit reason, and the agent has a backup model that is
  ready, the app does this:
  1. It holds the main model for this agent until the reset time that the provider names. If the
     provider names no time, the hold lasts 15 minutes.
  2. The turn goes on with the backup model, in the same task. If the failed try ran no step (its
     progress is "Not sent" or "Sent", see 005), the backup runs the turn from the start. If the
     failed try ran steps ("Started"), the backup gets a short new message that asks it to go on.
     This message is not a message of the user and has no row, as the message of "Keep going"
     (005). The app does not send the request again, so no side effect repeats.
  3. The chat shows a muted line: "<main model> reached its limit. <backup model> goes on." The
     line gives the reset time when it is known.
- While the hold lasts, every turn of the agent uses the backup model: a chat, a part of a channel
  job, a message of another agent, a routine that follows the agent, and an agent step of a
  workflow. A routine with its own model (009) keeps it. A model step and a condition in "Ask a
  model" mode name their own provider (010), so they keep it and get no backup.
- The header of the chat shows the backup model and "Backup until <time>". A button "Use <main
  model> now" ends the hold. The next turn then tries the main model. If that turn fails with a
  limit reason again, the hold starts again and the chat shows no second line.
- When the hold time has passed, the next turn uses the main model again, and the header shows the
  main model again.
- When the backup becomes not ready during a hold, for example when its account is disconnected,
  the hold ends at once. The next turn tries the main model. If that turn fails with a limit
  reason, it fails with that reason.
- A turn on the backup model that fails with a limit reason too fails with that reason, as a turn
  with no backup does (see "Rules"). A backup that is not ready does not take the turn. The
  backup is ready when this computer has its account, and the account is connected and, for a
  runtime, Ready. A synced backup that names an account that this computer lacks is not ready,
  and the form shows a muted line that says so.
- A vendor program or a program with ACP reports a limit in its own way. The app reads the
  reports that it knows: the plan limit, the credit or the quota is spent. When it cannot tell
  what the program reports, the turn fails as a turn with no backup does.
- The app stores the hold with its end time on this computer. It stays after a restart and ends
  at its time or with the button.
- A turn goes to the backup for a limit reason only. It does not go for a sign-in or key that is
  not valid, for a model that does not exist, or for a request that the provider refuses.
- The usage page counts the tokens for the model that made them.
- The hold is a state of this computer. It does not sync (019), and an export does not hold it.
  The choice of the backup model is a setting of the agent, so it syncs with the agent (019). An
  agent file holds no model, so it holds no backup model (002).
- The tool with which an agent changes itself (002) does not change the backup model in this
  version.
- A linked device shows the header text of the hold, which its server tells it (012). It shows
  the button only when the server lets it create and change agents.

## Effort levels

- A model lists the effort levels that it takes. The picker shows only those levels. A level that
  a model does not list is never sent to it.
- None and Minimal sit below Low. Ultra sits above Max. They show for a model only when the model
  lists them.
- When the model of an agent changes and the new model does not list the level of the agent, the
  agent uses the nearest level that the new model lists. When two levels are equally near, it uses
  the lower one. A routine follows 009 and a workflow step follows 010 for their own levels.
- The model that counts is the model that runs the turn: the main model, the backup model, or the
  model of a routine. When the level that would be used is not on the list of that model, for
  example the level of the agent when its backup model runs, the turn uses the nearest level on
  that list, and the lower one in a tie. A level that the running model does not list is never
  sent.

## Model list

- The picker shows the models of an account with the newest first. The order comes from the dates
  or versions that the provider gives. When the provider gives neither, the picker keeps the order
  of the provider and has no group "Older models".
- A model is older when the provider also lists a newer model of the same family. Older models
  are in a folded group "Older models" at the end of the list. The group opens when the user types
  in the search box of the picker, and when the model of the agent is in it.
- A model that the app sees for the first time on a later fetch shows the tag "New" for 7 days.
  The first fetch of an account tags nothing.
- The page of an account has a part "Models". It lists the models with one switch each. All are on
  at first. The user can turn a model off, use "Hide all", and use "Reset". A model that is off is
  missing from the picker and from its search. An agent that already uses it keeps it and works;
  the picker shows it as "Hidden" for that agent. The choice belongs to this computer and does not
  sync.
- A custom model (an API provider with a custom base URL, or a model ID that the user types) has
  two optional fields: "Context size" and "Output limit", whole numbers of tokens from 1 to
  10,000,000. The context meter and the compact (003) use the context size. Each request sends the
  output limit as the most tokens to write. A model with no context size has no meter, as 003
  says.

## Programs with ACP

- The page of the agent runtimes has a button "Add a program". The user gives a name, a command,
  arguments, and, if wanted, a list of environment rows. The rows work as the rows for Claude Code
  in "Flows", step 5. The program must speak ACP on its standard input and output.
- The app starts the program on this computer only. It never downloads it and it never signs in
  for it. The program runs only on this computer.
- The row of the program has the states of "Readiness of an agent runtime". The check starts the
  program and makes the ACP handshake. It makes no model turn. If the program says that it needs
  a sign-in, the state is "Needs sign-in", and the row shows what the program says about it.
- An agent uses the program as it uses a vendor runtime. The program works with files and
  commands itself. The app shows its steps, its thinking, its list of steps and its requests for
  permission as cards (003, 007). The level of the agent works as for a vendor runtime (007).
- The model list of such an agent is the list that the program reports. When it reports none, the
  model box shows the name of the program.
- The message box offers an attachment as a picture or as sound only when the program says that it
  takes that kind. For any other kind, the app copies the file into the workspace and tells the
  agent the path, as for any file (003).
- The dialog also lists presets for these programs: Gemini CLI, Kimi Code and Hermes Agent. A
  preset fills the name and the command, and the user can change both. The check decides if the
  installed program works with ACP. If it does not, the row shows "Needs repair" and says why.
- The row has "Edit" and "Remove". After "Remove", an agent that used the program shows "Provider
  not connected" and the button "Providers" (003).
- Each profile (022) has its own programs. An export (014) holds the name, the command, the
  arguments and the names of the rows. It holds no secret value of a row.
- A client of a linked server sees the row and its state, and has no buttons on it (012). A
  program does not sync (019), like the other runtimes.

## Cursor

Cursor is an agent runtime. The user installs the program. The app does not download it and does
not sign in for it. The sign-in stays in the program on this computer.

- The check asks for the version and for who is signed in. It makes no model turn.
- The account is connected when the program says that someone is signed in, or when the program
  lists at least one model. The second case is an account key that the user already gave the
  program. The app does not read that key and does not store it. The row shows the email when
  the program tells it.
- The model list is the list the program gives, in the order of the program. The list names no
  effort levels, so the picker shows none. A level is never sent.
- A turn sends one prompt. The program does not read a message that the user sends during the
  turn (003). The prompt holds the instructions of the agent. A turn that may only answer starts
  in the read-only mode and tells the program to answer in text and not to use its tools.
- The program reads files and runs commands itself. The app shows the steps as cards (003, 007).
  The program does not ask the user during a run from the app. The permission level follows 007.
- The result that the app knows reports no token counts, so the usage shows "—" (005) and the
  token limit of a routine stays off (009). When a result includes counts, the usage page counts
  them. The token limit stays off.
- The program reports no list of steps that the app knows, so "Keep going" has nothing to go on
  (005).
- An import leaves the account disconnected, as for the other runtimes. An export holds no secret
  of the sign-in.

## Busy provider

- When a provider says that it is busy, or that it gets too many requests, the app tries the
  request again, up to 3 times, after 2, 4 and 8 seconds. This holds for a request that has made
  no output yet, for an agent that uses the tools of the app.
- Each wait shows a muted line in the chat: "The model is busy. Trying again (1 of 3)." The wait
  and each new try count as a sign of life (005). Stop ends the wait. After the third try the turn
  fails with the reason of the provider.
- A usage limit is not a busy provider. See "Backup model" and "Rules". A vendor runtime shows
  what its program reports.

## Rules

- Keys and tokens are stored in the system keychain, never in the database or logs.
- The app shows usage that the provider reports (tokens, cost if known, plan limits) on the usage
  page, per agent and per day. For each organization with a daily token limit (030), it also shows the
  tokens used today and the limit.
- A runtime that has skills (named sets of instructions) can report them, and the command list
  of the chat shows them (see 003).
- A runtime that can report the size of the context at the end of a turn does so, so the context
  meter works (see 003).
- A runtime that reports its list of steps (a plan) to the app does so in each turn. The app uses
  the list for "Keep going" (005). A program with ACP reports its plan as the protocol says. A
  runtime that reports no list gives nothing to keep going on.
- When a provider says a usage limit is reached, the turn fails with that reason and the time it
  resets, if known. An agent with a backup model that is ready goes on with it first (see "Backup
  model"). When a provider says the sign-in or key is not valid, the turn fails with that
  reason. The page Today (021) uses these two reasons.
- **Leftover programs**: when the app starts, it ends the vendor programs that it started in an
  earlier run and that still run, for example after a crash. It ends only programs that it
  started itself. It never ends a program that the user started.
- A check of a runtime that hangs or crashes never delays a turn of another provider.
- Token savings (026) are one section of the settings, not a part of a row. The table in 026 says
  which savings work for the agents of each runtime.

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
- An agent has a backup model. The main stand-in model answers with a plan limit that resets in 2
  hours, before it runs a step: the turn runs again on the backup model. The chat shows the line
  with both model names and the reset time, and the header shows "Backup until". The next message
  goes to the backup model at once.
- The main stand-in model fails with the same limit after 2 tool steps: the backup model gets a
  short message that asks it to go on, and it does not get the first request again. The task is
  one task and ends once.
- "Use the main model now": the next turn goes to the main model. It fails with the limit again:
  the hold starts again and the chat shows no second line.
- The main stand-in model fails with an invalid key: no switch happens. Both models fail with a
  limit: the turn fails with the reason of the backup model.
- With a fake clock, move the time past the reset time: the next turn goes to the main model.
- A stand-in model lists "minimal" and "ultra": the picker shows them. A model that lists neither
  shows neither. Change an agent from the first model to the second at "ultra": the agent uses the
  nearest level of the second model.
- A stand-in provider lists six models, two of one family with different versions: the older one
  is in "Older models". Type its name in the search box: the group opens. Turn a model off in the
  part "Models": it leaves the picker, and an agent that uses it still answers.
- A custom model with a context size of 32,000: the context meter shows, and an automatic compact
  starts at 85 percent of it.
- Add a stand-in program that speaks ACP: the row shows Ready, an agent on it answers, and its
  steps show as cards. A stand-in program that asks for a sign-in shows "Needs sign-in". A program
  that exits at start shows "Needs repair".
- A stand-in provider answers "busy" twice and then works: two muted lines show, and the reply
  comes. It answers "busy" four times: the turn fails after the third try with the reason.
- A stand-in model names no reset time with its limit: the hold lasts 15 minutes by a fake clock,
  and the next turn after that goes to the main model. End the app while the hold lasts and start
  it again: the hold is still there.
- The form refuses a backup with the same account, model and effort as the main choice. A backup
  on an account that this computer lacks counts as not ready: the turn fails with the limit
  reason.
- A stand-in vendor program reports a spent plan limit in its own form: the turn goes to the
  backup. It reports something that the app cannot read: the turn fails.
- An agent is on its backup model and has a routine with its own model: the routine keeps its
  model.
- The picker shows "New" for a model that appears on the second fetch, and with a fake clock the
  tag goes after 7 days. The first fetch of an account tags no model. "Hide all" removes every
  model from the picker, and "Reset" brings them back.
- A custom model with an output limit of 2,000 sends 2,000 as the most tokens to write. The field
  refuses 0 and 10,000,001.
- Two levels are equally near after a model change: the lower one is used.
- A stand-in provider says "busy" at once and then works: the first wait is 2 seconds by a fake
  clock. Stop during the wait ends the turn.
- Remove an ACP program: its agents show "Provider not connected" and the button "Providers".
  An export holds the name, the command, the arguments and the names of the rows, not their
  secret values.
- A stand-in for Cursor answers the version check, says that someone is signed in, and lists two
  models: the row shows Ready, the picker shows those models and no effort, and a reply shows in
  the chat. A message sent during the turn waits, and the muted line names Cursor.
- The stand-in is not signed in and lists no model: the row shows Needs sign-in and tells the
  user to sign in inside Cursor. The row has no Sign in button. The program was never found: the
  row shows Not installed and tells the user to install Cursor. The row has no Download button.
- The stand-in is not signed in and lists one model: the row shows Ready and the picker shows
  that model.
- The help text of the stand-in names its read-only mode: Read only can be picked, and a turn at
  Read only starts in that mode. A help text that does not name the mode: Read only is off.
- A turn at Ask for risky steps tells the program to apply changes with its sandbox on. A turn at
  Full access tells the program to apply changes with its sandbox off. Neither turn shows an
  approval card from the program.
- The stand-in ends with no token counts: the task shows "—" for the tokens, and the token limit
  of a routine for that agent is off.
