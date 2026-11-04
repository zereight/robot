# 030 Organization

## Purpose

The user runs the agents as an organization. Channels can sit inside other channels. A rule can
make agents hand work only along the channels. A question that the lead cannot answer can go to a
higher agent before it goes to the user. A channel can give skills and connections to its members,
and it can have a daily token limit. The org chart (029) shows all of this, and the user can change
the teams on the chart.

## Concepts

- **Parent channel**: a field of a channel (004). It is empty by default. A channel with a parent
  channel is a **sub-channel** of that channel. A channel with no parent channel is a **top
  channel**.
- **Channel tree**: the channels with their parent channels. A tree has at most 3 levels: a top
  channel, its sub-channels, and their sub-channels. A channel cannot be its own parent, and it
  cannot be under one of its own sub-channels.
- **Higher channels**: the parent channel of a channel, the parent of that one, and so on, up to
  the top channel.
- **Lower channels**: the sub-channels of a channel, their sub-channels, and so on.
- An archived parent channel counts as no parent channel while it is archived. Its sub-channels are
  then top channels. A restore makes them sub-channels again. A deleted parent channel clears the
  field.
- **Repair**: a state that breaks the rules of the tree is repaired at once, by a change of the
  parent field that syncs like any other change (019). The tree never stays broken, and no channel
  counts as a top channel only because its field is wrong. A break has one of two shapes, and it
  can come from a sync, from a restore (013), or from an import (014).
  1. **A fourth level.** The app clears the parent field of the channel that would be on the fourth
     level. After a restore or an import, it checks from the top down. A channel that is cleared
     becomes a top channel, and the channels under it count from their new level. After a sync, it
     clears the field of the channel with the latest parent change on that line of four channels.
  2. **A loop.** The app clears the parent field of the channel with the latest parent change among
     the channels of the loop. A restore uses the times that the parent fields carry. An import
     carries no time of change, because an export holds no sync records (014), so it uses the tie
     order below alone.
  - **Which change is later**: the time that sync (019) gives to the change, whichever computer
    made it. When the times are equal, the channel that was made later. When that is equal too, the
    channel with the later id. Both computers choose the same channel, so they end with the same
    tree.
  - **More than one break**: the app clears one field for each break, nearest the top first, and
    checks again, until the tree holds the rules.
  - **When it runs**: on the computer that finds the break first. After a sync, it waits until no
    change has come from the other computer for about 1 second, and each new change moves the wait
    back. The sync sends no sign of its end, and a computer of an older step must still work with
    this one (019). A set of changes that comes together is not cut in the middle. The repair also
    runs at the end of a first copy (019), after a restore, after an import, and at the start of the
    app. The repaired field syncs, and the other computer finds nothing to repair.
  - **The line**: each repair posts one muted line in the channel whose field was cleared: "The
    parent channel was cleared. The tree would have a loop." or "The parent channel was cleared.
    The tree would have more than 3 levels." It makes no notification and has no Undo, because a
    repair is not a change of the user. The line is not a message of an agent: it adds no unread
    count and does not replace the preview of the place. It has the same identity on both
    computers, so a sync keeps one line.
- **Hand-off rule**: a setting of the profile (022) in the settings part "Organization" (013). It
  has two values:
  - **Any agent** (the default): every agent can send a message to every other agent (007), as
    before this spec.
  - **Along the channels**: an agent can send a message only to the agents that "Who can send to
    whom" allows.
- **Ask up the line**: a setting of the profile in the part "Organization", off by default. When it
  is on, a question that the lead passes can go to higher agents before it goes to the user. See
  "Ask up the line".
- **Channel tools**: the skills (017) and the connections (018) that a channel gives to its
  members. See "Channel tools".
- **Daily token limit**: a field of a channel, off by default. See "Daily token limit".
- The words of 029 stay. The app does not use "boss", "manager", "employee", "hire", "report to" or
  "department". A channel is not called a "team" in the interface, because the settings part
  "Teams" is the link to Microsoft Teams (028).

## Channel tree

- The list "Put under…" on the org chart (029) holds the same channels as the field "Parent
  channel", without "None" and without the channel that is the parent now, because that pick
  changes nothing. "Move to the top" does the work of "None".
- In the channel settings, the field "Parent channel" lists "None" and the channels that are not
  archived and that the rules of the tree allow. A channel that is not allowed shows muted, with the
  reason: "This is a sub-channel of this channel." or "The tree would have more than 3 levels."
- A sub-channel shows in the place list as before. Its section (001) does not change. A section is
  a filing choice of one computer. The tree is data of the agents.
- The header of a sub-channel shows a small line under the name: "In <parent channel>". A click on
  it opens the parent channel.
- Membership does not go down or up the tree. An agent is a member of a channel only when the user
  made it a member of that channel.
- A lead of a parent channel does not give parts to the members of a sub-channel. It gives parts to
  the members of its own channel only (004). It can hand work to the lead of a sub-channel with
  "send message" (007), and that lead can split it in its channel.
- The instructions of a channel (004) do not go down the tree. A member gets the instructions of
  the channel of the turn only.
- Archive a channel that has sub-channels: the confirm says "<n> sub-channels become top channels
  while this channel is archived."

## Who can send to whom

With the hand-off rule "Along the channels", the app checks each "send message" (007) at the time
of the send. The sender S may send to a receiver R when R is not archived and one of these holds:

1. S and R are members of one channel that is not archived.
2. R is the main agent (002).
3. S is the main agent.
4. S is the lead of a channel C, and R is the lead of the parent channel of C, or the lead of a
   sub-channel of C.

More rules:

- An archived lead counts as no lead (004). An archived channel gives no right.
- An agent in no channel can send only to the main agent. With no main agent, it can send to no
  agent.
- A send that the rule does not allow fails. No task starts. The step shows the reason "<R> is not
  on your path. Send it to <A>." The sender gets the reason as a failed step, and its turn goes on.
  - **A chain**: a row of agents from S to R in which each agent may send to the next one by the
    rules above. The rule applies to the first send only. A chain of 2 agents is a send that the
    rule allows. <A> is the second agent of the shortest chain from S to R.
  - **Equal chains**: when more than one first agent gives a chain of the same length, the lead of a
    channel of S comes first, then the main agent, then the other agents in the order of their
    names, ignoring case.
  - **No chain**: when S has no chain to R, the reason is "<R> is not on your path, and no agent
    can pass it on. Tell the user."
- A refused send is not a hand-off of the org chart (029). It counts for no limit of 005.
- The reply of a receiver always comes back to the sender (007). A reply is not a send.
- The rule does not touch the work that the user gives: a direct chat, a channel job, a mention,
  `@all`, the fast pick, a routine, a workflow, a card of the board, and the parts that a lead
  gives in its own channel.
- **List agents**: with "Along the channels", the tool "list agents" (007) gives only the agents
  that the sender may send to. Each row also gives the channel that links them, or the words "main
  agent". The tool tells the agent that the rule is on, and that work for other agents goes through
  the agents on the list.
- **Main agent**: it is told that every agent can bring work to it, and that it passes work on along
  the channels: to the lead of a channel when the channel has one.
- A change of the rule counts from the next send. A send that started before the change ends as it
  started.
- The rule holds in the same way for agents that use the tools of the app and for agents on each
  vendor runtime (006), because the app checks the send.

## Ask up the line

This section adds a step to "Questions of members" (004). It applies only when "Ask up the line" is
on.

- **Kind of a pass**: when the lead passes a question, it names one of two kinds: "Only the user can
  choose" (a choice of taste, money, a payment, a message or a file that leaves the computer, a
  deletion, an account, a key or a secret) or "Not sure". A pass for the time limit is the kind
  "late". A failure of the lead is the kind "failure".
- A pass of the kind "Only the user can choose" goes to the user at once, as in 004. Nobody else
  looks at it.
- A pass of another kind goes to the next agent on the line. The line is, in this order:
  1. the lead of each higher channel, from the nearest to the top channel;
  2. the main agent.
- An agent of the line is skipped when it is archived, blocked by a usage limit, the member that
  asks, or an agent that already looked at this question. The line has at most 3 agents after the
  lead. Agents after the third are skipped.
- Each agent of the line reads what the lead reads (004, "What the lead reads"), and also the reason
  of each pass before it. It does exactly one of two things, as the lead does: answer, or pass with
  a kind and a reason.
- Each agent of the line has 2 minutes, as the lead has. The whole line, after the pass of the
  lead, has at most 5 minutes. Then the question passes to the user with the line "No agent on the
  line answered in time."
- **The card**: while an agent of the line looks, the card shows "<agent> looks at it" and a
  spinner, and under it one line for each pass before it: "<agent>: <reason>". An answer shows
  "Answered by <agent>" and its reason, with "Correct" (004). The answer of the user wins at any
  time, as in 004.
- While the question is on the line, it is not in "Needs you" (021), makes no notification (015),
  and the card of the part on the board (024) shows "Working". When it passes to the user, it is a
  normal question with all the pass lines, and it makes the one notification of the kind "question".
- **The look**: a look of an agent of the line that is not the lead is a short task of that agent
  with the source "Question from <channel>". It has the depth of the part that asks. It uses one
  slot (005) while it runs, and it waits in the queue as a task of a normal source. The time of 2
  minutes includes the wait. Its tokens count in the usage of that task and in the daily token
  limit of the channel of the question. It is not a hand-off of the org chart (029).
- An approval card never goes up the line. Only the user answers an approval.
- The answer of an agent of the line is not words of the user (007).
- Each look writes one line to the channel log (014), as a look of the lead does, with the place of
  the agent on the line.

## Channel tools

- In the channel settings, the part "Tools of this channel" lists the skills and the connections of
  this computer. Each row has a switch. A switch on gives that skill or connection to each member
  of the channel and to each member of its lower channels.
- The switch is the same fact as the list "the agents that may use it" in the skill (017) or the
  connection (018). That list can hold agents and channels. A form of a skill or a connection shows
  the channels in its picker, with the mark "channel". "All agents" stays as it is.
- An agent may use a skill or a connection when "All agents" is on, or when the list holds the
  agent, or a channel that it is a member of, or a higher channel of such a channel. An archived
  channel gives nothing.
- The agent may use it in every turn, also in its direct chat. A member of a channel uses its tools
  as its own.
- A change counts from the next turn. A turn that runs keeps the tools that it started with.
- An agent that leaves a channel loses the tools of that channel from its next turn. The profile of
  the agent (002) lists each skill and connection that it has from a channel with the line "From
  <channel>".
- Permission levels and permission rules (007) do not change. A connection that a channel gives
  asks the same approvals as before. The review of the tools of a connection (018) does not change.
- Skills and connections do not sync (019). So the tools of a channel are a fact of each computer.
  The other computer of a sync pair shows the part with its own skills and connections.

## Daily token limit

- In the channel settings, the field "Daily token limit" is off by default. On, it takes a number
  from 10,000 to 100,000,000 tokens.
- **What counts**: the tokens (005, "Usage of a task") of each task of this channel on the day: the
  parts, the turns of the lead (plan, check, summary, answers to questions), the replies to a
  mention or to `@all`, the summary of older messages, and the looks of the line for its
  questions. The tasks of its lower channels count too. A hand-off from a member to another agent
  does not count: it is work of that agent.
- **The day**: from midnight to midnight in the time of the computer that runs the task. Tasks of
  both computers of a sync pair count when they have synced.
- At 80% of the limit, the channel shows the muted line "80% of the daily token limit is used." It
  makes no notification.
- **At the limit**: no new task of the channel starts. A part, a nudge, a check, or a mention reply
  that would start ends at once as Blocked (005) with the reason "The daily token limit of <channel>
  is used." A look of the lead or of the line passes the question to the user with that reason. A
  turn that runs goes on to its end. Its tokens still count.
- A limit of a parent channel stops its lower channels too. The reason names the channel whose
  limit is used.
- The blocked parts show in the channel and on Today (021) as other blocked work does. Retry works
  after the next midnight, or after the user raises or turns off the limit.
- The usage page (006) shows, for each channel with a limit, the tokens used today and the limit.

## Edit on the org chart

See 029, "Edit on the chart". The chart changes only data that this spec and 004 define: members,
the lead, and the parent channel.

## Surfaces

- **Ways in**: the channel settings (parent channel, tools of the channel, daily token limit). The
  settings part "Organization" (hand-off rule, ask up the line). The forms of skills and connections
  (channels in the picker). The org chart (029, edit on the chart). No key, no command of the
  message box, and no entry in the search of the place list.
- **Devices**:
  - The computer can do all of this.
  - A linked computer (012) with the switch "Can create and change agents" can change the parent
    channel and the daily token limit, and edit on the chart. It cannot change the part
    "Organization", the tools of a channel, skills or connections (012). It sees them read-only.
  - The phone (011) shows the tree in the list of the org chart, the line "In <parent channel>" in
    a channel header, and the blocked parts with their reasons. A refused send shows as a failed
    step on a tool card, with the text of the step. The phone does not translate that text. The
    phone changes nothing of this spec.
  - Each profile (022) has its own channels, its own part "Organization" and its own tools.
- **Runtimes**: the hand-off rule, the line and the token limit are checked by the app. They are
  the same for agents that use the tools of the app and for agents on each vendor runtime (006). A
  vendor runtime gets the skills and connections of its channels in the way 017 and 018 give their
  own skills and connections to it.
- **Ways out**: "Parent channel" back to "None". The hand-off rule back to "Any agent". "Ask up the
  line" off. A switch of a tool off. The daily token limit off. Each change on the chart has Undo
  (029). Nothing here needs a confirm, except the archive of a channel with sub-channels.
- **Seeing the state**: the line "In <parent channel>" in the header; the tree on the org chart; the
  line of the rule in the legend of the chart (029); the reason of a refused send in the step; the
  pass lines on a question card; "From <channel>" in the agent profile; the line of 80% and the
  blocked parts; the usage page. All hold after a restart.
- **Words**: Parent channel, Sub-channel, Top channel, Organization, Hand-off rule, Any agent, Along
  the channels, Ask up the line, Tools of this channel, Daily token limit (see the glossary).

## Data

- **Sync (019)**: the parent channel and the daily token limit sync with the channel. The hand-off
  rule and "Ask up the line" sync as data of the agents, like the handbook (002): a change on one
  computer counts on the other after it syncs, and the later change wins. The channels in the
  agent lists of skills and connections do not sync, because skills and connections do not sync.
  The usage of today of a channel is computed from the tasks that synced.
- **Export (014)**: the archive holds the parent channel, the daily token limit, the hand-off rule,
  "Ask up the line", and the channels in the agent lists of skills and connections.
- **Agent file (002)**: with "Channels of these agents", a channel in the file keeps its parent
  channel when the parent is in the file too. Else it is a top channel after the import. The file
  holds the daily token limit. With "Skills of these agents", a skill keeps the channels of its list
  that are in the file. The file holds no hand-off rule and no "Ask up the line": those belong to
  the profile.
- **Workflow file (010)**: holds nothing of this spec.
- **Phone cache (011)**: no change.
- **Channel log (014)**: one line for each look of the line (see "Ask up the line"), and one line
  for each send that the hand-off rule refused, with the sender, the receiver and the time, and no
  text of the message.

## Out of scope

- Membership that goes down or up the tree, and instructions of a channel that go down the tree.
- A part that a lead gives to a whole sub-channel. The lead hands work to the lead of the
  sub-channel instead.
- A rule of its own for each channel or each agent. The hand-off rule is one rule for the profile.
- A token limit for an agent, a week or a month, or a cost in money.
- A reporting line on an agent, or a field "reports to" (029).
- Approvals that go up the line. Only the user answers an approval.
- Reviews of the work of an agent, scores, and counts of verdicts on the chart.
- A model or an effort that a channel gives to its members.

## Acceptance

- Make channels "Product", "Docs" and "Site". Set the parent channel of "Docs" to "Product" and of
  "Site" to "Docs". The parent field of "Product" shows "Docs" and "Site" muted with "This is a
  sub-channel of this channel." A fourth channel under "Site" is refused with "The tree would have
  more than 3 levels."
- The header of "Docs" shows "In Product". A click opens "Product".
- Archive "Product": the confirm names 1 sub-channel. "Docs" is a top channel. Restore "Product":
  "Docs" is under it again.
- "Docs" is under "Product", and "Site" is under "Docs". Archive "Product": "Docs" is a top channel.
  Put "Wiki" under "Site": "Wiki" is on the third level. Restore "Product": the restore works,
  "Wiki" would be on the fourth level, so its parent field is cleared. "Wiki" is a top channel and
  shows the muted line "The parent channel was cleared. The tree would have more than 3 levels."
  No notification shows, and the place shows no unread count for the line.
- A restore that closes a loop: "Docs" is under "Wiki", and "Site" is under "Docs". Archive "Docs":
  "Site" is a top channel. Put "Wiki" under "Site": it is allowed, because "Docs" counts as no
  channel now. Restore "Docs": the restore works. "Docs", "Wiki" and "Site" would be a loop, so the
  parent field of "Wiki" is cleared, because its change is the latest. "Wiki" is a top channel with
  "Docs" under it and "Site" under "Docs". "Wiki" shows the muted line "The parent channel was
  cleared. The tree would have a loop."
- An import holds a fourth level and a loop: after the import, the same repairs have run, and each
  cleared channel shows its line.
- Two computers sync. Before they sync, computer 1 puts "Docs" under "Site", and computer 2 puts
  "Site" under "Docs". After the sync both computers hold the same tree: the parent field of the
  channel with the later change is cleared, and that channel shows the muted line "The parent
  channel
  was cleared. The tree would have a loop." The tree has no loop.
- The channel "Docs" is under "Product". Its menu on the chart shows "Put under…" with the channels
  that the tree allows, but not "Product". "Move to the top" is on the menu.
- Hand-off rule "Any agent": agent A of "Docs" sends to agent X in no channel. A task starts.
- Hand-off rule "Along the channels", with main agent M, "Product" with lead P, and "Docs" under
  "Product" with lead D and member A:
  - A sends to D: a task starts.
  - A sends to M: a task starts.
  - A sends to P: the step fails with "P is not on your path. Send it to D." No task starts, and the
    chart draws no hand-off line.
  - D sends to P: a task starts. P sends to D: a task starts.
  - M sends to A: a task starts.
  - X, in no channel, sends to A: the step fails with "A is not on your path. Send it to M."
  - Turn off "Main agent" for M. X sends to A: the step fails with "A is not on your path, and no
    agent can pass it on. Tell the user."
  - A calls "list agents": the list holds D and M only, with "Docs" and "main agent".
  - M sends to A, and A replies: the reply comes back to M.
- The same refused send by an agent on a stand-in vendor runtime fails in the same way.
- "Ask up the line" on. In "Docs" with lead D and parent "Product" with lead P, and main agent M,
  member A asks a question that D passes as "Not sure". The card shows "D: <reason>" and "P looks
  at it". P answers: the card shows "Answered by P". "Needs you" stays empty.
- The same, but P passes as "Not sure": M looks at it. M passes: the question is in "Needs you"
  with three pass lines, and one notification shows.
- D passes as "Only the user can choose": the question goes to the user at once. P does not look.
- P does not answer in 2 minutes: M looks. M does not answer: the question passes to the user with
  "No agent on the line answered in time." The whole line after D took at most 5 minutes.
- The user answers while P looks: the answer of the user wins, and the look of P stops.
- "Ask up the line" off: a pass of D goes to the user, as in 004.
- An approval card in a part of "Docs" goes to the user only.
- Turn on the skill "Release notes" in "Tools of this channel" of "Product". A member of "Site" gets
  the skill in its next turn, also in its direct chat. Its profile shows "From Product". The skill
  form shows "Product" in its list with the mark "channel". Remove the member from "Site": the next
  turn has no such skill.
- A connection given by a channel asks the same approval as before for a risky tool.
- Daily token limit of 50,000 on "Docs". The stand-in provider reports 41,000 tokens of parts:
  "80% of the daily token limit is used." shows. A part reaches 51,000: the turn goes to its end.
  The
  next part ends as Blocked with "The daily token limit of Docs is used." Today shows it. Raise the
  limit to 100,000 and press Retry: the part runs.
- The limit of "Product" is used: a new part of "Site" ends as Blocked with the reason that names
  "Product".
- A hand-off from a member of "Docs" to M does not count in the limit of "Docs".
- Two computers sync. Change the hand-off rule on one: the other uses it after it syncs. The parent
  channel and the token limit show on both. The tools of a channel show on each computer with its
  own skills.
- Export a profile and import it into an empty profile: the tree, the limits, the rule, "Ask up the
  line" and the channels of skill lists are the same.
- An agent file with "Docs" and "Site" but not "Product": after the import, "Docs" is a top channel
  and "Site" is under "Docs".
- A linked computer with "Can create and change agents" sets a parent channel. It sees the part
  "Organization" read-only. Without the switch, it changes nothing.
- Switch to the Korean interface: the fields, the reasons of a refused send, the pass lines, the
  token lines and the part "Organization" are Korean.
