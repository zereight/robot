# 007 Agent workspace and tools

## Purpose

Each agent works in its own folder with real tools, and the user stays in control of risky steps.

## Concepts

- **Workspace**: a folder per agent, under a ROBot folder in the user's home by default
  (`~/ROBot Agents/<agent name>`). The user can point an agent at another folder, such as an
  existing project.
- **Tools**: read and write files, run shell commands, search, fetch web pages, drive a browser
  window, and ask the user a question.
- **Permission level** per agent: "Ask for everything", "Ask for risky steps" (default), or
  "Full access".

## Flows

1. The user opens the workspace from the agent profile; the app shows it in the system file
   browser.
2. When a step needs permission, the chat shows an approval card: what the agent wants to do, the
   command or path, and Allow once, Always allow for this agent, Deny.
3. The agent asks a question: a question card shows with the choices or a text field. The task
   waits.
4. Browser: the agent can open a browser window that the user can watch. The user can take
   control, then give it back. Stop ends the browser work at once.

## Rules

- Risky steps: deleting files outside the workspace, commands that use the network to send data,
  installing software, and anything that uses `sudo`.
- An agent runtime from a vendor (see 006) uses the vendor's own permission prompts; the app shows
  them as approval cards.
- Browser data (cookies, logins) is kept per agent, on the computer.
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
