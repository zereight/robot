# 007 Agent workspace and tools

## Purpose

Each agent works in its own folder with real tools, and the user stays in control of risky steps.

## Concepts

- **Workspace**: a folder per agent, under a ROBot folder in the user's home by default
  (`~/ROBot Agents/<agent name>`). The user can point an agent at another folder, such as an
  existing project.
- **Tools**: read and write files, run shell commands, search, fetch web pages, drive a browser
  window, ask the user a question, message other agents, read and run workflows (see 010), and
  use the computer (see "Computer use").
- **Permission level** per agent: "Ask for everything", "Ask for risky steps" (default), or
  "Full access". A linked device (012) can make the level stricter, never looser.

## Flows

1. The user opens the workspace from the agent profile; the app shows it in the system file
   browser.
2. When a step needs permission, the chat shows an approval card: what the agent wants to do, the
   command or path, and Allow once, Always allow for this agent, Deny.
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

## Rules

- Risky steps: deleting files outside the workspace, commands that use the network to send data,
  installing software, and anything that uses `sudo`.
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
