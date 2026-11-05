# 018 Connections

## Purpose

The user adds outside tools, such as a notes service or a search service, and the agents use them
as tools. Every use goes through the same approval and rule system as the built-in tools.

## Concepts

- **Connection**: a link to a tool provider that speaks MCP (Model Context Protocol, an open
  standard). It has a name, a kind, the settings of its kind, an on or off switch, and the agents
  that may use it ("All agents", or a list). The list can hold agents and organizations. An
  organization in the list has the value "On" or "Off", and it gives or takes away the connection
  for its members and for the members of its lower organizations (030, "Tools").
  - The name holds 1 to 40 characters. It is unique, and the check ignores case.
- **Kind**: one of three.
  - **Program on this computer**: the app starts a program. The settings are the command, a list
    of arguments, a working folder (the home folder by default) and environment values. Each
    environment value has a name, a value, and a switch "secret".
  - **Web address**: the app calls an address. The settings are the address and a list of headers.
    Each header has a name, a value, and a switch "secret". A header can hold an access token.
  - **Built-in**: a connection that the app makes by itself for one feature of the app. The user
    cannot add one, change its fields or remove it, and it has no command, no address and no
    secret. Its settings are the ones that its feature names, and its page is the part of settings
    of that feature. It is off at first, and the user turns it on and off like any other
    connection. There is one in this version: **Test devices** (032).
- **Tool**: one action that a connection offers. It has a name and a description that the
  connection gives. The user can turn off a single tool. A tool that is off is not given to any
  agent.
- **State**: Off, Not tested, Connected (with the number of tools), or Error (with the reason).
  Connected also tells how many tools need review. A built-in connection has no "Not tested": the
  state of its program is the state of its feature (032).
- **Reviewed tools**: the tools of a connection that the user has seen and accepted. For each tool,
  the app keeps its name, its description, the names and descriptions of its parameters, and its
  read-only mark.
- **Held tool**: a tool that the connection offers now and that is new, or that differs from its
  reviewed tool in any of those parts. No agent gets a held tool until the user accepts it. A
  connection can change a description after the user added it. A description is text that the
  model reads, so a changed description can carry an order.
- **Read-only mark**: a connection can mark a tool as one that only reads and changes nothing. MCP
  calls this a hint. The test list shows the mark beside the tool.
- **Trust read-only marks**: a switch of each connection, off by default. See "Rules". A built-in
  connection has no such switch, because the app holds its own class for each of its tools.
- **Tool search**: the way an agent finds the tools of its connections when it may use many of
  them. The agent gets one step, "Search tools", and not the tools. See "Many tools".

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
3. Use: an agent that may use the connection gets its tools in the next turn: all of them, or the
   step "Search tools" when it may use many (see "Many tools"). When the agent calls one, a tool
   card shows in the chat with the connection name and the tool name (see 003). The approval
   rules of 007 apply (see "Rules"). A built-in connection may add a short guide for agents to the
   turn (see "Built-in connections").
4. Turn off: a switch on the row. The connection stops, and its tools leave every agent from the
   next turn.
5. Edit: the user changes any field. A saved secret stays until the user types a new value or
   removes it. The page never shows a saved secret again. A built-in connection has no such fields;
   its feature holds the switch, the download and the guide. See "Built-in connections".
6. Remove: after a confirm. The saved secrets of the connection leave the keychain, and so do the
   rules for its tools (see 007). The action log keeps its entries. A built-in connection cannot be
   removed; the feature that owns it explains what its "Delete" does.
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
  started when the connection stops. A built-in connection may name other times (032).
- The program of a connection does not get the keys or tokens of the app. It gets only the
  environment values that the user wrote in the form, and the normal environment of the user. A
  built-in connection gets the values that the app sets for it, and its feature says which (032).
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
  always wins. A built-in connection follows the class of each of its tools instead, and a card of
  its steps offers no "Always allow" (see "Built-in connections").
- The action log shows the connection name and the tool name. It never shows the arguments.
- A call has a time limit of 60 seconds. At the limit the step fails with the reason "timed
  out". A result longer than 100000 characters is cut, and the agent is told that it was cut. A
  built-in connection may name another limit (032).
- Stop ends a running call within 2 seconds. The step shows as Stopped.
- The result of a tool is data from outside. The agent does not treat it as an order that
  overrides its own instructions or the rules of the app.
- An agent gets at most 100 tools of one connection. The page says so when a connection offers
  more.
- A server holds at most 20 connections. A built-in connection does not count, and the user cannot
  remove it. A built-in connection keeps its switch in the local database, and an import brings it
  back off like any other (014).
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
- A tool that the program gives to the panel only (see "Built-in connections") is not reviewed,
  because no agent gets it, and it is not in the count of "Many tools". When a later version offers
  that tool to an agent, it is a new tool and is held for review.

## Many tools

The model reads the definition of each tool at every request, also when the agent does not use the
tool. One connection can offer dozens of tools. So an agent that may use many tools finds the ones
it needs, and does not carry all of them.

- **Count**: the tools that an agent may use, from all of its connections that are on. A tool that
  is off does not count. A held tool (see "Tool review") does not count. A connection that is down
  does not count. The app counts at the start of each turn, when the connections start. The count
  does not change inside a turn: a change of the user counts from the next turn.
- Only tools of connections count. The tools of the app (files, shell, browser and the others)
  are not counted, and the agent always gets them.
- With 20 tools or fewer, the agent gets every tool at the start of the turn.
- With more than 20 tools, the agent gets no tool of a connection at the start of the turn. It
  gets one more step, "Search tools". The agent writes some words, and the step gives back the
  tools that match.
  - A tool matches when one of the words is in its name or in its description. The check ignores
    case. A tool that is off or held never matches.
  - The step gives at most 10 tools. The tools that match the most words come first. Tools with
    the same number of matches come in the order of the connection name, and then the tool name.
  - For each tool, the step gives the connection name, the tool name and the description.
  - When no tool matches, the step says "No tool found."
  - The text that tells the agent what the step does also says how many tools it may use and the
    names of its connections.
- A tool that the agent found is open to the agent for the rest of that turn. The next turn starts
  with none, and the agent searches again. A call of a tool that the agent did not find in this
  turn fails with "Unknown tool. Search for it first."
- A found tool is a tool as any other. The permission levels, the rules, the approval card, "Trust
  read-only marks", the action log and the limits of "Rules" apply with no change.
- The step "Search tools" changes nothing and sends nothing to a connection. It needs no approval,
  makes no entry in the action log, and gives no outside content (see 007). Its tool card reads
  "Searched tools" with the words and the number of tools found.
- The limit of 100 tools for one connection (see "Rules") applies before the count.
- The phone and a linked computer show the card of this step as any other tool card.
- There is no switch. The user keeps an agent at 20 tools or fewer by turning off tools or
  connections, or by limiting the agents of a connection.
- An agent on a vendor runtime has no connections (see "Rules"), so nothing changes for it.
- The search and the found tools are not stored. A sync, an export and a file of agents hold
  nothing of them.

## Built-in connections

A built-in connection serves one feature of the app. It uses the same tools, cards, review and
action log as any other connection, with these differences:

- **No form**: the user adds none, and the page of the connection is the part of settings of its
  feature. The switch of the feature is the switch of the connection.
- **Panel**: a built-in connection may show a panel: a surface that the program of the connection
  draws. The app shows it in a frame that has no right to reach anything by itself. The app names
  the addresses that the frame may reach, and it refuses every other request of the frame. The
  words and the layout of the panel are not words of the app, so they are not translated and the
  app does not draw them again.
- **Three groups of tools**: the program of a built-in connection says, for each of its tools, who
  may call it: the agent, the panel, or both.
  - **The agent only, or both**: a call by an agent is a device step, with the card, the level and
    the action log entry that 032 says.
  - **The panel only**: such a tool is never given to an agent and never counts in "Many tools". The
    frame calls it through the app. The app treats that call as the action of the user, because the
    user pressed a button of the panel: it makes no approval card and no entry in the action log. Its
    result goes to the frame only, and never to an agent.
  - **Both, called by the frame**: the same as the panel only. The user pressed a button of the
    panel, so the call is the action of the user. The agent's own calls of that tool are device
    steps.
  - The app ends the calls of a frame when the user closes it. A call of a panel-only tool has the
    time limit of the connection (032).
  - A frame never calls a tool that is for the agent only. The app refuses it, and the frame shows an
    error.
- **Class of a tool**: for a built-in connection the app holds a fixed list that puts each tool in
  one class: a read, a change, a risky change or an erase step. The cards, the permission levels
  and the action log follow that list, as 007 and 032 say. The read-only mark of the connection and
  the switch "Trust read-only marks" do not apply to a built-in connection, and its page shows
  neither.
- **Guide for agents**: a built-in connection may give a text that the app adds to the turn of an
  agent that may use it, after the instructions of the app and before the words of the user. The
  text is at most 20000 characters. It is text of the download and not outside content (007).
- **One call at a time**: a built-in connection may say that only one call runs at a time. See 032.
- **Time limit**: a built-in connection may name a limit other than 60 seconds. See 032.
- **Not stored with the others**: a built-in connection has no secret and no reviewed tool of its
  own until the program of its feature arrives. Its tools come from that program, so a new version
  holds them for review as any new tool (see "Tool review").

## Out of scope

- A row on the Today page (021) or a notice for held tools.
- A sign-in through a browser window for a connection. The user can put an access token in a
  header instead.
- A catalogue of ready connections, or a download of connection programs. A built-in connection may
  download the program of its own feature (032); the app decides that from the feature, and it
  offers no other download.
- Connections for agents that use a vendor runtime.
- Connections that the agent adds by itself.
- Resources and prompts that a connection may offer. Only tools are used. A panel of a built-in
  connection (see "Built-in connections") is the one surface that the app shows, and it is not a
  resource of this kind: the app draws it in a frame of its own and gives the frame no other
  address.

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
- An agent has one connection of 20 tools: its first request holds all 20 tools and no step
  "Search tools". Add a 21st tool to the test program and start a new turn: the first request holds
  none of the 21 tools and holds the step "Search tools". Turn off one tool: the next turn holds all
  20 again.
- With 25 tools, the agent searches "weather": the step gives the tools that have the word in the
  name or the description, at most 10, with the most matches first. The agent calls one of them: an
  approval card shows at "Ask for risky steps" as for any tool, and the log has one entry for the
  call and none for the search.
- The agent searches words that match no tool: the step says "No tool found." The agent calls a tool
  that it did not find: the step fails with "Unknown tool. Search for it first." and the connection
  gets no call.
- The agent finds a tool in one turn. In the next turn the agent calls it without a search: the
  call fails with the same text.
- Two connections have 15 tools each, and one of them is turned off: the agent gets all 15 tools of
  the other connection and no search step.
- A Deny rule for "any tool" of the connection: a found tool is refused with "Denied by a rule".
- An agent has 21 tools and one of them is held for review: the count is 20, so the agent gets all
  20 tools and no search step. Accept the held tool: the next turn holds the step "Search tools"
  and none of the 21 tools. The search never finds a held tool.

## Acceptance of a built-in connection

- A built-in connection shows in no form of the Connections page. Its part of settings shows its
  switch, and the switch turns its tools off in the next turn.
- A built-in connection with a panel shows the panel in a frame. A test that logs the requests of
  the whole Mac shows that the frame reached no address other than the ones that the app named.
- Press a button of the panel that starts a simulator: the step runs with no card, the action log
  has no entry for it, and the next device step of an agent shows it in its snapshot.
- A frame that calls a tool of the agent is refused, and the frame shows an error; no card shows.
- The list of the classes of the tools of a built-in connection names every tool of the version
  that the user downloaded. A tool of a newer version that the list does not name is a risky change.
- A guide for agents shows once in a turn, after the instructions of the app and before the words
  of the user. It is not outside content.
