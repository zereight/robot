# 029 Org chart

## Purpose

The user opens one page and sees how the agents are organized: who is the main agent, which agents
work together in which channel, which channel sits inside which, who leads, who handed work to
whom, and what each agent does now. The user can also change the teams on the chart: members, the
lead and the parent channel (see "Edit on the chart" and 030).

## Concepts

- **Org chart**: a page of the window. The page button "Org chart" opens it (see 001). Each profile
  (022) has its own chart. The chart draws agents, channels and tasks that already exist. It stores
  no data of its own.
- **Root**: the top node. It is the main agent (002). When no agent is the main agent, or the main
  agent is archived, the root is the node "You", with a person icon and no profile.
- **Channel node**: one node for each channel (004) that is not archived and has at least one member
  that is not archived, or that has a lower channel (030) with a channel node. It shows the name of
  the channel, its picture, the number of its members,
  and the number of members in each state (see "Channel node").
- **Channel node "No channel"**: one more channel node, last. It holds every agent that is not
  archived and is in no channel node. With no such agent, it is not drawn.
- **Agent node**: a face, the name, the role line (one line, cut with "…"), and the state of the
  agent (idle, working, waiting for the user, or offline; see 002). A working agent also shows the
  label of its task (see "Live state").
- **Copy**: an agent that is a member of two or more channels has one node in each of their channel
  nodes. The root is the main agent, so the main agent also has a copy in each channel node where it
  is a member.
- **Home node**: the one node of an agent that the hand-off lines use. For the main agent it is the
  root. For any other agent it is the copy in the first channel node in which it appears. Channel
  nodes are in the order of "Order" below.
- **Lead mark**: a small mark "Lead" on the node of the lead of a channel. A lead that is archived
  counts as no lead (004).
- **Lead line**: a solid line with an arrowhead from the lead of a channel to each other member of
  that channel. It means: this agent gives parts to that one (004).
- **Hand-off**: a task that one agent made for another agent with the tool "send message" (007), in
  the last 7 days. The reply that comes back to the sender is not a hand-off. A send that failed
  (007) made no task and is not counted. The sender is the agent of the task that sent it.
- **Hand-off line**: a dashed line with an arrowhead from the home node of the sender to the home
  node of the receiver. A number on it gives how many hand-offs went that way. A line has one
  direction. When both agents handed work to each other, the chart draws two lines.
- **Structure line**: a thin, muted line with no arrowhead from the root to a top channel node, from
  a channel node to the channel nodes of its sub-channels (030), and from a channel node to its
  lead, or to its members when it has no lead. It has no meaning besides "belongs to".

## The page

- A header line: the title "Org chart", and a small legend that names the three kinds of line:
  "Gives parts" (lead line), "Handed work in the last 7 days" (hand-off line), and "Belongs to"
  (structure line). With the hand-off rule "Along the channels" (030), the legend ends with the
  muted line "Hand-offs follow the channels."
- Below, the canvas. The root is at the top. The top channel nodes sit in rows under it. The channel
  nodes of sub-channels sit under the channel node of their parent, one level lower. The agents of
  a channel node sit under the channel node. In a channel node with a lead, the lead sits first and
  the other members sit under the lead.
- Controls at the bottom right: zoom in, zoom out, and "Fit to view". Dragging the empty canvas
  moves the view. The wheel and a pinch on a trackpad zoom. "Fit to view" frames all nodes with room
  around them, so that no node sits under the controls.
- When the page opens, it fits to the view.
- Pointing at a node, or putting the focus on it, dims every node and line that is not linked to it.
  The linked ones are: its lines, the nodes at the other end of those lines, and its copies. Moving
  away clears the dim.
- A click on an agent node opens the profile of that agent (002). A click on a channel node opens
  the channel (004). A click on the root opens the profile of the main agent. The node "You" does
  nothing. A click on a line does nothing.
- Pointing at a hand-off line shows the text "<sender> handed <n> tasks to <receiver> in the last 7
  days."
- A node stays where the layout puts it. A drag (see "Edit on the chart") changes the data, and the
  layout then puts the node in its new place.

### Edit on the chart

The chart changes members, the lead and the parent channel. These are the same changes as in the
channel settings (004, 030), with the same rules.

- **Menu of an agent node**: a right-click, the menu key, or the "…" button that shows on a
  focused or pointed node opens it. It holds:
  - "Open profile".
  - "Make lead of <channel>", or "Remove as lead" on a lead. Not in "No channel".
  - "Add to channel…": a list of the channels that are not archived and where the agent is no
    member.
  - "Move to channel…": the same list. The agent leaves this channel and joins the picked one. Not
    in "No channel": there it is "Add to channel…" only.
  - "Remove from <channel>". Not in "No channel".
- **Menu of the root**: "Open profile". The node "You" has no menu.
- **Menu of a channel node**: "Open channel", "Add member…" (a list of agents that are not
  archived and not members), "New agent in this channel" (the form of 002; after save the agent is a
  member), "Put under…" (a list of the channels that the tree allows, see 030), "Move to the top"
  (only on a sub-channel), and "Channel settings". The node "No channel" has "New agent" only.
- **Drag**: the user drags an agent node and drops it on a channel node: the agent moves to that
  channel, as "Move to channel…". With Option held, the agent is added and stays where it was, as
  "Add to channel…". Dropped on "No channel": the agent is removed from the channel it came from.
  The user drags a channel node and drops it on another channel node: it is put under it, as "Put
  under…". Dropped on the root: it moves to the top. During a drag, a node where a drop is allowed
  shows a ring. A node where it is not allowed shows no ring, and a drop there changes nothing. A
  drop on the empty canvas changes nothing. Escape ends a drag with no change.
- A drag never moves the view by itself. The layout does not change during a drag. When the
  pointer comes within 40 px of an edge of the canvas, the view moves in that direction while the
  pointer stays there.
- During the drag of an agent node that is in a channel, a drop area "No channel" shows at the
  bottom left of the canvas, over the canvas and above the controls of the view. It is not a node
  of the layout, and it stays in place when the view moves. A drop on it does what a drop on the
  channel node "No channel" does. When the channel node "No channel" is drawn, it takes the drop
  too. The area goes when the drag ends.
- **Refusals**: a change that the rules of 004 or 030 do not allow is refused with a short line at
  the bottom of the canvas. A member that works cannot leave its channel: "<agent> works in
  <channel>. Wait for its part to end, or stop it." A tree that breaks the rules of 030 gives the
  reason of 030.
- A move of the lead out of its channel leaves that channel with no lead.
- "New agent in this channel" and "New agent": after the save the chart stays open, and the focus
  goes to the node of the new agent in that channel. When the agent is made but cannot join the
  channel, the refusal line gives the reason, and the focus goes to its node in "No channel". The
  profile does not open.
- **Lines at the bottom**: one line shows at a time. A new line takes the place of the line that
  shows. A refusal line shows for 10 seconds and has no "Undo".
- **Undo**: each change shows the line "<what changed>." with "Undo" at the bottom of the canvas for
  10 seconds. After an Undo, the line "Undone." shows for 3 seconds. Undo puts back the
  members, the lead and the parent channel as they were before that
  change. Undo is refused with a reason when the change cannot go back, for example when the agent
  works now in the new channel. Cmd+Z does the same while the line shows.
- No change on the chart needs a confirm. The chart cannot archive, delete or rename an agent or a
  channel.
- Each change is the same change as in the settings: it syncs (019), the activity panel and the
  place list show it, and the chart shows it within 1 second. The view and the zoom stay.

### Channel node

- The header of a channel node shows the picture and the name of the channel and the number of
  members. Beside it, a small count for each state that at least one member has, in this order:
  working, waiting for you, idle, offline. For example "2 working · 3 idle".
- A channel node draws at most 12 agent nodes: the lead first, then the other members by name,
  ignoring case. When there are more, the last tile reads "+<n> more". A click on it lists the other
  members, with face, name and state. A click on a row opens the profile.
- The members that are not drawn have no line. A hand-off from or to an agent whose home node is not
  drawn is not drawn.

### Order

- Channel nodes on one level under one parent are in the order of the channel names, ignoring case.
  A tie goes by the time the channel was made, the older first. A sub-channel follows the agents of
  its parent in the order of the page. The channel node "No channel" is last. The order does not
  depend on the sections of the place list (001), because those belong to one computer.
- Inside "No channel", agents are in the order of their names, ignoring case.

### Live state

- The state of an agent is the state of 002. A working agent shows the label of the task that runs
  now, in one line of at most 90 characters, cut with "…". It never shows the thinking of the agent,
  a message, or the content of a file. A task that waits for the user shows the state "waiting for
  the user" and the label.
- The page changes within 1 second after something changes: a state, a task, a member, a lead, a
  channel that is made or archived, an agent that is made, archived or renamed. The user does not
  reload the page. The count on a hand-off line grows when a new hand-off starts. A hand-off leaves
  the count 7 days after its task was made. The page shows this within 1 minute.
- A change of the page keeps the zoom and the view of the user. Only "Fit to view" and a new open of
  the page frame the nodes again.

### Layout

- The app computes the positions. The result must not depend on an animation.
- No face, name, role line, task label, header, count or tile covers another. No line passes through
  a node. This holds with the setting "reduce motion" on and off (013), with 1 agent, 6 agents and
  40 agents, with a channel node of 12 agents, and with 20 channel nodes.
- Channel nodes that do not fit in one row go to the next row. A row is at most 1,600 px wide at
  zoom 100%.
- The same data gives the same layout, also on two computers (019).
- Hand-off lines: when there are more than 40, the chart draws the 40 with the highest count. A tie
  goes to the line with the newest hand-off. Then the legend ends with the muted line "Showing the
  40 busiest hand-offs."

### Empty and small states

- No agent that is not archived: no canvas. One muted line "No agents yet." and the button "New
  agent" (002).
- Agents but no channel: the root, and the channel node "No channel" with all agents.
- One agent: the root and one channel node. If the one agent is the main agent, the channel node
  shows its copy.
- The chart is not split by a filter, and it has no search in this version.

## Keyboard and screen reader

- Tab and Shift+Tab move the focus through the nodes in this order: the root, then each channel node
  followed by its agent nodes and then the channel nodes of its sub-channels, in the order of the
  page. A "+<n> more" tile is a stop too.
- Enter or Space on a focused node does what a click does. Escape clears the dim. The keys "+" and
  "-" zoom, and "0" fits the view. The menu key or Shift+F10 opens the menu of the focused node.
  Each drag has a menu item that does the same, so the keyboard can do every edit.
- The accessible name of an agent node gives the name, the role line, the state, the mark "Lead",
  the label of its task, and the words "Also in <channel>" for each other copy. When the agent has
  hand-offs, the name adds "Handed work to <n> agents" and "Got work from <n> agents" for the agents
  that count above zero.
- The accessible name of a channel node gives the name of the channel, the number of members, and
  the counts by state.
- A focus ring shows on the focused node. The focus is never lost when the page changes.

## Motion

- With the setting "reduce motion" on (013), nothing on the page moves. A node that changes state
  changes at once. The view changes at once for "Fit to view".
- With it off, a change of state, a new node and a change of view take less than 300 ms (000).

## Flows

1. Open: the user presses the page button "Org chart". The page opens and fits to the view.
2. Read: the user points at a node. The linked nodes and lines stay, and the rest dim.
3. Go to the agent: the user clicks an agent node. The profile of the agent opens.
4. Go to the channel: the user clicks a channel node. The channel opens.
5. Watch: an agent starts a task. Its node shows "working" and the label within 1 second.
6. Change the team: in another page the user adds a member to a channel. When the user comes back to
   the page, or while it is open, the new node shows in that channel node.

## Rules

- The page starts no turn of an agent, makes no task, and sends nothing off the computer. It changes
  only the members, the lead and the parent channel, and only when the user edits (see "Edit on the
  chart").
- The chart shows no message text. It shows the names and role lines of agents, the names and
  pictures of channels, states, and the labels of running tasks, which the board (024) already
  shows.
- Text on the page comes from the translation catalogue, in English and Korean (013). Names, role
  lines and task labels are text of the user and are not translated.
- The page makes no notification (015).
- The window of 7 days is fixed. It is not a setting.
- A hand-off counts only when both agents are not archived at that moment.
- Tasks of both computers of a sync pair count (see "Surfaces").

## Surfaces

- **Ways in**: the page button "Org chart" (001), and no other. The search of the place list (Cmd+K)
  does not list the page in this version. There is no key for it. A channel header and an agent
  profile have no link to it.
- **Devices**: the computer shows the full chart. A linked computer (012) shows the same full chart
  of its server. It needs only the link to read it. It can edit only with the switch "Can create
  and change agents". Without it, the chart has no menu items that change data and no drag. The
  phone (011) shows a list instead of a canvas
  (see "Phone"). A second profile (022) has its own chart and never shows the agents of another
  profile.
- **Linked computer, offline**: the page shows the line "<server name> is offline." and no chart.
  The chart is not cached.
- **Runtimes**: agents on the tools of the app and agents on each vendor runtime (006) look the same
  and count the same. Agents get no tool to read the chart in this version. The tool "list agents"
  (007) stays as it is.
- **Ways out**: each edit has Undo for 10 seconds, and the channel settings can change it back at
  any time. The user leaves the page by opening another page.
- **Seeing the state**: states and labels are live. After a restart the page draws from the stored
  agents, channels and tasks, so it shows the same chart.
- **Data**: see "Data".
- **Words**: Org chart, Handed work (this spec calls one a hand-off), Lead (004), the legend
  words, and the words of 030 (see the glossary). The chart does not use the words "boss",
  "manager", "employee", "hire"
  or "report to".

## Data

The chart stores nothing of its own. It is drawn from agents, channels and tasks. An edit on the
chart changes channels only (004, 030).

- **Sync (019)**: agents, channels and tasks already sync, so nothing is added to the lists "Syncs"
  and "Does not sync". Each computer draws the chart from its own copy. Two computers that are up to
  date draw the same channel nodes, leads, lines and counts. Tasks of both computers count in the
  hand-offs. A task of the other computer counts when it has synced. The state "offline" of an agent
  (its model account is not connected here) can differ between the two computers.
- **Export (014)**: the archive holds agents, channels and tasks, so an import into an empty profile
  draws the same chart. The archive has no part of its own for the chart. The positions are
  computed, so none is saved.
- **Agent file (002)**: a file made with "Channels of these agents" brings channels with their
  members and lead. After the import, the chart shows them as channel nodes with their lead lines.
  The file holds no task, so the chart shows no hand-off from the file.
- **Workflow file (010)**: holds nothing for the chart.
- **Phone cache (011)**: the phone caches recent messages only. It does not cache the list.
- **New data later**: a mark on the task that tells a send from a reply, if the stored task cannot
  tell them, is data of the task. The slice that adds it adds it to the sync in the same slice (019,
  "New kinds of data").

## Phone

The phone shows the chart as a list, in a screen "Org chart". It cannot draw the canvas.

- The list is read-only. The phone cannot edit the chart in this version. It works when the server
  is online. With the server offline, it shows the
  line "<server name> is offline." and no list.
- The first row is the root: the main agent with the mark "Main agent", or "You".
- Then one block for each channel node, in the order of the page. The block of a sub-channel is
  indented one step under the block of its parent. A block has a header with the name
  of the channel, the number of members, and the counts by state. Under it, a row for each agent
  node that the page would draw: face, name, state, the mark "Lead" for the lead, and the label of
  the task for a working agent. The lead is first. A channel node of more than 12 shows the first
  12, then the row "+<n> more", which opens the rest as a list.
- At the end, the block "Handed work in the last 7 days". It lists the hand-off lines, one row for
  each: "<sender> → <receiver>" and the number. The busiest are first. At most 40 rows, as on the
  page.
- A tap on an agent row opens the direct chat of that agent. A tap on a block header opens the
  channel. A tap on a hand-off row does nothing.
- The list changes while it is open, within 1 second. The phone has no zoom and no hover.
- With no agent, the screen shows the line "No agents yet." The phone makes no agent in this version
  (002).

## Out of scope

- Draw a line to add a member or a lead. Archive, delete or rename from the chart. Edit on the
  phone. Open for a later change.
- A reporting line: "reports to" on an agent, or a tree of bosses. The glossary avoids these words.
  The tree of the chart is the tree of channels (030).
- Saved positions, a layout of the user, a radial layout, outlines around teams, a minimap, a lock.
- Skills, connections and the model around a node.
- An activity feed or a browser view on the chart. The activity panel (001), Today (021) and the
  board (024) do this.
- A window other than 7 days, or a setting for it.
- A chart for one channel beside its chat, or for one agent on its profile.
- A tool for agents, a key, and an entry in the search of the place list.
- An image or text export of the chart.
- A canvas on the phone.

## Acceptance

- A new profile with no agent: the page shows "No agents yet." and the button "New agent".
- Make three agents, none in a channel: the root is "You", and the channel node "No channel" holds
  three nodes in name order. Turn on "Main agent" for one: the root is that agent, and its copy
  shows in "No channel".
- Make a channel "Docs" with agents A, B and C and lead A: the channel node "Docs" shows A with the
  mark "Lead", and B and C under A with a lead line from A to each. The channel node shows "3
  members".
- Remove the lead of "Docs": the lead mark and the lead lines go, and A, B and C hang from the
  channel node. Archive agent C: it leaves the channel node within 1 second.
- Archive the channel "Docs": the channel node leaves the chart, and its agents show in "No channel"
  if they are in no other channel.
- Put agent B in a second channel "Ops": B has a node in both channel nodes. Point at one: both
  copies stay lit and the rest dim.
- A sends B a message with the tool "send message" three times: a dashed line from A to B shows the
  number 3. B replies in a later turn: the count stays 3, and no line from B to A shows.
- The main agent splits a request and sends parts to two agents: two dashed lines start at the root.
- A task made by a routine, a workflow or a channel part makes no hand-off line.
- A send that fails because of the chain limit (005) makes no line.
- A hand-off made 7 days and 1 minute ago does not count. One made 6 days ago does.
- Archive the receiver of a hand-off: the line goes.
- An agent starts a task with the label "Draft the release notes": within 1 second its node shows
  "working" and that label. A label of 100 characters shows 90 characters and "…". The node shows no
  thinking text.
- A task waits for an approval: the node shows "waiting for the user" and the label.
- A channel node of 15 members draws 12 nodes and the tile "+3 more". A click on the tile lists the
  other three.
- 41 pairs of agents each handed work: the page draws 40 lines and the legend shows "Showing the 40
  busiest hand-offs."
- Turn on "reduce motion", then open a chart with 40 agents and 20 channel nodes: nothing overlaps,
  and no line passes through a node. Repeat with it off: the same positions.
- Open the page, zoom in, and let an agent change state: the zoom and the view stay.
- Press "Fit to view" on a chart whose last node is at the bottom right: the node is not under the
  controls.
- Tab through the page: the focus visits the root, then each channel node and its agents, in order.
  Enter on an agent opens the profile. Escape clears the dim.
- Open the page from a linked computer without the switch "Can create and change agents": the chart
  of that server shows, with no edit control. With the server off, the line "<server name> is
  offline." shows.
- On the phone: the screen "Org chart" lists the root, the channel nodes and the hand-offs. A tap on
  an agent row opens its chat. A tap on a block header opens the channel.
- Two computers sync. The chart on both shows the same channel nodes, leads and counts. A hand-off
  that an agent made on the second computer counts on the first after it syncs.
- Export a profile and import it into an empty profile: the chart of the new profile shows the same
  channel nodes, lead lines and counts.
- Export two agents with "Channels of these agents" and import the file into an empty app: the chart
  shows the channel as a channel node with its lead, and no hand-off line.
- Open and close the page many times: no turn starts, no task is made, and nothing is sent off the
  computer.
- Channel "Docs" under "Product": the channel node of "Docs" sits under the node of "Product", with
  a structure line between them. The root has no line to "Docs".
- Drag agent B from "Docs" onto "Ops": B is a member of "Ops" and not of "Docs", and the line "Moved
  B to Ops." shows with "Undo". Undo: B is back in "Docs" only. Drag with Option: B is in both.
- Open the menu of B with the keyboard and pick "Make lead of Docs": B has the mark "Lead" and the
  lead lines.
- Drag "Product" onto "Docs", its own sub-channel: no ring shows, and the drop changes nothing.
- Drag agent A that works on a part of "Docs" to "Ops": the line "A works in Docs. Wait for its
  part to end, or stop it." shows, and nothing changes.
- A linked computer with "Can create and change agents": a move on the chart works.
- Switch to the Korean interface: the title, the legend, the counts, the marks and the lines of the
  empty states are Korean. Names and task labels do not change.
