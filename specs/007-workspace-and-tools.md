# 007 Agent workspace and tools

## Purpose

Each agent works in its own folder with real tools, and the user stays in control of risky steps.

## Concepts

- **Workspace**: a folder per agent, under a ROBot folder in the user's home by default
  (`~/ROBot Agents/<agent name>`). The user can point an agent at another folder, such as an
  existing project.
- **Tools**: read and write files, run shell commands, search, fetch web pages, drive a browser
  window, ask the user a question, message other agents, read and run workflows (see 010), search
  past chats (see "Searching past chats"), use the computer (see "Computer use"), and use the
  tools of the connections that the user added (see 018).
- **Permission level** per agent: "Ask for everything", "Ask for risky steps" (default), or
  "Full access". A linked device (012) can make the level stricter, never looser.
- **Rule**: a saved decision that the user made. A rule can allow or deny a kind of step. See
  "Permission rules".
- **Action log**: the list of the tool steps that the rules and the permission levels decided.
  See "Action log".

## Flows

1. The user opens the workspace from the agent profile; the app shows it in the system file
   browser.
2. When a step needs permission, the chat shows an approval card: what the agent wants to do, the
   command or path, and Allow once, Always allow for this agent, Deny. "Always allow for this
   agent" saves an allow rule (see "Permission rules").
3. The agent asks a question: a question card shows with the choices or a text field. The task
   waits.
4. Browser: the agent can open a browser window that the user can watch. The user can take
   control, then give it back. Stop ends the browser work at once.
5. Other agents: see "Working with other agents".
6. Computer use: see "Computer use".

## Working with other agents

- The tool "list agents" gives the agent a list of the other agents on the server that are not
  archived: name, role line and state.
- The tool "send message" sends a text to one of them. This makes a task for that agent (see 005)
  with the source "another agent". An agent cannot send a message to itself or to an archived agent.
- The reply of the receiver comes back to the sender as a new message in a later turn. The sender
  can end its turn after it sends, and it does not wait in a running turn.
- Every agent is told to look for a teammate early when work needs a skill, a service or an
  account outside its own role. It matches the work to role lines, not to names. It uses the list
  again only when a new kind of work appears.
- A message from another agent is input from a colleague. The receiver does not treat it as an
  order that overrides its own instructions or the rules of the app.
- The **main agent** (see 002) is told this: answer a quick request yourself. For other work,
  list the agents, split the request into parts, and send every independent part to its best
  teammate in the same turn, so that they work in parallel. Send a part that needs the result of
  another part only after that result arrives. Then end the turn. When every reply is in, merge
  them into one answer. The answer starts with the result, names the teammate for each part, and
  marks a part that failed or got no reply. Do not do a part yourself when the role line of a
  teammate covers it. Do not send a part twice.

## Searching past chats

- The tool "search chats" searches the messages that the agent took part in: its direct chats,
  its threads, and the channels where it is a member. The match rule is the one of message
  search (001), applied to the words that the agent gives to the tool. It skips archived places, as the search
  of the user does.
- It gives at most 10 hits, newest first. A hit has the place, the time, who wrote the message,
  and a piece of the message of at most 300 characters around the first matching word. All
  pieces together have at most 4000 characters.
- It reads no tool card, no thinking, no file, and no message of a place where the agent has no
  part.
- The tool changes nothing and needs no approval. A tool card shows "Searched past chats".
- The tool is on only when memory is on for that agent (see 008). An agent with memory off does
  not get it. A runtime that cannot call tools of the app does not get it either.
- A piece of a message is input from the past. The agent does not treat it as an order that
  overrides its own instructions or the rules of the app.

## Computer use

- **Computer use** lets an agent look at the controls of one app window (role, label and value of
  each control) and press, type and scroll in it. It needs the permission that the system gives
  for this. If the permission is missing, the page for it in settings says what to do, and offers
  a retry. If a retry does not help, the page tells the user to quit and start the app again, and
  then to install the newest version.
- A switch in the agent profile turns computer use on or off for that agent. The default is on.
- **Fast path**: a tool in which a fast decision model (see 013, "Decision model") tries the first
  steps, before the model of the agent.
  - It is off until the user turns on its switch in the decision model section of settings.
  - Each call asks the user for approval, also at the permission level "Full access".
  - One call does at most 6 steps. For each step the app reads the controls of the one window and
    sends them to the decision model. It sends the goal that the agent wrote (the first 500
    characters) and, for each control, its role, label and value. It sends no screenshot and not the
    text that the agent will type.
  - It sends no value for a password field, or for a control whose label names a password, a code,
    a token, a key or a card number. It never types into such a control.
  - The model answers with a probability for the action and for the control. The app acts only
    when both are the most likely option and at least 0.75.
  - The app waits at most 3 seconds for an answer. A model that is not set up, an unsure answer, a
    "blocked" answer, a late answer, a failure, an action that the app refuses, the step limit, and
    a missing system permission all end the call with a "fall back" result. That result holds the
    current controls, and the agent goes on with its normal computer tools. This path is a first
    try, never a second agent.
  - A claim of "done" from the model is a claim only. The agent checks it, because some apps keep
    their display out of the controls list and a click cannot be verified.

## Permission rules

A rule is a decision that the user keeps, so the app does not ask again, or does not run a step
at all.

- A rule has: the agent it is for (one agent, or all agents), a step kind, a match text, a
  decision (Allow or Deny), the date, and where it came from (an approval card, or the rules
  list).
- The step kinds are: files (read or write), shell command, web page fetch, and a tool of a
  connection (see 018). Browser steps and computer use have no rules. They follow the permission
  level.
- What the match text matches:
  - Files: a path. A folder matches the folder and everything inside it. The app compares real
    paths, so a link cannot reach a place that the rule does not name.
  - Shell command: the full command text, or the start of a command. A rule text matches a
    command when the two are equal, or when the command begins with the rule text and a space.
  - Web page: a host name. It matches that host only. A rule for `example.com` does not match
    `www.example.com`.
  - Tool of a connection: the name of the connection and the name of a tool, or the name of the
    connection and "any tool".
- A step meets the rules in this order:
  1. A matching Deny rule refuses the step. This holds at every permission level, also at
     "Full access".
  2. Otherwise, a matching Allow rule lets the step run with no question. A step that a rule
     allows is still a step: its card shows in the chat, with the words "Allowed by a rule".
  3. Otherwise, the permission level decides, as before.
- A step that a Deny rule refuses does not run. Its card shows "Denied by a rule". The agent gets
  the refusal as a failed step. The turn goes on.
- A rule that the app cannot read does not allow or deny anything. A step that meets such a rule
  asks the user, also at "Full access". The rules page marks the rule "Cannot be read" and lets
  the user delete it.
- "Always allow for this agent" saves an Allow rule for that agent. The rule is not wider than the
  step on the card: the same command text, the same file path, the same host, or the same tool.
- The rules page is a part of the Permissions section of settings (see 013). It lists the rules,
  newest first. Each row shows the Allow or Deny tag, the face and name of the agent or "All
  agents", the step kind, the match text and the date. The user can filter by agent and by
  decision, add a rule, edit a rule, and delete a rule. The agent profile has a link that opens
  the page filtered to that agent.
- A new rule that is the same as one that exists (agent, kind, match text and decision) is refused
  with a short message. The match text holds 1 to 500 characters. A server holds at most 500
  rules.
- Deleting an agent deletes its rules. A rule for all agents stays.

## Action log

The action log lets the user see what the agents did, and why a step ran or did not run.

- One entry for each step of the four kinds in "Permission rules". An entry holds: the time, the
  agent, the step kind, a short target, who decided, and the result.
  - The target is a path, a command, a host, or the name of a connection and a tool. A target is
    cut at 200 characters. For a tool of a connection the target holds no arguments.
  - Who decided: the permission level, an Allow rule, a Deny rule, the user on a card, or "a rule
    that cannot be read" followed by the user.
  - The result: Ran, Failed, Refused, or Stopped.
  - An entry that a rule decided names the rule. The row opens the rules page on that rule. A rule
    that was deleted later shows its text, marked "Deleted".
- The log page is a part of the Permissions section of settings (see 013). It lists entries,
  newest first, and has filters for the agent, the result and the step kind, and a search of the
  target. A row opens the task of the step.
- The log is stored in the local database (see 014). The app keeps the entries of the last 90
  days, and at most 100000 entries. The oldest entries go first.
- Text in an entry that looks like a secret is hidden (see 014).
- Deleting an agent keeps its entries. They show the name that the agent had.

## Rules

- Risky steps: deleting files outside the workspace, commands that use the network to send data,
  installing software, anything that uses `sudo`, and every call of a tool of a connection (see
  018).
- An agent runtime from a vendor (see 006) uses the vendor's own permission prompts; the app shows
  them as approval cards.
- Browser data (cookies, logins) is kept per agent, on the computer. Duplicating an agent copies
  its saved browser session (see 002).
- The list of browser tabs is read again when the browser window gets the focus, and when a press
  fails on a tab that no longer exists.
- The "take control" card never stays after the user gives control back, after Stop, or after the
  turn ends. Stop works while the card shows.
- The app writes a browser log (see 014). It holds failed browser tool calls, each Stop request with
  its result, warnings of the browser, and input from the user's live view of the browser that the
  app dropped or refused, with the reason.
- A failed tool step shows its error in the card. It does not end the turn unless the agent
  stops.
- An approval card or a question card stays after an app restart when its task can wait through
  a restart (see 005). The card shows the same request as before, and it shows when the agent
  asked. Until the user answers, nothing runs. After the answer, the agent goes on in the same
  reply.
- A card from a vendor agent runtime cannot stay after a restart, because the runtime ends with
  the app. Its step is marked Failed and the card goes away.
- Stop on a task that waited through a restart works as before: the step is marked Failed and the
  card goes away.

## Acceptance

- Tell an agent in one chat that the project code name is "Falcon". In a new thread, ask what
  the code name is: the agent calls "search chats", a tool card "Searched past chats" shows, and
  the answer names "Falcon". Turn memory off for the agent: the tool is not offered.
- Ask an agent to search for a word that only a channel without that agent holds: it gets no hit.
- At "Ask for risky steps", `rm` of a file outside the workspace shows an approval card and does
  nothing until the user allows it.
- Stop during browser work closes the page work within 2 seconds.
- At "Ask for risky steps", `rm` of a file outside the workspace shows an approval card. Restart
  the app: the same card shows again and the file is still there. Allow: the file is deleted and
  the agent goes on in the same reply.
- An agent asks a question with two choices. Restart the app: the question shows again with the
  same choices. Pick one: the agent goes on with that answer.
- The main agent gets a request with two independent parts. It sends two messages in one turn.
  Both teammates start at once. The final answer names both teammates.
- Fast path with a fake decision model that answers at 0.9: a call presses a button in a test
  window and ends. With 0.5, the call returns the current controls and does not press. A password
  field is sent with no value.
- Focus the browser window after a tab was closed by hand: the tab list drops that tab.
- Choose "Always allow for this agent" on the card of a command. The rules page shows one Allow
  rule with that command. Run the same command again: no card shows a question, the card says
  "Allowed by a rule", and the log has two entries. Delete the rule: the next run asks again.
- Add a Deny rule for a folder, and set the agent to "Full access". A write inside the folder
  does not run. The card says "Denied by a rule", and the file does not change. The agent goes on.
- A Deny rule and an Allow rule both match a step: the step is refused.
- An Allow rule for `example.com` does not let the agent fetch `www.example.com`: that fetch asks.
- Add 500 rules: the 501st is refused.
- Filter the log by result "Refused": it lists only the steps that a Deny rule stopped. A row
  opens the rule that stopped the step.
- A target in the log never holds the arguments of a tool of a connection.
