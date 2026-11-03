# 018 Connections

## Purpose

The user adds outside tools, such as a notes service or a search service, and the agents use them
as tools. Every use goes through the same approval and rule system as the built-in tools.

## Concepts

- **Connection**: a link to a tool provider that speaks MCP (Model Context Protocol, an open
  standard). It has a name, a kind, the settings of its kind, an on or off switch, and the agents
  that may use it ("All agents", or a list).
  - The name holds 1 to 40 characters. It is unique, and the check ignores case.
- **Kind**: one of two.
  - **Program on this computer**: the app starts a program. The settings are the command, a list
    of arguments, a working folder (the home folder by default) and environment values. Each
    environment value has a name, a value, and a switch "secret".
  - **Web address**: the app calls an address. The settings are the address and a list of headers.
    Each header has a name, a value, and a switch "secret". A header can hold an access token.
- **Tool**: one action that a connection offers. It has a name and a description that the
  connection gives. The user can turn off a single tool. A tool that is off is not given to any
  agent.
- **State**: Off, Not tested, Connected (with the number of tools), or Error (with the reason).
  Connected also tells how many tools need review.
- **Reviewed tools**: the tools of a connection that the user has seen and accepted. For each tool,
  the app keeps its name, its description, the names and descriptions of its parameters, and its
  read-only mark.
- **Held tool**: a tool that the connection offers now and that is new, or that differs from its
  reviewed tool in any of those parts. No agent gets a held tool until the user accepts it. A
  connection can change a description after the user added it. A description is text that the
  model reads, so a changed description can carry an order.
- **Read-only mark**: a connection can mark a tool as one that only reads and changes nothing. MCP
  calls this a hint. The test list shows the mark beside the tool.
- **Trust read-only marks**: a switch of each connection, off by default. See "Rules".

## Flows

1. Add: in settings, Connections, the user picks "Add connection", chooses a kind, fills the form
   and saves.
   - For the kind "Program on this computer", the form shows the full command line. It says
     that the program runs on this computer with the rights of the user, and that the app cannot
     see what it does. The user must confirm to save.
2. Test: the "Test" button connects once and shows the tools (name and description), or the
   reason of the failure: program not found, program ended, no answer in 20 seconds, address
   refused, sign-in refused, or an answer that is not valid. When the user saves the form after a
   Test of that same form worked, the tools that the Test showed are the reviewed tools.
3. Use: an agent that may use the connection sees its tools in the next turn. When the agent
   calls one, a tool card shows in the chat with the connection name and the tool name (see 003).
   The approval rules of 007 apply (see "Rules").
4. Turn off: a switch on the row. The connection stops, and its tools leave every agent from the
   next turn.
5. Edit: the user changes any field. A saved secret stays until the user types a new value or
   removes it. The page never shows a saved secret again.
6. Remove: after a confirm. The saved secrets of the connection leave the keychain, and so do the
   rules for its tools (see 007). The action log keeps its entries.
7. Review: the row of a connection with held tools shows "N tools need review" and the button
   "Review". The dialog lists each held tool with the tag "New" or "Changed". For a changed tool,
   it shows the old text and the new text of the description and of the parameters, and tells
   whether the read-only mark changed. Each tool has the button "Accept". The dialog also has
   "Accept all" and "Close". "Close" keeps the tools held. An accepted tool is a reviewed tool with
   its new text, and agents get it from the next turn.

## States

- No connections: the page shows one muted line that says what a connection is, and the
  "Add connection" button.
- A connection is down when a turn starts: the turn goes on without its tools. The chat shows one
  muted line, "The connection NAME is not available.", for that turn.
- A connection is down in the middle of a call: the step fails with the reason, and the turn goes
  on.
- A connection has held tools when a turn starts: the turn goes on without them. The chat shows
  one muted line, "Tools of the connection NAME wait for your review.", for that turn.

## Rules

- Only agents whose model comes from an API provider (see 006) can use connections. An agent that
  uses a vendor runtime does not get them in this version.
- A connection starts when a turn first needs its tools. It stays until it is idle for 10
  minutes, until the user turns it off, or until the app ends. The app ends a program that it
  started when the connection stops.
- The program of a connection does not get the keys or tokens of the app. It gets only the
  environment values that the user wrote in the form, and the normal environment of the user.
- The address of a web connection uses https. An address on this computer (host `127.0.0.1`,
  `localhost` or `::1`) may use http. An address has no sign-in part. The app does not follow a
  redirect to another host.
- Secret values are in the system keychain (see 014). They are not in the database, the logs, the
  export, or the action log.
- With "Trust read-only marks" on, a call of a tool with the read-only mark is not a risky step.
  It runs with no card at "Ask for risky steps" and at "Ask when unsure", and its tool card shows
  "Read only, as the connection says". At "Ask for everything" it still asks. At "Read only" it is
  still refused, because the app cannot check the mark. The switch text says that the connection
  sets the mark, that the app cannot check it, and that the arguments of the agent still go to
  the connection.
- In a turn that holds outside content (007), a call of a tool with the mark is a risky step
  again. Outside text can make the agent put data in the arguments.
- The app reads the tools and their marks when the connection starts. A change of a mark counts
  from the next start of the connection, and only after the user accepts the tool (see "Tool
  review").
- The result of a tool with the read-only mark is still outside content (007).
- Every other step of a tool of a connection is a risky step (see 007). At "Ask for risky steps" it
  asks, unless an Allow rule matches. The approval card shows the connection name, the tool name
  and the arguments that the agent wrote. "Always allow for this agent" saves a rule for that one
  tool. The user can write a rule for "any tool" of a connection in the rules page. A Deny rule
  always wins.
- The action log shows the connection name and the tool name. It never shows the arguments.
- A call has a time limit of 60 seconds. At the limit the step fails with the reason "timed
  out". A result longer than 100000 characters is cut, and the agent is told that it was cut.
- Stop ends a running call within 2 seconds. The step shows as Stopped.
- The result of a tool is data from outside. The agent does not treat it as an order that
  overrides its own instructions or the rules of the app.
- An agent gets at most 100 tools of one connection. The page says so when a connection offers
  more.
- A server holds at most 20 connections.
- Connections are stored in the local database, without their secret values. An import brings
  every connection back turned off (see 014), with its secret values missing.
- The phone shows and answers approval cards for these tools as for any other tool (see 011). It
  does not add or edit connections.

### Tool review

- When a connection starts, the app compares the tools that it offers with the reviewed tools. It
  compares each text up to 20000 characters, after it removes spaces at both ends. A tool that
  differs is held. A tool that is reviewed and that the connection no longer offers leaves the
  reviewed tools. When it comes back, it is a new tool.
- A connection with no reviewed tools holds all its tools at its first start. This is the case for
  a connection that the user saved with no Test, and for a connection that an import brought back.
- The reviewed tools are cleared when the user changes how the app reaches the server: the command,
  the arguments, the working folder, the environment values, the address or the headers. A change
  of the name or of a switch does not clear them.
- A connection that exists before this rule keeps its tools: the tools that it offers at its first
  start after the update are its reviewed tools.
- A held tool has no read-only mark. Rules for a tool (007) stay as they are, and they count again
  when the user accepts the tool.
- The reviewed tools are stored with the connection in the local database. An export holds none of
  them.
- Only the computer shows the review. A linked device (012) and the phone (011) cannot review.
  Connections do not sync (019).

## Out of scope

- A row on the Today page (021) or a notice for held tools.
- A sign-in through a browser window for a connection. The user can put an access token in a
  header instead.
- A catalogue of ready connections, or a download of connection programs.
- Connections for agents that use a vendor runtime.
- Connections that the agent adds by itself.
- Resources and prompts that a connection may offer. Only tools are used.

## Acceptance

All checks use a small test program as the connection, written for the test.

- Add the test program as a connection and press Test: the page shows its tool names. Turn off
  one tool: an agent in the next turn does not see it.
- At "Ask for risky steps", an agent calls a tool: an approval card shows. Choose "Always allow
  for this agent": the rules page shows one Allow rule for that tool. A second call runs with no
  question and the log has two entries.
- Add a Deny rule for "any tool" of the connection, and set the agent to "Full access": a call
  is refused and the card says "Denied by a rule".
- A tool that never answers: the step fails after 60 seconds with "timed out". Press Stop during
  a call: the step shows Stopped within 2 seconds.
- A tool returns 200000 characters: the agent gets 100000 and a note that the result was cut.
- Add a secret environment value, reload the page: it shows "saved" and not the value. The
  database file, the logs and an export hold no clear text of it.
- Remove the test program from the disk and start a turn: the chat shows "The connection NAME is
  not available." and the turn goes on.
- Type the address `http://example.com` for a web connection: the form refuses it. Type
  `http://127.0.0.1:9000`: the form accepts it.
- Export, then import into an empty app: the connection shows, it is Off, and its secret value is
  missing.
- Add 20 connections: the form for the 21st refuses to save.
- A connection marks the tool "search" as read only. With "Trust read-only marks" off, a call at
  "Ask for risky steps" asks. Turn it on: the call runs with no card, and the tool card shows "Read
  only, as the connection says". At "Ask for everything" it still asks.
- With "Trust read-only marks" on, the agent fetches a page and then calls "search": the call asks.
- Add the test program, press Test, and save. Change the description of one tool in the test
  program, and start a turn that needs the connection. The connection starts, the row shows "1 tool
  needs review", the agent does not see that tool, the other tools work, and the chat shows "Tools
  of the connection NAME wait for your review." Press "Review": the dialog shows the old and the new
  description. Press "Accept": the next turn gets the tool with the new description.
- The test program offers a new tool after a restart: the tool is held with the tag "New".
- Save a connection with no Test, and start a turn: all its tools are held.
- Change the command of a connection that has reviewed tools: the reviewed tools are cleared, and
  the next start holds all tools.
- A tool changes its read-only mark from off to on: the tool is held, and the agent does not get it
  until the user accepts it.
- Export, then import into an empty app, then turn the connection on: the connection has no
  reviewed tools, and all its tools are held at the first start.
