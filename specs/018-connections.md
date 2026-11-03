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
   refused, sign-in refused, or an answer that is not valid.
3. Use: an agent that may use the connection sees its tools in the next turn. When the agent
   calls one, a tool card shows in the chat with the connection name and the tool name (see 003).
   The approval rules of 007 apply (see "Rules").
4. Turn off: a switch on the row. The connection stops, and its tools leave every agent from the
   next turn.
5. Edit: the user changes any field. A saved secret stays until the user types a new value or
   removes it. The page never shows a saved secret again.
6. Remove: after a confirm. The saved secrets of the connection leave the keychain, and so do the
   rules for its tools (see 007). The action log keeps its entries.

## States

- No connections: the page shows one muted line that says what a connection is, and the
  "Add connection" button.
- A connection is down when a turn starts: the turn goes on without its tools. The chat shows one
  muted line, "The connection NAME is not available.", for that turn.
- A connection is down in the middle of a call: the step fails with the reason, and the turn goes
  on.

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
  sets the mark and the app cannot check it. A change of the mark after a test counts at the next
  turn.
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

## Out of scope

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
