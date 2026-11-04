# Org chart: what Clawboo does and what ROBot can take

This note compares one feature of one public project with ROBot. It is not a spec. It was written
on 2026-11-04 by a spec author, from public documents. Check a fact again before a spec relies on
it. The result is spec 029 ([Org chart](../specs/029-org-chart.md)).

How sure a fact is:

- **Read**: the author read the public documentation.
- **Not run**: nobody installed or ran the app. No claim here comes from a test run.
- **Proposal**: the author's idea for ROBot. The user has not decided it.

## Source

- Project: Clawboo (`github.com/clawboo/clawboo`). It runs teams of AI agents. License MIT. 109
  stars on 2026-11-04.
- Read: the public page about its Org chart, the README, and two change notes about the Org chart.
- Not read: any source code. Not run: the app.

## What the Org chart of Clawboo does (Read, not run)

The Org chart is a page that draws every agent on a canvas. Each agent is a small mascot.

| Part | What the user sees and does |
| --- | --- |
| Root | One special agent sits at the center (or the top). Every team hangs from it. |
| Teams | Each team has a round badge, the same icon as in the team list. A small pill beside the badge counts the agents of the team by state, for example "2 running, 3 idle". Pointing at a badge lights the agents of that team and dims the rest. |
| Agents | Under each name: the state and a count such as "12 capabilities, 1 route". A small badge shows which program runs the agent. |
| Live state | A running agent glows. An agent with an error glows red. A sleeping agent looks faded. While an agent works, a bubble shows its latest words or the tool it uses. After an error the bubble stays. |
| Lines | A red arrow means "this agent hands work to that one". |
| Open an agent | A click fans out its skills, its connectors and its model around it. A second click folds them. Five or more read-only items of one kind fold into one tile. The big chart shows at most 24 tiles per agent and counts the rest on one tile. |
| Draw a line | The user pulls a thread from a port on the right edge of an agent. Dropped on another agent, it adds the arrow. Dropped on empty space, it opens a picker: a connector, a skill, or a new agent. |
| Loose tiles | A "+" button puts a connector, a skill or a new agent on the canvas, marked "Not attached". The user drags it onto an agent. |
| Take back | A click on a line opens a panel with "Remove Connection". Backspace or Delete does the same. Ending a shared connector can be undone for 8 seconds. |
| Right click | "Open agent", "Move to team", "Delete". The root has no "Move to team". |
| Layouts | Radial (default) and Tree. The browser remembers the choice. Each layout keeps its own saved positions. |
| Tools | Drag agents. "Re-layout" drops the saved positions. "Team halos" draws an outline around each team; it is off at every start. Zoom, fit, lock, minimap. An activity feed and a browser view open at the right edge. |
| Keyboard | Tab between agents, Enter or Space to open or fold, arrow keys to move, a menu key for the right-click menu. Drawing a line needs a pointer. |
| Reduced motion | No animation. Agents land on their final places. |
| Other graphs | The same canvas shows one team beside its chat, one room beside its chat, and one agent on its own page. Each keeps its own saved positions. |

## What the notes say about quality (Read)

- **A line can say more than the app does.** In Clawboo, an arrow is a text line in a file that
  only one kind of runtime reads. For the other runtimes the arrow is only a picture. The page
  says so, and its troubleshooting list has the question "A route I drew does not change who
  gets the work".
- **The first layout piled agents on each other.** The names printed over each other when the
  system setting "reduce motion" was on, because the layout relied on an animation to push agents
  apart. A later change computes the spacing, so no agent, name or bubble lands on a neighbor.
- **Saved positions go stale.** A saved arrangement can cover only part of a changed graph. The
  answer was a "Re-layout" button.
- **Corner controls hid agents.** The zoom controls covered the last agent in the corner. The fit
  now leaves room for them.
- **Delete has no confirm** on the chart, and cannot be undone. The page puts a warning on it.
- **The empty chart told the user to connect to a gateway**, which is wrong when no gateway is
  needed. The text was changed.

## What ROBot has today (Read of the specs)

- Agents have a name, a face, a role line and a state: idle, working, waiting for the user, or
  offline (002).
- One agent can be the **main agent**. It splits a request and sends parts to the others (002,
  007). The glossary avoids the words "boss" and "manager".
- A **channel** has members and one optional lead. The lead splits a job and checks the results
  (004).
- An agent can send a task to another agent. The task keeps its source "another agent" and its
  depth (005, 007).
- The place list groups agents and channels in sections the user makes, up to 3 levels (001).
- Today (021) and the board (024) show the work of all agents. The activity panel shows who
  works on what in one channel (001).
- No page shows how the agents relate to each other.

## Map from Clawboo to ROBot (Proposal)

| Clawboo | ROBot | Take it? |
| --- | --- | --- |
| Root agent | The main agent. With none, a node for the user. | Yes. |
| Team | A channel: its members and its lead are real data with real behavior. A section is only a filing choice of the user. | Yes, with channels. A section is not a team. |
| Arrow "hands work to" | Two true sources: the lead of a channel to its members, and the tasks that agents sent to each other. | Yes. Draw only what the data holds. |
| State glow and bubble | The state of the agent, and the label of its current task (005). | Yes. The bubble shows no thinking. 002 already hides it. |
| Count of capabilities | Counts of skills (017) and connections (018). | Later. |
| Open an agent to see skills, connectors, model | The profile already holds these. | Later, as a fold. |
| Draw a line to add a route | No file holds a route. Adding a member or a lead to a channel is the real act. | Later. |
| Picker with a new agent, skill or connector | "New agent" (002). | Later. Leave out the connectors. |
| Marketplace of teams | Not in this version (docs/spec-changes.md). | No. |
| Radial and Tree layouts | One layout is enough at the start. | Tree first. |
| Activity feed and browser view on the chart | The activity panel, Today and the browser of an agent exist. | No. Do not repeat them. |
| Delete on the right-click menu | 002 asks to confirm, and only an archived agent can be deleted. | No. Keep 002. |
| Team halos, minimap, lock | Extras. | Later, if asked. |

## First version (Proposal, now spec 029)

The first version is read-only. It stores nothing new, so it needs no change to sync (019), to
export (014) or to the phone link (012).

- A page button "Org chart" under the other page buttons (001). Each profile (022) has its own
  chart.
- **Root**: the main agent. With none, a node for the user.
- **Channel nodes**: one node for each channel that is not archived and has a member. The lead has a
  mark. An agent that is in two channels shows in both nodes. An agent in no channel shows in a
  node "No channel".
- **Lines**: a solid line from the lead to each member. A dashed line between two agents when one
  sent a task to the other in the last 7 days, with the count. (The number 7 is a guess.)
- **Live**: each agent shows its state. A working agent shows the label of its task. The chart
  changes while it is open.
- **Actions**: a click opens the agent profile. A click on a channel node opens the channel. Hover dims
  all that is not linked. Fit and zoom. Tab, Enter and arrow keys work.
- **Layout**: computed so that no face, name or label lands on another. It must hold with reduce
  motion on, and with 1, 6 and 40 agents. A change of agents redraws the chart.
- **Empty state**: with no agent, one line that points to "New agent".
- **Phone**: a read-only list of the same channel nodes.

## Decisions of the user (2026-11-04)

1. **Meaning**: the chart shows teams and hand-offs, as in Clawboo. It is no tree of bosses. A
   "Reports to" field is not added.
2. **Scope**: read-only. The user also asked that sync and export are covered from the first
   version. The chart stores nothing, so sync (019) and export (014) need no new data. Spec 029
   says how the chart behaves on a sync pair, in an export and in an agent file.
3. **Team**: a channel. The root is the main agent. A section is not a team.
4. **Lines**: the lead to its members, and the tasks that agents sent to each other in the last 7
   days. The number 7 is still the author's guess.
5. **Phone**: a list only, no canvas.

Two choices the user did not make, which spec 029 settles and the user may change:

- **A linked computer** shows the full chart, read-only. Today, the board and the usage page show
  "Open this on <server name>" there, but the chart needs only data that a client can already read.
- **An agent in two channels** has a node in each channel. Its hand-off lines use one home node.

## Decisions of the user (2026-11-04, later)

The user asked how to run the agents like a real org chart, and chose all five steps of the
proposal. Spec 030 holds them, and 029 changes with them.

1. **Edit on the chart**: members, the lead and the parent channel change on the chart, with Undo.
   This replaces decision 2 ("read-only") for the computer and for a linked computer with the
   switch. The phone stays read-only.
2. **Hand-off rule**: "Along the channels" limits "send message" to the path of the channels. The
   default stays "Any agent", so that no flow of today breaks. The default is the author's choice.
3. **Ask up the line**: a pass of the lead goes to the higher leads and the main agent before the
   user. Off by default. The author's choice.
4. **Tools and limit of a channel**: skills, connections and a daily token limit per channel.
5. **Sub-channels**: a channel can sit inside another channel, at most 3 levels.

Decision 1 above holds: there is no "Reports to" field and no tree of bosses. The tree is the tree
of channels. The interface does not say "team", because the settings part "Teams" is the link to
Microsoft Teams (028).
