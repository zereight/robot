# 037 Manage tools

## Purpose

The main agent, or a program outside ROBot, can make and change agents and routines, and make
workflows, with tools, as the user does in the app. Every change waits for the user. Nothing
changes until the user allows it.

## Concepts

- **Manage tools**: the tools in "Tools". Two kinds of caller have them:
  - the **main agent** (002), on every runtime (006);
  - an **outside program** (023) with the access "Read, send work and manage".

  No other agent has them. Another agent that needs a change asks the main agent or the user.
- **Change request**: one call of a manage tool that changes data. It holds the whole change. It
  has a number, the caller, the time, and a state: "Waits for the user", "Allowed", "Denied",
  "Expired" or "Failed". It does nothing until the user allows it.
- **Request card**: the card that shows a change request to the user, with "Allow" and "Deny".

## Flows

1. Ask: the caller calls a manage tool. The app checks the call with the same checks as the form
   of the user (names, limits, models). A call that fails a check gets the reason at once and makes
   no request.
2. Review: a request card shows. The user reads the full change, and taps "Allow" or "Deny".
3. Apply: "Allow" makes the change, and the request is "Allowed". The caller gets the result, for
   example the name of the new agent. "Deny" changes nothing, and the caller gets "Denied by the
   user."
4. Undo: after the change of an agent or a routine, the user can undo it, as in 002,
   "Changes from the chat". A change that makes something has no undo. The user archives the new
   thing, as for any other.
5. Outside program: the call returns at once with the request number and "Waits for the user".
   "Wait for a request" waits until the request ends or 10 minutes pass.
6. Main agent: the step waits in the turn, as a step that asks (007). The turn goes on after the
   answer.

## Tools

Reads (access "Read, send work and manage", and the main agent):

- **Read an agent**: for one agent that is not archived: the name, the role line, the
  instructions, the face, the model account, the model, the effort, and the section. It gives
  nothing else of the agent.
- **List routines**: for each routine: the number, the agent, the first 200 characters of the
  prompt, the trigger in words, the place, the state, and the next run.
- **Read a routine**: the whole prompt, the trigger, the place, the model, the effort and the
  state.
- **Wait for a request**: for outside programs only (flow 5). It gives the state and, when the
  request is "Allowed", the result.

Changes (each makes a change request, except "Pause a routine"):

- **Make an agent**: name, role line, instructions, face, model account, model, effort, section.
  The permission level, the workspace folder, the memory switch and every other field are the
  defaults of the form of a new agent (002). The tool cannot set them.
- **Make a workflow**: a name and, optionally, a list of steps in order (010, "Assistant"). The
  app joins the steps in a line. The workflow has the trigger "manual" and no owner. The tool
  cannot set a trigger, an owner, a condition or a place.
- **Change an agent**: for one agent that is not archived and is not the caller. The fields are
  the name, the role line, the instructions, the face (shape and hue), the model account, the
  model and the effort. A model named in loose words follows the rule of 002, "Changes from the
  chat".
- **Archive an agent**: the user restores it as in 002.
- **Make a routine**: agent, prompt, a schedule, the place of the results, model and effort. The
  routine starts paused, and it counts in the limit of 50 (009).
- **Change a routine**: the same fields. A routine with a watch (009) is refused with the reason.
- **Resume a routine**: its own request. The card shows the whole prompt and the next three run
  times. A routine does not run by itself before the user allows this.
- **Run a routine now**: its own request. The run is a task with the source "routine" (009).
- **Pause a routine**: makes no request. It only stops work, so it runs at once. Resume needs a
  request.

## States

- **Waits for the user**: the card shows on the computer, on a linked device and on the phone. It
  sends one notification of the kind "approval" (015).
- **Expired**: a request from an outside program that waits for 24 hours ends as "Expired". It
  changes nothing. The card goes.
- **Failed**: after "Allow", a check can fail now, for example the name is taken since the call.
  The request is "Failed" with the reason, and the caller gets the reason.
- **Read only**: the main agent at "Read only" gets "Refused: read only" for every change tool
  (007). The reads work.
- **Access off**: an outside program without the access "Read, send work and manage" gets
  "This access does not allow this tool." The switch "Allow outside programs" off gives the answer
  of 023.

## Rules

- **The user decides.** Every change tool except "Pause a routine" makes a request. This holds at
  every permission level, also "Full access". The card has "Allow" and "Deny" only. It has no
  "Always allow". No rule of 007 covers a manage step, an Allow rule does not open it, and a Deny
  rule is not needed because "Deny" is always there.
- **The card shows the whole change.** It shows the caller, the kind, and every new value in full,
  also a long instruction or prompt, in a field that scrolls. For a change it shows the old value
  and the new value of each field that changes. It never cuts a value.
- **No other fields.** No manage tool can change: a permission level, the rules (007), the
  workspace folder, computer use, the main agent switch, the memory switch, the connections and
  skills of an agent, saved secrets (020), sync, devices, the handbook (002), the memory check
  (008), the settings of the app, or the Teams link (028). No manage tool deletes anything, makes
  a watch (009), or changes a workflow that exists (010).
- **The main agent changes itself with its own tool.** "Change an agent" refuses the caller, with
  the reason "Use the settings tool for yourself." (002).
- **Outside content.** A request that comes from a turn that holds outside content shows the line
  "This turn holds outside content" and names the first source (007). A request from an outside
  program names the program, and it holds the program mark (007, 023).
- **Made by.** The profile of an agent and the form of a routine that a request made show the
  muted line "Made by <caller>". The line stays after later edits.
- **Limits.** One entry of an outside program holds at most 5 requests that wait. The sixth call
  gets "Too many open requests. Wait for the user." and makes no request. Calls count in the limit
  of 60 calls in one minute (023). A turn of the main agent holds one waiting request at a time.
- **Answer anywhere.** A linked device (012) can answer a request card only with the switch "Can
  create and change agents". The phone (011) can answer it.
- **Logs.** The log of outside programs (023) holds the kind, the number and the result of each
  request, and no text of the change. The action log (007) has an entry for each manage step of
  the main agent: the kind, the target, and the result "Allowed", "Denied" or "Refused". It holds
  no instruction text and no prompt.
- **Profiles and sync.** A request belongs to one profile (022) and to the computer that runs it. A
  waiting request stays across a restart. An allowed change syncs as any edit of the user does
  (019). Requests do not sync, and an export (014) holds none.
- **Limits of things.** The limits of the form hold: names, the 50 routines (009), and the limits
  of an agent file (002). A request that would pass a limit fails the check of flow 1.

## Surfaces

- Ways in: Settings, Outside programs, the access of an entry (023); for the main agent, a turn.
- Devices: the access is on the computer only (023). The card shows on the computer, a linked
  computer and the phone, and each can answer as said in "Rules". A second profile has its own
  requests.
- Runtimes: the main agent gets the tools on an API provider and on each vendor runtime (006). The
  app checks each call, so the rules hold on every runtime.
- Seeing the state: the card, the line "Made by", and the log of outside programs.
- Ways out: "Deny", Undo of a change, Archive of what a request made, a lower access on the entry,
  and the switch "Allow outside programs" off.

## Out of scope

- Delete of an agent or a routine.
- The fields in "Rules", "No other fields".
- Changes to a workflow that exists. Their tools are in 010, "Assistant".
- A watch routine.
- "Always allow" and rules for manage steps.
- A manage tool for any agent other than the main agent.
- MCP resources and prompts (023).

## Acceptance

- An outside program with "Read and send work" calls "Make an agent": it gets "This access does
  not allow this tool." No request exists.
- Set the access to "Read, send work and manage". "Make an agent" returns "Waits for the user" and a
  request number. A card shows with the full instructions and the name of the program. No agent
  exists yet.
- "Allow": the agent exists, its profile shows "Made by <program name>", and "Wait for a request"
  returns "Allowed" with the name of the agent.
- "Deny" on a request: no agent exists, and "Wait for a request" returns "Denied by the user."
- The same call at "Full access" in the turn of the main agent: the card still shows.
- The main agent at "Read only" calls "Make a routine": "Refused: read only", and no card shows.
- "Change an agent" with the caller as the target is refused with "Use the settings tool for
  yourself."
- "Change an agent" with the field "permission level" is refused. The tool has no such field.
- "Make a routine": the routine is paused and counts in the limit of 50. "Resume a routine" is a
  second request. Before it is allowed, the routine does not run.
- "Make a routine" with a watch is refused with the reason. At 50 routines the 51st is refused.
- "Pause a routine" makes no request and pauses the routine at once.
- Undo after "Change an agent": the old values return. When the agent changed again since, Undo is
  off with the reason "Changed again since".
- 6 waiting requests of one entry: the 6th call gets "Too many open requests. Wait for the user."
- A request that waits for 24 hours ends as "Expired" and changes nothing.
- After "Allow", the name is taken since the call: the request is "Failed" with the reason.
- The turn of the main agent holds outside content: the card shows "This turn holds outside
  content" with the source.
- A linked device without "Can create and change agents" cannot allow a request. The phone can.
- The action log holds the manage step with the result and holds no instruction text.
- Export the data: the archive holds no request.
- A second profile does not see the requests of the first.
