# 037 Manage tools

## Purpose

The responsible document of a workflow, or a program outside ROBot, can make a new workflow with
tools, as the user does in the app. Every change waits for the user. Nothing changes until the user
allows it. The manage tools are tools for workflows only.

## Concepts

- **Manage tools**: the tools in "Tools". Two kinds of caller have them:
  - the **responsible document** of a workflow (002, 010), in a turn of the chat that the user
    started (003), on every runtime (006);
  - an **outside program** (023) with the access "Read, send work and manage".
- **Change request**: one call of a manage tool that changes data. It holds the whole change. It
  has a number, the caller, the time, and a state: "Waits for the user", "Allowed", "Denied",
  "Expired" or "Failed". It does nothing until the user allows it.
- **Request card**: the card that shows a change request to the user, with "Allow" and "Deny".

The tools of 010, "Assistant", change the open workflow and run one. They are not manage tools. The
reads below ("List workflows" and "Read a workflow") are the reads that 010 gives to the responsible
document.

## Flows

1. Ask: the caller calls a manage tool. The app checks the call with the same checks as the editor
   of the user (names, limits, models, the rules of the graph, the check of 010). A call that fails
   a check gets the reason at once and makes no request.
2. Review: a request card shows. The user reads the full change, and taps "Allow" or "Deny".
3. Apply: "Allow" makes the change, and the request is "Allowed". The caller gets the result, for
   example the name of the new workflow. "Deny" changes nothing, and the caller gets "Denied by the
   user."
4. Undo: a change that makes a workflow has no undo. The user deletes the new workflow as any other
   workflow, with the danger button that asks first (000).
5. Outside program: the call returns at once with the request number and "Waits for the user".
   "Wait for a request" waits until the request ends or 10 minutes pass.
6. Responsible document: the step waits in the turn, as a step that asks (007). The turn goes on
   after the answer.

## Tools

Reads (access "Read, send work and manage", and the responsible document):

- **List workflows**: for each workflow: the name, the state of the last run, the state of the
  check, and the number of nodes.
- **Read a workflow**: the name, the nodes with their numbers and their prompts, the connections,
  the trigger in words, and the responsible document. It gives no memory, no run result, no chat
  and no secret.
- **Wait for a request**: for outside programs only (flow 5). It gives the state and, when the
  request is "Allowed", the result.

Change (it makes a change request):

- **Make a workflow**: a name and, optionally, a list of text nodes in order. Each text node has a
  name and a prompt, and can have a provider, a model and a reasoning level that the account of the
  node offers (006). The app joins the nodes in a line. The workflow gets the default text of the
  responsible document, an empty folder in the default workspace folder (013), and the default
  permission level (010, "Folder and permission level"). It has the trigger "manual". The tool
  cannot set a decision node, a schedule, a web hook, the responsible document, the folder or a
  permission level.

## States

- **Waits for the user**: the card shows on the computer, on a linked device and on the phone. It
  sends one notification of the kind "approval" (015).
- **Expired**: a request from an outside program that waits for 24 hours ends as "Expired". It
  changes nothing. The card goes.
- **Failed**: after "Allow", a check can fail now, for example the name is taken since the call.
  The request is "Failed" with the reason, and the caller gets the reason.
- **Read only**: a responsible document that works at the permission level "Read only" (007) gets
  "Refused: read only" for every change tool. The reads work.
- **Access off**: an outside program without the access "Read, send work and manage" gets "This
  access does not allow this tool." The switch "Allow outside programs" off gives the answer of
  023.

## Rules

- **The user decides.** Every change tool makes a request. This holds at every permission level,
  also "Full access". The card has "Allow" and "Deny" only. It has no "Always allow". No rule of
  007 covers a manage step, an Allow rule does not open it, and a Deny rule is not needed because
  "Deny" is always there.
- **The card shows the whole change.** It shows the caller, the kind, and every new value in full,
  also a long prompt, in a field that scrolls. It never cuts a value.
- **No other fields.** No manage tool can change: the text of the responsible document (002), a
  permission level, the rules (007), the folder of a workflow, computer use, the memory of a
  workflow (008), connections and skills (017, 018), saved secrets (020), sync, devices, the
  settings of the app, or the Teams link (028). No manage tool deletes anything, or changes a
  workflow that exists (010).
- **Outside content.** A request that comes from a turn that holds outside content shows the line
  "This turn holds outside content" and names the first source (007). A request from an outside
  program names the program, and it holds the program mark (007, 023).
- **Made by.** The workflow view and the card of a workflow that a request made show the muted line
  "Made by <caller>". The line stays after later edits.
- **Limits.** One entry of an outside program holds at most 5 requests that wait. The sixth call
  gets "Too many open requests. Wait for the user." and makes no request. Calls count in the limit
  of 60 calls in one minute (023). A turn of the responsible document holds one waiting request at
  a time.
- **Answer anywhere.** A linked device (012) can answer a request card only when the user lets it
  change workflows (012). The phone (011) can answer it.
- **Logs.** The log of outside programs (023) holds the kind, the number and the result of each
  request, and no text of the change. The action log (007) has an entry for each manage step of the
  responsible document: the kind, the target, and the result "Allowed", "Denied" or "Refused". It
  holds no prompt text.
- **Profiles and sync.** A request belongs to one profile (022) and to the computer that runs it. A
  waiting request stays across a restart. An allowed change syncs as any edit of the user does
  (019). Requests do not sync, and an export (014) holds none.
- **Limits of things.** The limits of the editor hold: names, the 30 nodes of a workflow and the
  other rules of the graph (010). A request that would pass a limit fails the check of flow 1.

## Surfaces

- Ways in: Settings, Outside programs, the access of an entry (023); for the responsible document,
  a turn in the chat.
- Devices: the access is on the computer only (023). The card shows on the computer, a linked
  computer and the phone, and each can answer as said in "Rules". A second profile has its own
  requests.
- Runtimes: the responsible document gets the tools on an API provider and on each vendor runtime
  (006). The app checks each call, so the rules hold on every runtime.
- Seeing the state: the card, the line "Made by", and the log of outside programs.
- Ways out: "Deny", Delete of what a request made, a lower access on the entry, and the switch
  "Allow outside programs" off.

## Out of scope

- A tool that makes a routine. A routine is a trigger of a workflow (010).
- Delete of a workflow.
- The fields in "Rules", "No other fields".
- Changes to a workflow that exists. Their tools are in 010, "Assistant".
- A schedule, a web hook and any other trigger. The rules of the trigger are not decided (see the
  questions for 010).
- A tool that starts a run (see the questions for 037).
- "Always allow" and rules for manage steps.
- MCP resources and prompts (023).

## Acceptance

- An outside program with "Read and send work" calls "Make a workflow": it gets "This access does
  not allow this tool." No request exists.
- Set the access to "Read, send work and manage". "Make a workflow" returns "Waits for the user"
  and a request number. A card shows with the full name, every node and every prompt, and the name
  of the program. No workflow exists yet.
- "Allow": the workflow exists, with the default text of the responsible document and an empty
  folder. The workflow view shows "Made by <program name>", and "Wait for a request" returns
  "Allowed" with the name of the workflow.
- "Deny" on a request: no workflow exists, and "Wait for a request" returns "Denied by the user."
- The same call at "Full access" in the turn of the responsible document: the card still shows.
- A responsible document at "Read only" calls "Make a workflow": "Refused: read only", and no card
  shows.
- "Make a workflow" with a node that sets a model that its account does not offer is refused with
  the reason. A call with 31 nodes is refused.
- "Make a workflow" with a field "permission level" or "folder": the call is refused. The tool has
  no such field.
- "Make a workflow" with a schedule: the call is refused. The tool has no such field.
- "List workflows" and "Read a workflow" give the fields in "Tools" and no memory, no run result and
  no secret.
- 6 waiting requests of one entry: the 6th call gets "Too many open requests. Wait for the user."
- A request that waits for 24 hours ends as "Expired" and changes nothing.
- After "Allow", the name is taken since the call: the request is "Failed" with the reason.
- The turn of the responsible document holds outside content: the card shows "This turn holds
  outside content" with the source.
- A linked device that the user did not let change workflows cannot allow a request. The phone can.
- The action log holds the manage step with the result and holds no prompt text.
- Export the data: the archive holds no request.
- A second profile does not see the requests of the first.
