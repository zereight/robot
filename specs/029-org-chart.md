# 029 Org chart

## Purpose

The user opens one page and sees how the agents are organized: who is the main agent, which agents
belong to which organization, which organization sits inside which, who leads, who handed work to
whom, and what each agent does now. The user can also change the organizations on the chart: make
one, and change its members, its lead and its parent organization (see "Edit on the chart" and
030). Channels (004) are places for jobs. They are not on the chart.

## Concepts

- **Org chart**: a page of the window. The page button "Org chart" opens it (see 001). Each profile
  (022) has its own chart. The chart draws agents, organizations (030) and tasks that already exist.
  It stores no data of its own.
- **Root**: the top node. It is the main agent (002). When no agent is the main agent, or the main
  agent is archived, the root is the node "You", with a person icon and no profile.
- **Organization node**: one node for each organization (030), also one with no member. It shows
  the name of the organization, the number of its members that are not archived, and the number of
  members in each state (see "Organization node"). An organization with no such member shows the
  muted line "No members."
- **Organization node "No organization"**: one more organization node, last. It holds every agent
  that is not archived and is a member of no organization. With no such agent, it is not drawn.
- **Agent node**: a face, the name, the role line (one line, cut with "…"), and the state of the
  agent (idle, working, waiting for the user, or offline; see 002). A working agent also shows the
  label of its task (see "Live state").
- **Copy**: an agent that is a member of two or more organizations (they are on one line, see 030)
  has one node in each of their organization nodes. The root is the main agent, so the main agent also has a copy in each
  organization node where it is a member.
- **Home node**: the one node of an agent that the hand-off lines use. For the main agent it is the
  root. For any other agent it is the copy in the first organization node in which it appears.
  Organization nodes are in the order of "Order" below.
- **Lead mark**: a small mark "Lead" on the node of the lead of an organization. A lead that is
  archived counts as no lead (030).
- **Lead line**: a solid line with an arrowhead from the lead of an organization to each other
  member of that organization. It means: this agent leads that one.
- **Hand-off**: a task that one agent made for another agent with the tool "send message" (007), in
  the last 7 days. The reply that comes back to the sender is not a hand-off. A send that failed
  (007) made no task and is not counted. The sender is the agent of the task that sent it.
- **Hand-off line**: a dashed line with an arrowhead from the home node of the sender to the home
  node of the receiver. A number on it gives how many hand-offs went that way. A line has one
  direction. When both agents handed work to each other, the chart draws two lines.
- **Structure line**: a thin, muted line with no arrowhead from the root to a top organization node,
  from an organization node to the organization nodes of its sub-organizations (030), and from an
  organization node to its lead, or to its members when it has no lead. It has no meaning besides
  "belongs to".

## The page

- A header line: the title "Org chart", the button "New organization" (see "Edit on the chart"),
  the switch "Arrange" and the button "Re-layout" (see "Arrange, outlines, details
  and steps"),
  and a small legend that names the three kinds of line: "Leads" (lead line), "Handed work in the
  last 7 days" (hand-off line), and "Belongs to" (structure line). With the hand-off rule "Along the
  organizations" (030), the legend ends with the muted line "Hand-offs follow the organizations."
- Below, the canvas. The root is at the top. The top organization nodes sit in rows under it. The
  organization nodes of sub-organizations sit under the organization node of their parent, one
  level lower. The agents of an organization node sit under the organization node. In an
  organization node with a lead, the lead sits first and the other members sit under the lead.
- Controls at the bottom right: zoom in, zoom out, and "Fit to view". Dragging the empty canvas
  moves the view. The wheel and a pinch on a trackpad zoom. "Fit to view" frames all nodes with room
  around them, so that no node sits under the controls.
- When the page opens, it fits to the view.
- Pointing at a node, or putting the focus on it, dims every node and line that is not linked to it.
  The linked ones are: its lines, the nodes at the other end of those lines, and its copies. Moving
  away clears the dim.
- A click on an agent node opens the profile of that agent (002). A click on an organization node
  opens its form (030). A click on the root opens the profile of the main agent. The node "You" and
  the node "No organization" do nothing. A click on a line does nothing.
- Pointing at a hand-off line shows the text "<sender> handed <n> tasks to <receiver> in the last 7
  days."
- A node stays where the layout puts it, or where the user put it with "Arrange". A drag with
  "Arrange" off (see "Edit on the chart") changes the data, and the
  layout then puts the node in its new place.

### Edit on the chart

The chart makes organizations, and it changes their members, their lead and their parent
organization. These are the same changes as in the form of an organization (030), with the same
rules. The form also renames, sets access and deletes. The menus and the drags of the chart do not.

- **New organization**: the button in the header opens the form of 030. After the save, the chart
  stays open, and the focus goes to the new node.
- **Menu of an agent node**: a right-click, the menu key, or the "…" button that shows on a
  focused or pointed node opens it. It holds:
  - "Open profile".
  - "Make lead of <organization>", or "Remove as lead" on a lead. Not in "No organization".
  - "Add to organization…": a list of the organizations where the agent is no member. An
    organization that the line rule of 030 refuses shows muted, with the short reason of 030.
  - "Move to organization…": the same list. The agent leaves this organization and joins the picked
    one. The line rule is checked after the agent has left. Not in "No organization": there it is
    "Add to organization…" only.
  - "Remove from <organization>". Not in "No organization".
- **Menu of the root**: "Open profile". The node "You" has no menu.
- **Menu of an organization node**: "Edit organization…", "Add member…" (a list of agents that are
  not archived and not members; an agent that the line rule refuses shows muted, with "In
  <other>."), "New agent in this organization" (the form of 002; after save the agent is a member),
  "Put under…" (a list of the organizations that the tree and the line allow, without the parent
  now; the others show muted with their reasons of 030), and "Move to the top" (only on a sub-organization). The node "No
  organization" has "New agent" only.
- **Drag**: the user drags an agent node and drops it on an organization node: the agent moves to
  that organization, as "Move to organization…". With Option held, the agent is added and stays
  where it was, as "Add to organization…". Dropped on "No organization": the agent is removed from
  the organization it came from. The user drags an organization node and drops it on another
  organization node: it is put under it, as "Put under…". Dropped on the root: it moves to the top.
  During a drag, a node where a drop is allowed shows a ring. A node where it is not allowed shows
  no ring, and a drop there changes nothing. A drop on the empty canvas changes nothing. Escape ends
  a drag with no change.
- A drag never moves the view by itself. The layout does not change during a drag. A change of
  the data that comes during a drag shows when the drag ends. The drop is checked against the data
  of that moment.
- Edge scroll: when the pointer is on the canvas, within 40 px of an edge, and not on the drop area
  "No organization", the view moves in that direction while the pointer stays there. The speed
  grows toward the edge, up to 720 px a second at the edge.
- During the drag of an agent node that is in an organization, a drop area "No organization" shows
  at the bottom left of the canvas. It is drawn over the canvas and over the controls of the view.
  It is not a node of the layout, and it stays in place when the view moves. A drop on it does what
  a drop on the organization node "No organization" does. When the organization node "No
  organization" is drawn, it takes the drop too. The area goes when the drag ends.
- **Refusals**: a change that the rules of 030 do not allow is refused with a short line at the
  bottom of the canvas. A tree that breaks the rules of 030 gives the reason of 030, and so does a
  membership or a parent that breaks the line (030, "One line"). An agent that works can still
  change its organizations: membership holds no running work.
- A move of the lead out of its organization leaves that organization with no lead.
- "New agent in this organization" and "New agent": after the save the chart stays open, and the
  focus goes to the node of the new agent in that organization. When the agent is made but cannot
  join the organization, the refusal line gives the reason, and the focus goes to its node in "No
  organization". The profile does not open.
- **Lines at the bottom**: one line shows at a time. A new line takes the place of the line that
  shows. A refusal line shows for 10 seconds and has no "Undo".
- **Undo**: each change of members, lead or parent shows the line "<what changed>." with "Undo" at
  the bottom of the canvas for 10 seconds. After an Undo, the line "Undone." shows for 3 seconds.
  Undo puts back the members, the lead and the parent organization as they were before that change.
  Undo is refused with a reason when the change cannot go back, for example when the organization
  was deleted in the meantime. Cmd+Z does the same while the line shows. A save or a delete in the
  form has no Undo on the chart (030).
- No change on the chart needs a confirm. The chart cannot archive, delete or rename an agent.
- Each change is the same change as in the form: it syncs (019), the profile of an agent shows it,
  and the chart shows it within 1 second. The view and the zoom stay.

### Organization node

- The header of an organization node shows the name of the organization and the number of members.
  Beside it, a small count for each state that at least one member has, in this order: working,
  waiting for you, idle, offline. For example "2 working · 3 idle".
- Under the name, the node shows the **goal** of the organization (030, "Goal") in body text, on one
  line cut with "…". The whole goal shows in a note when the pointer rests on the line, and it is
  part of the accessible name of the node. An organization with no goal shows no line.
- Under that line, the node shows the **outcome** of its members in the last 7 days. It is a
  sentence of counts in muted text, with no colour, no bar and no percent:
  - `<n> done` and `<n> blocked`, each shown only when it is more than 0;
  - `<n> met` and `<n> not met`, from the verdicts of the parts of a channel (004, 005), each
    shown only when it is more than 0.
  For example "12 done · 2 blocked · 9 met · 1 not met". A node with no such task shows no
  outcome line.
  - The counts cover the tasks of the members that the node draws, on the computer that reads them,
    and the tasks of the other computer of a sync pair after they sync. A task of an archived agent
    is not counted. A task of a lower organization counts only in that lower organization, because
    the access of 030 goes down the tree and the counts do not go up.
  - A task counts once in each organization node that draws its agent, as the copies of an agent
    count (see "Copy"). The node "No organization" counts the tasks of its members.
  - "Done" counts a task that ended as done. A part of a channel in review that the user accepted
    counts. A task that the user cancelled does not count.
  - The window of 7 days is the same as the window of the hand-off lines. It is not a setting.
    A task counts in the window of the time it ended. A task that has not ended does not count.
  - A change of the outcome line does not move a node, as a change of a count does not (see
    "Layout").
- An organization node draws at most 12 agent nodes: the lead first, then the other members by name,
  ignoring case. When there are more, the last tile reads "+<n> more". A click on it lists the other
  members, with face, name and state. A click on a row opens the profile.
- The members that are not drawn have no line. A hand-off from or to an agent whose home node is not
  drawn is not drawn.

### Search and the list

- **Search field**: the header line of the page has one, beside the legend. It looks at the names
  of the organizations, the names of the agents, their role lines and their goals, in the same way
  as the filter of the place list (001, "Rules"): a place matches when the typed text is a part of
  one of those texts, ignoring case. Enter does nothing, and Escape clears the field.
- A node that the text does not match dims as a node that the pointer does not point at. **No node
  moves and no node goes**: the layout is the layout of the whole chart, so a search never changes
  the positions, the zoom or the view.
- What matches, exactly:
  - an organization matches by its name or by its goal; every agent node of it then stays lit;
  - an agent node matches by its name or by its role line; the organization node that holds it
    stays lit too, so a matched agent never shows without the chart that holds it, but the other
    agents of that organization dim.
- A line stays lit when both of its ends are lit.
- The root stays lit when the agent that it holds matches. In every other search it dims, so the
  chart still shows where the matched work sits.
- **The view**: a choice of "Chart" and "List" in the header. "Chart" is the canvas, and it is the
  view at first. The choice belongs to this device, as the choice of view of the place list does
  (001), and a change of the server keeps it.
- **The list** is the list of the phone (see "Phone"), with the same rows in the same order: the
  root, one block for each organization node with its members, and the block of hand-offs. A row of
  an agent opens its profile; a row of an organization opens its form. The list adds what the
  canvas has and a list needs: the goal of an organization, and its outcome line.
- The search dims the rows of the list too. A block whose organization, goal or members match stays
  at full contrast, and the others dim.
- With no agent, both views show the empty state (see "Empty and small states").
- The keyboard: the search field is the first stop of the header. Tab goes from it to the choice of
  view. In the list, Tab and the arrow keys move through the rows in the order of the page, as the
  nodes of the canvas do.


### Order

- Organization nodes on one level under one parent are in the order of the organization names,
  ignoring case. A tie goes by the time the organization was made, the older first. A
  sub-organization follows the agents of its parent in the order of the page. The organization node
  "No organization" is last. The order depends on no setting of one computer.
- Inside "No organization", agents are in the order of their names, ignoring case.

### Live state

- The state of an agent is the state of 002. A working agent shows the label of the task that runs
  now, in one line of at most 90 characters, cut with "…". It never shows the thinking of the agent,
  a message, or the content of a file. A task that waits for the user shows the state "waiting for
  the user" and the label.
- The page changes within 1 second after something changes: a state, a task, a member, a lead, an
  organization that is made, changed or deleted, an agent that is made, archived or renamed. The user does not
  reload the page. The count on a hand-off line grows when a new hand-off starts. A hand-off leaves
  the count 7 days after its task was made. The page shows this within 1 minute.
- A change of the page keeps the zoom and the view of the user. Only "Fit to view" and a new open of
  the page frame the nodes again.

### Layout

- The app computes the positions. The result must not depend on an animation.
- No face, name, role line, task label, header, count or tile covers another. No line passes through
  a node. This holds with the setting "reduce motion" on and off (013), with 1 agent, 6 agents and
  40 agents, with an organization node of 12 agents, and with 20 organization nodes.
- The agents of one level in an organization node (the agents under the lead, or all agents when
  there is no lead) stand side by side in one row. A row that is wider than the limit below goes to
  the next row.
- Top organization nodes that do not fit in one row go to the next row. A row is at most 1,600 px
  wide at zoom 100%.
- The sub-organizations of one parent are siblings. They stand side by side in one row under the
  parent, also when the row is wider than 1,600 px.
- The same data gives the same layout, also on two computers (019). Saved positions (see "Arrange,
  outlines, details and steps") change only what the user sees on one computer. They are not part
  of the layout.
- Hand-off lines: when there are more than 40, the chart draws the 40 with the highest count. A tie
  goes to the line with the newest hand-off. Then the legend ends with the muted line "Showing the
  40 busiest hand-offs."

### Arrange, outlines, details and steps

Four things help the user read a big chart. None of them changes organizations, members or leads.

**Arrange (move nodes)**

- The header has the switch "Arrange". It is off each time the page opens. While it is off, a drag
  does what "Edit on the chart" says. While it is on, a drag moves nodes, and no drag changes data.
  The menus, "New organization" and Undo work in both states.
- The root and each organization node can move. An organization node takes its agent nodes and its
  "+<n> more" tile with it. An agent node alone cannot move.
- A moved node stays where it is dropped. Lines follow. The zoom does not change, and the view does
  not move by itself. Escape ends a drag with no change.
- With the keyboard, on a focused node and with "Arrange" on: the arrow keys move the node 16 px,
  and Shift with an arrow moves it 64 px.
- The app saves the position of each moved node (see "Data"). A node with no saved position stays
  where the layout puts it. A saved position of a node that is gone is ignored and removed at the
  next save. A new node has none.
- A saved position holds only for the node as the layout drew it. When a node that was moved gets
  more members or sub-organizations, its parts keep their places relative to the node.
- The rule "No face, name, … covers another" of "Layout" holds for the places that the layout
  computes. A node that the user moved can cover another. The user chose that place, and the
  button "Re-layout" puts every node back.
- The header has the button "Re-layout". It is off when no position is saved. It removes every saved
  position of this chart at once, and the nodes go back to the places that the layout computes.
  It has no confirm and no Undo.
- "Fit to view" frames the nodes where they are now, including moved nodes.
- A linked computer (012) can arrange its own view with no switch, because a position is not data of
  the server. The phone has no canvas.

**Team areas**

- The chart draws a filled area behind each organization node, around the node, its agent nodes and
  its sub-organizations. The area of a sub-organization lies inside the area of its parent, with
  room between the two edges. The node "No organization" and the root have no area.
- The colour of an area depends on its depth: a top organization has the first colour, an
  organization in it the second, and so on. After the fifth colour the colours repeat. The colours
  are tints, so the text and the lines on them stay readable.
- Areas of organizations at one level never overlap. There is room between them. An area changes the
  layout only by this room.
- An area takes no click and is not read by a screen reader, because the organization nodes already
  give the structure. It is always drawn, and there is no switch.

**Details of an agent**

- An agent node has a small button "Show details". A click on the node still opens the profile
  (see "The page"). The button opens a panel next to the node, and a second press, Escape, or a
  click on another place closes it. One panel is open at a time. The key is Enter or Space on the
  focused button, and the button is a stop in the focus order after its node.
- The panel lists, in three rows:
  - **Model**: the provider and the model of the agent, and its effort level when it has one (002,
    006). A held model shows its mark, as the profile does.
  - **Skills**: the names of the skills that the agent may use now, from its own entry, from its
    organizations and from "All agents" (017, 030).
  - **Connections**: the names of the connections that the agent may use now (018, 030).
- A row shows at most 4 names. With more, it ends with the tile "+<n> more", and a click on it lists
  the other names in the panel. A row with no name reads "None".
- The panel is read only. It shows no secret, no value of a connection, and no text of a skill. A
  click on a name does nothing.
- The panel is drawn over the canvas. It may cover other nodes while it is open, and it never
  changes the layout. It is closed when the node it belongs to is gone, and it follows the node
  when the data changes.
- A linked computer shows the details of the server. The phone shows none.

**Step bubble (what a working agent does now)**

- Under the task label, an agent node has one line for the **step**. It is empty unless the agent
  is working, or its last task failed. The line has a fixed place in every agent node, so a step
  that comes or goes moves no node.
- A working agent shows the tool step that runs now, as the tool steps of the chat show it (007),
  for example "Reading a file" or "Sending to Ada". It shows only the name of the step and, for a
  send, the name of the receiver. It never shows the words of the agent, its thinking, a message,
  the content of a file, a path, or the arguments of a tool. It is at most 60 characters, cut with
  "…". Between two steps it shows the last step until the next one starts.
- An agent whose last task failed shows "Failed: <short reason>" with the reason of 005, in the
  state colour of an error. It stays until the agent starts another task.
- The step shows only for a task that runs on this computer. A task of the other computer of a
  sync pair shows its task label only, as before.
- The line is part of the accessible name of the node (see "Keyboard and screen reader"). It
  changes within 1 second, as the state does.

### Empty and small states

- No agent that is not archived and no organization: no canvas. One muted line "No agents yet." and
  the button "New agent" (002).
- No agent that is not archived, but an organization: the root "You" and the organization nodes,
  each with the line "No members."
- Agents but no organization: the root, and the organization node "No organization" with all
  agents.
- One agent: the root and one organization node. If the one agent is the main agent, the node shows
  its copy.
- The chart is not split by a filter: a search dims, it never removes (see "Search and the list").
  Nothing found by the search shows the whole chart dimmed and the muted line "Nothing matches."

## Keyboard and screen reader

- Tab and Shift+Tab move the focus through the nodes in this order: the root, then each organization
  node followed by its agent nodes and then the organization nodes of its sub-organizations, in the
  order of the page. A "+<n> more" tile is a stop too.
- Enter or Space on a focused node does what a click does. Escape clears the dim. The keys "+" and
  "-" zoom, and "0" fits the view. The menu key or Shift+F10 opens the menu of the focused node.
  Each drag has a menu item that does the same, so the keyboard can do every edit.
- The accessible name of an agent node gives the name, the role line, the state, the mark "Lead",
  the label of its task, and the words "Also in <organization>" for each other copy. When the agent has
  hand-offs, the name adds "Handed work to <n> agents" and "Got work from <n> agents" for the agents
  that count above zero.
- The accessible name of an organization node gives the name of the organization, the number of
  members, and the counts by state.
- The accessible name of an agent node adds the step ("Now: <step>") or the failure ("Failed:
  <reason>") when the line shows one.
- The switch "Arrange" and the button "Re-layout" are in the header, before the
  nodes, and have names. With "Arrange" on, the arrow keys move the focused organization node or
  the root, and an agent node ignores them.
- A focus ring shows on the focused node. The focus is never lost when the page changes.

## Motion

- With the setting "reduce motion" on (013), nothing on the page moves. A node that changes state
  changes at once. The view changes at once for "Fit to view".
- With it off, a change of state, a new node and a change of view take less than 300 ms (000).

## Flows

1. Open: the user presses the page button "Org chart". The page opens and fits to the view.
2. Read: the user points at a node. The linked nodes and lines stay, and the rest dim.
3. Go to the agent: the user clicks an agent node. The profile of the agent opens.
4. Open the organization: the user clicks an organization node. Its form opens.
5. Watch: an agent starts a task. Its node shows "working" and the label within 1 second.
6. Change the organization: in another place the user adds a member to an organization. When the
   user comes back to the page, or while it is open, the new node shows in that organization node.

## Rules

- The page starts no turn of an agent, makes no task, and sends nothing off the computer. It changes
  only organizations (030), and only when the user edits: a new organization, and the members, the
  lead and the parent organization (see "Edit on the chart").
- The chart shows no message text. It shows the names and role lines of agents, the names of
  organizations, states, the labels of running tasks, which the board (024) already shows, the name
  of the tool step that runs, the short reason of a failed task, and in the details panel the model,
  the names of skills and the names of connections. It never shows a secret.
- Text on the page comes from the translation catalogue, in English and Korean (013). Names, role
  lines and task labels are text of the user and are not translated.
- The page makes no notification (015).
- The window of 7 days is fixed. It is not a setting.
- A hand-off counts only when both agents are not archived at that moment.
- Tasks of both computers of a sync pair count (see "Surfaces").

## Surfaces

- **Ways in**: the page button "Org chart" (001), and the search of the place list (Cmd+K): an
  organization of this computer shows as a hit, and a click opens the page with that organization
  in the search field. A channel header and an agent profile have no link to the page.
- **Devices**: the computer shows the full chart. A linked computer (012) shows the same full chart
  of its server. It needs only the link to read it. It can edit only with the switch "Can create
  and change agents". Without it, the chart has no "New organization" button, no menu items that
  change data and no drag, and the form of an organization opens read-only. The
  phone (011) shows a list instead of a canvas
  (see "Phone"). A second profile (022) has its own chart and never shows the agents of another
  profile.
- **Linked computer, offline**: the page shows the line "<server name> is offline." and no chart.
  The chart is not cached.
- **Runtimes**: agents on the tools of the app and agents on each vendor runtime (006) look the same
  and count the same. Agents get no tool to read the chart in this version. The tool "list agents"
  (007) stays as it is.
- **Ways out**: each change of members, lead or parent has Undo for 10 seconds, and the form can
  change it back at any time. A delete of an organization asks first (030). The user leaves the page
  by opening another page.
- **Seeing the state**: states and labels are live. After a restart the page draws from the stored
  agents, organizations and tasks, so it shows the same chart.
- **Data**: see "Data".
- **Words**: Org chart, Handed work (this spec calls one a hand-off), Lead, the legend words, and
  the words of 030 (see the glossary). The chart does not use the words "boss",
  "manager", "employee", "hire"
  or "report to".

## Data

The chart stores one thing of its own: the positions that the user set with "Arrange". Everything
else is drawn from agents, organizations and tasks. An edit on the chart changes organizations only
(030).

- **Positions**: for each moved node, its id (the organization or the root) and its place. A
  position is the layout of one computer, as the sections of the place list are (001). It is kept
  for each profile (022). A linked computer keeps its own positions for each server. The switch
  "Arrange" is not saved.

- **Sync (019)**: agents, organizations and tasks sync (030). The saved positions do not sync (see
  the list "Does not sync" in 019). Each computer draws the chart from its own copy. Two computers that
  are up to date draw the same organization nodes, leads, lines and counts. Tasks of both computers count in the
  hand-offs. A task of the other computer counts when it has synced. The state "offline" of an agent
  (its model account is not connected here) can differ between the two computers.
- **Export (014)**: the archive holds agents, organizations and tasks, so an import into an empty
  profile draws the same chart. The archive has no part of its own for the chart. The positions are
  computed, and the positions that the user set are the layout of one computer and are not in the
  archive.
- **Agent file (002)**: the file holds no organization (030), so an import makes no node on the
  chart. The agents show in "No organization". The file holds no task, so the chart shows no
  hand-off from the file.
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
- Then one block for each organization node, in the order of the page. The block of a
  sub-organization is indented one step under the block of its parent. A block has a header with
  the name of the organization, the number of members, and the counts by state. Under it, a row for
  each agent node that the page would draw: face, name, state, the mark "Lead" for the lead, and
  the label of the task for a working agent. The lead is first. An organization node of more than
  12 shows the first 12, then the row "+<n> more", which opens the rest as a list.
- At the end, the block "Handed work in the last 7 days". It lists the hand-off lines, one row for
  each: "<sender> → <receiver>" and the number. The busiest are first. At most 40 rows, as on the
  page.
- A tap on an agent row opens the direct chat of that agent. A tap on a block header or on a
  hand-off row does nothing, because the phone has no form of an organization.
- The list changes while it is open, within 1 second. The phone has no zoom and no hover.
- With no agent, the screen shows the line "No agents yet." The phone makes no agent in this version
  (002).

## Out of scope

- Draw a line to add a member or a lead. Archive, delete or rename an agent from the chart. Rename
  or delete an organization from a menu of the chart (the form does it). Edit on the phone. Open for
  a later change.
- Channels on the chart, and a picture of an organization (030).
- A reporting line: "reports to" on an agent, or a tree of bosses. The glossary avoids these words.
  The tree of the chart is the tree of organizations (030).
- A radial layout, a minimap, a lock, a separate saved layout for each user or a name for a layout,
  and positions that sync.
- Details of an agent that open on a click on a name (a skill or a connection), and a change of
  a model, a skill or a connection from the panel.
- The words of an agent, its thinking, or the arguments of a tool in the step line.
- An activity feed or a browser view on the chart. The activity panel (001), Today (021) and the
  board (024) do this.
- A window other than 7 days, or a setting for it.
- A chart for one channel beside its chat, or for one agent on its profile.
- A tool for agents, a key, and a group of results in the search of the place list. An organization
  is one hit in that search, not a list of its own.
- An image or text export of the chart.
- A canvas on the phone.

## Acceptance

- A new profile with no agent and no organization: the page shows "No agents yet." and the button
  "New agent".
- Make three agents, none in an organization: the root is "You", and the organization node "No
  organization" holds three nodes in name order. Turn on "Main agent" for one: the root is that
  agent, and its copy shows in "No organization".
- Press "New organization" and save "Docs" with agents A, B and C and lead A: the node "Docs" shows
  A with the mark "Lead", and B and C under A with a lead line from A to each. The node shows "3
  members". The legend names the lines "Leads", "Handed work in the last 7 days" and "Belongs to".
- Make an organization with no member: its node shows "No members."
- Remove the lead of "Docs": the lead mark and the lead lines go, and A, B and C hang from the
  organization node. Archive agent C: it leaves the organization node within 1 second.
- Delete the organization "Docs" in its form: the node leaves the chart, and its agents show in "No
  organization" if they are in no other organization.
- Make a channel "Docs" with members: the chart does not change.
- Put agent B in a second organization "Product", the parent of "Docs": B has a node in both
  organization nodes. Point at one: both copies stay lit and the rest dim. Put B in "Ops", which is
  not on one line with them: the line "B is in Docs, which is not on one line with Ops." shows, and
  nothing changes.
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
- An organization node of 15 members draws 12 nodes and the tile "+3 more". A click on the tile
  lists the other three.
- 41 pairs of agents each handed work: the page draws 40 lines and the legend shows "Showing the 40
  busiest hand-offs."
- Turn on "reduce motion", then open a chart with 40 agents and 20 organization nodes: nothing
  overlaps, and no line passes through a node. Repeat with it off: the same positions.
- An organization "Docs" with members A and B. A ends 12 tasks as done and 2 as blocked in the last
  7 days, and a part of the channel job of A gets the verdict "Not met" once and "Met" 9 times: the
  node "Docs" shows "12 done · 2 blocked · 9 met · 1 not met". A task of A that ended 8 days ago
  does not count.
- Archive A: the node "Docs" shows no outcome line, because A is not drawn.
- A is a member of "Docs" and of "Product", its parent: the outcome of A counts in both nodes, as
  its copy does.
- A is in no organization: "No organization" counts its tasks.
- End a task of A as failed: the outcome line does not change, because "failed" is not "done".
- Open the page, zoom in, and let an agent change state: the zoom and the view stay.
- Press "Fit to view" on a chart whose last node is at the bottom right: the node is not under the
  controls.
- Tab through the page: the focus visits the root, then each organization node and its agents, in
  order. Enter on an agent opens the profile. Enter on an organization node opens its form. Escape
  clears the dim.
- Open the page from a linked computer without the switch "Can create and change agents": the chart
  of that server shows, with no "New organization" button and no edit control, and the form of an
  organization is read-only. With the server off, the line "<server name> is offline." shows.
- On the phone: the screen "Org chart" lists the root, the organization nodes and the hand-offs. A
  tap on an agent row opens its chat. A tap on a block header does nothing.
- Two computers sync. The chart on both shows the same organization nodes, leads and counts. A
  hand-off that an agent made on the second computer counts on the first after it syncs.
- Export a profile and import it into an empty profile: the chart of the new profile shows the same
  organization nodes, lead lines and counts.
- Export two agents with "Channels of these agents" and import the file into an empty app: the
  chart shows no organization node, and the agents are in "No organization".
- Open and close the page many times: no turn starts, no task is made, and nothing is sent off the
  computer.
- Search and the list: type "doc" in the search field of the page. The node "Docs" and its agents
  stay at full contrast, and every other node dims. No node moves: the positions, the zoom and the
  view are the ones before the search. Press Escape: every node is back. Type the role of one agent:
  that agent and its organization node stay lit, and the other members of that organization dim.
  Type text that matches nothing: the whole chart dims and the muted line "Nothing matches." shows.
- Pick "List" in the header: the page shows the list of the phone, with the root, a block for each
  organization with its goal and its outcome line, and the block of the hand-offs. A click on a row
  of an agent opens its profile. A click on a row of an organization opens its form. Pick "Chart":
  the canvas is back, with the same zoom and view as before. Restart the app: the view is still
  "List".
- In the place list, press Cmd+K and type the name of an organization: the hit opens the page with
  that organization in the search field.
- Organization "Docs" under "Product": the node of "Docs" sits under the node of "Product", with a
  structure line between them. The root has no line to "Docs".
- Drag agent B from "Docs" onto "Ops", a sub-organization of "Product" that is not under "Docs": B
  is a member of "Ops" and not of "Docs", and the line "Moved B to Ops." shows with "Undo". Undo: B
  is back in "Docs" only. Drag with Option from "Docs" onto "Product", the parent of "Docs": B is
  in both. Drag with Option from "Docs" onto "Ops": no ring shows, and nothing changes.
- Open the menu of B with the keyboard and pick "Make lead of Docs": B has the mark "Lead" and the
  lead lines.
- Drag "Product" onto "Docs", its own sub-organization: no ring shows, and the drop changes nothing.
- Drag agent A that works on a part of a channel to "Ops" (a sub-organization of "Product" where A
  may go): A moves, because an organization holds no running work.
- Drag "Docs" onto "Site" so that the tree would have 4 levels: no ring shows and nothing changes.
  Use "Put under…" with the keyboard: "Site" is muted with the reason of 030.
- Put "Docs" under "Product" on the chart. Then delete "Docs" in its form and press "Undo" on the
  line that still shows: Undo is refused with a reason.
- A linked computer with "Can create and change agents": a move on the chart works.
- Turn on "Arrange" and drag the organization node "Docs" to a new place: its agents and "+<n> more"
  tile move with it, the lines follow, and no member, lead or parent changed. Close the page and
  open it again: "Docs" is in the new place, and "Arrange" is off. Press "Re-layout": every node is
  back in the computed place, and the button is off.
- With "Arrange" on, drag an agent node: it does not move, and no data changes. With "Arrange" off,
  drag it onto an organization node: it moves to that organization, as before.
- Move "Docs", then add a member to it from another place: the new agent node shows inside "Docs"
  in its new place. Delete "Docs" in its form: its saved position is gone at the next save.
- Make "Docs" a sub-organization of "Product", and "Site" one of "Docs": each organization has an
  area behind it, and each area lies inside the area of its parent. The three areas have three
  colours. Two top organizations have areas that do not overlap.
- Press "Show details" on an agent node: the panel lists its model, its skills and its connections,
  with "None" for a row with no name, and "+<n> more" after 4 names. It shows no secret. Press
  Escape: it closes. Open it on another agent: the first one closes.
- Make an agent work and let it read a file: its node shows "Reading a file" within 1 second, with
  no path. Let it send to Ada: the node shows "Sending to Ada". Let a task fail: the node shows
  "Failed: <reason>" until the agent starts another task.
- Check that no node changed its size or place when a step line came or went.
- On a linked computer without the switch "Can create and change agents": "Arrange"
  and "Show details" still work, and no change of data is possible.
- Switch to the Korean interface: the title, the legend, the counts, the marks and the lines of the
  empty states are Korean. Names and task labels do not change.
