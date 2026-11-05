# 030 Organization

## Purpose

The user runs the agents as an organization. An organization is a group of agents. It is not a
channel. A channel is the place where a job is done (004). An organization says who may do what.
Organizations can sit inside other organizations, and an agent can be in more than one
organization only when they are on one line of the tree. Each organization has access: tools, a daily token
limit and a hand-off range. Access goes down to the lower organizations, and a lower organization
can set its own. A rule can make agents hand work only along the organizations. A question that the
lead of a channel cannot answer can go to higher agents before it goes to the user. The org chart
(029) draws the organizations, and the user can change them on the chart.

## Concepts

- **Organization**: a name (1 to 60 characters, unique, the check ignores case), a goal (see
  "Goal"), members (agents), one optional lead, a parent organization (empty by default), and
  access (see "Access"). It has no messages, no tasks and no workspace. It can own workflows (010,
  "Owner and participants"). A profile (022) holds at most 100 organizations.
  - **Member**: an agent can be a member of more than one organization, but only of organizations
    that are on one line (see "One line"). Membership does not go up or down the tree. An agent that
    is archived stays a member, and every rule below skips it while it is archived.
  - **Lead**: one member, or none. An archived lead counts as no lead. A member that is removed
    from the organization is no longer its lead. The lead of an organization is not the lead of a
    channel (004). One agent can be both.
  - A channel and an organization are independent. The members of a channel are not an
    organization, and the app never makes one from the other, except in "Migration".
- **Parent organization**: a field of an organization. An organization with a parent organization
  is a **sub-organization** of it. An organization with no parent is a **top organization**.
- **Organization tree**: the organizations with their parents. A tree has at most 3 levels: a top
  organization, its sub-organizations, and their sub-organizations. An organization cannot be its
  own parent, and it cannot be under one of its own sub-organizations.
- **Higher organizations**: the parent of an organization, the parent of that one, and so on, up to
  the top organization. **Lower organizations**: its sub-organizations, their sub-organizations, and
  so on.
- **Access**: what an organization gives to its members: tools, a daily token limit and a hand-off
  range. See "Access".
- **Hand-off rule**: a setting of the profile (022) in the settings part "Hand-off rules" (013). It
  has two values:
  - **Any agent** (the default): every agent can send a message to every other agent (007).
  - **Along the organizations**: an agent can send a message only to the agents that "Who can send
    to whom" allows.
- **Ask up the line**: a setting of the profile in the part "Hand-off rules", off by default. When it
  is on, a question that the lead of a channel passes can go to higher agents before it goes to the
  user. See "Ask up the line".
- The words of 029 stay. The app does not use "boss", "manager", "employee", "hire", "report to" or
  "department". An organization is not called a "team" in the interface, because the settings part
  "Teams" is the link to Microsoft Teams (028).

## Flows

1. Create: on the org chart (029) the user presses "New organization". The form opens with the
   fields Name, Goal, Members, Lead and Parent organization, and the part "Access". The user saves.
   The new organization shows on the chart within 1 second, also when it has no member.
2. Edit: the user opens the form with a click on an organization node, or with "Edit organization…"
   on its menu (029). The form holds the same fields, and a button "Delete organization".
3. Change the teams on the chart: members, the lead and the parent organization also change with the
   menus and the drag of the chart (029, "Edit on the chart"). These are the same changes as in the
   form, with the same rules.
4. Delete: the user presses "Delete organization" in the form. A confirm says: "Delete <name>? <n>
   sub-organizations move up to <parent>. The access that this organization gives is gone." When
   the organization has no parent, the words are "become top organizations". <n> counts the sub-organizations of the organization, not the ones below them. The line
   with <n> shows only when <n> is more than 0. When the organization owns <w> workflows (010), a
   second line says: "<w> workflows have no owner then. Any agent can work in them." It shows only
   when <w> is more than 0. The buttons are "Back" and "Delete". The members
   stay as agents. A deleted organization leaves every skill and connection list. Its workflows stay
   with the owner "None". The delete has no Undo.
5. See the organizations of an agent: the profile of an agent (002) has a row "Organizations". A
   click on a name opens the form. The profile also lists each skill and connection that the agent
   has from an organization, with the line "From <organization>".
6. Make an agent in the form: the field Members has a button "New agent". It opens the form of a
   new agent (002, flow 1) over the form of the organization. When the user saves it, the app
   makes the agent at once, as in 002, and adds it to the members in the form. The app does not
   open the direct chat. The agent is a member only when the user saves the organization. When
   the user closes the form of the organization without saving, the agent stays and is a member
   of no organization. The field Lead lists the new agent as a member, so the user can pick it as
   the lead. The button works in the form of a new organization and in the form of an organization
   that exists. A new agent is in no other organization, so it never breaks "One line".
7. See the workflows of an organization: the form has a row "Workflows" with the workflows that
   the organization owns (010, "Owner and participants"). A click on a name opens the workflow on
   the Workflows page. The row shows only when the organization owns a workflow.

## Goal

An organization says why it exists, in one text. The goal is what its members read before their own
instructions, in the place where the handbook is read (002, "Handbook").

- **The field**: "Goal" in the form of an organization. 0 to 400 characters, empty at the start. It
  holds plain text, with line breaks. It is text of the user and is not translated. A goal that is
  empty gives nothing to any agent.
- **What a member reads**: an agent gets the goal of each organization that it is a member of, before
  its own instructions. The goal of a higher organization is not read; it is not a member of that one.
  An agent in two organizations gets both goals, the higher organization first.
- **The order**: the handbook (002), then the goals of the organizations of the agent from the top
  organization down, then the instructions of the agent, then the instructions of the channel (004).
  The rule of the later text wins holds as it does for the handbook: an instruction of the agent wins
  over a goal. The app tells the agent this order.
- **When it counts**: a change of the goal counts from the next turn, as a change of the handbook
  does. A turn that runs keeps the text that it started with.
- **On the page**: an organization node on the org chart (029) shows the goal under its name, in
  body text, one line cut with "…". The whole goal shows in a note when the pointer rests on it, and
  it is part of the accessible name of the node. A goal that is empty shows no line.
- **Length**: a goal that is longer than 400 characters is refused with the reason in words.
- **Secrets**: a goal that looks like a secret is refused on save, with the reason, as the handbook
  is (014).
- **Devices**: the computer and a linked computer with the switch "Can create and change agents"
  change the goal. Without the switch the field is read only. The phone reads the goal of an
  organization in its list (029, "Phone") and changes nothing.
- **Migration**: the goal of an organization that the migration makes from a channel is empty.

## Retrospective

An organization can look at its own work and propose a change, and the user decides whether to keep
it.

- **Ways in**: the menu of an organization node on the org chart (029) has "Look back…". It needs
  the switch "Can create and change agents" on a linked computer, as every edit of the chart does.
- **What it reads**: the work of the members that the node draws, in the last 7 days, as the
  outcome line of 029 counts it: for each task that ended as done, blocked or failed, its label; for
  each part of a channel, its verdict and the reason of a "Not met". It reads **no** prompt, no
  message text, no thinking, no tool output and no file content, so the request cannot carry
  outside content by accident.
- **What it gives**: one to three proposals. Each one is one of two kinds:
  - **Instructions**: a new text for the instructions of one agent (002), with the whole text.
  - **Skill**: a new skill (017) with a name, a description and its instructions, for one agent.
  A proposal names the evidence it rests on, in one line, as counts: "3 of 5 parts with the verdict
  Not met". It never explains what a model thinks.
- **What happens then**: each proposal opens the form of its kind, filled in, and the user saves it
  or closes it. **Nothing is saved before the user saves.** A retrospective makes no change request
  (037) and no change: it fills a form and stops.
- **One request**: the look back is one request to the model account of the lead, or of the first
  member by name when the organization has no lead. It makes no task and no message, and it holds no
  slot in the queue. A token used by the request does not count in the daily token limit, because
  the app has no task to count it against (see `docs/spec-questions.md`).
- **Limits**: one look back at a time for each organization. The button is off while one runs. A
  look back fails with the reason in words when the organization has no member, when no model
  account of the member is connected, or when the answer holds no proposal.
- **Why not a change request**: a proposal is a text that the user reads and saves. An agent that
  changed its own instructions would escape the rule of 000 that an agent gets better only through
  things that the user can see and edit.

- **The repair in the form**: the form of an organization shows one muted line above the button
  "Delete organization" when the organization log holds a repair of this organization in the last
  30 days: "Last repair: <date> — the tree would have a loop." or, for a removal of a member, "Last
  repair: <date> — <agent> left, off one line." A repair makes no notification (see "Repair"), so
  this line is where the user finds it after the fact. The log keeps the last 90 days (014), and the
  line reads the same log.

## A routine of an organization

The work that repeats belongs to a team, not only to one agent. A routine can name an organization.

- **The field**: "Organization" in the form of a routine, a choice of the organizations of this
  computer and "None". "None" is the default, so every routine of today is unchanged.
- **Who runs it**: the agent of the routine, as before. It must be a member of the organization that
  the routine names, or the save is refused with the reason "Add <agent> to <organization> first."
  The app does **not** make the lead the runner, and a change of the lead does not move a routine:
  a job that silently changes hands is worse than a job the user files again.
- **What the organization gives**: the daily token limit of the organization counts the runs of the
  routine, because it counts the tasks of its members from every source (see "Daily token limit").
  A routine whose agent leaves the organization keeps its runs and loses the limit, and the form
  says so until the user picks another organization.
- **Where it shows**: the routine form has the field. The list of routines shows the organization
  as a chip beside the name, as a place shows its role badge (001). The form of an organization
  shows the number of routines of this organization, as a muted line, with a click that opens the
  list of routines.
- **Limits**: a deleted organization leaves every routine with "None", and no routine changes its
  agent. The limit of 50 routines of a server (009) counts every routine, with an organization or
  not.
- **Sync (019)**: the field syncs with the routine, as its other fields do. The routines that an
  agent file holds (002) carry no organization.

## Organization tree

- In the form, the field "Parent organization" lists "None" and the organizations that the rules of
  the tree allow. An organization that is not allowed shows muted, with the reason: "This is a
  sub-organization of this organization." or "The tree would have more than 3 levels."
- The list "Put under…" on the org chart holds the same organizations as the field, without "None"
  and without the parent now, because that pick changes nothing. "Move to the top" does the work of
  "None".
- A deleted organization gives its sub-organizations to its parent: their parent field becomes the
  parent of the deleted organization, or empty when it had none. The tree gets no deeper, and no
  agent gets off its line (see "One line").
- **Repair**: a state that breaks the rules of the tree is repaired at once, by a change of the
  parent field that syncs like any other change (019). The tree never stays broken, and no
  organization counts as a top organization only because its field is wrong. A break has one of two
  shapes, and it can come from a sync, from an import (014), or from the first copy of a sync.
  1. **A fourth level.** The app clears the parent field of the organization that would be on the
     fourth level. After an import, it checks from the top down. An organization that is cleared
     becomes a top organization, and the organizations under it count from their new level. After a
     sync, it clears the field of the organization with the latest parent change on that line of
     four organizations.
  2. **A loop.** The app clears the parent field of the organization with the latest parent change
     among the organizations of the loop. An import carries no time of change, because an export
     holds no sync records (014), so it uses the tie order below alone.
  - **Which change is later**: the time that sync (019) gives to the change, whichever computer
    made it. When the times are equal, the organization that was made later. When that is equal
    too, the organization with the later id. Both computers choose the same organization, so they
    end with the same tree.
  - **More than one break**: the app clears one field for each break, nearest the top first, and
    checks again, until the tree holds the rules.
  - **When it runs**: on the computer that finds the break first. After a sync, it waits until no
    change has come from the other computer for about 1 second, and each new change moves the wait
    back. The sync sends no sign of its end, and a computer of an older step must still work with
    this one (019). A set of changes that comes together is not cut in the middle. The repair also
    runs at the end of a first copy (019), after an import, and at the start of the app. The
    repaired field syncs, and the other computer finds nothing to repair.
  - **The notice**: each repair writes one line to the organization log (014), and the open org
    chart shows the line "The parent of <name> was cleared. The tree would have a loop." or "The
    parent of <name> was cleared. The tree would have more than 3 levels." at the bottom of the
    canvas for 10 seconds. A repair is not a change of the user, so it makes no notification and
    has no Undo.

## One line

An agent can be a member of more than one organization only when all of them are on one line.

- **On one line**: two organizations are on one line when one of them is a higher organization of
  the other. The organizations of an agent are on one line when each two of them are. So they all
  sit on one way down the tree, from a top organization to a lower one. With "Docs" under "Product"
  and "Site" under "Docs", an agent can be in "Product" and "Site", or in "Docs" and "Site", or in
  all three. It cannot be in "Docs" and "Ops", or in two sub-organizations of "Product", because
  neither organization of such a pair is higher than the other.
- **The deepest organization** of an agent: the one of its organizations that is lower than all the
  others. An agent in no organization has none. The organization prefix (036) uses it.
- **The check**: the app checks the line at each change of a member and at each change of the tree.
  The form, the menus and the drags of the chart (029), and a linked computer (012) use the same
  rules. An agent that is archived still counts, because it stays a member. A save of the form is
  checked as one change, with all its fields.
  1. **Add or move a member**: refused when the agent would be in an organization that is not on
     one line with another organization of the agent. The line is "<agent> is in <other>, which is
     not on one line with <organization>." <other> is the first of the conflicting organizations in
     the order of names, ignoring case. For a move, the check runs after the agent has left the
     organization that it comes from. A removal is always allowed.
  2. **A new parent organization** (the field "Parent organization", "Put under…", "Move to the
     top", the drag of a node): refused when it would put the organizations of any agent off one
     line. The line is "<agent> is in <A> and <B>, which would not be on one line." <agent> is the
     first such agent in the order of names, and <A> and <B> are the first such pair in the order of
     names, ignoring case.
  3. **The lists**: an organization that the check refuses shows muted in the field "Parent
     organization" and in the lists "Put under…", "Add to organization…" and "Move to
     organization…", with a short reason: "Not on one line with <other>." for a member, "Would split
     the line of <agent>." for a parent. The reasons of the tree stay (see "Organization tree"). In
     the field "Members" of the form, an agent that cannot be added shows muted, cannot be ticked,
     and has the line "In <other>."
- **Delete**: the sub-organizations of a deleted organization move up to its parent (see flow 4).
  Moving up never breaks a line, and it never makes the tree deeper.
- **Repair**: a state that breaks the line is repaired at once, by the removal of a member. The
  removal syncs like any other change (019). A break can come from a sync (two computers added the
  same agent to two organizations that are not on one line, or one computer moved an organization
  while the other added a member), from an import (014), from the first copy of a sync, and from the
  migration (see "Migration"). The app repairs the tree first (see "Organization tree"), and then
  the lines.
  - For one agent that is off the line: among its organizations that are in at least one pair that
    is not on one line, the app removes the agent from the one that it joined last. It checks again
    and goes on until the organizations of the agent are on one line.
  - **Which was joined later**: the time that sync (019) gives to the change that made the agent a
    member. When the times are equal, the organization that was made later. When that is equal too,
    the organization with the later id. An import carries no time of change, because an export holds
    no sync records (014), so it uses the tie order alone. Both computers choose the same
    organization, so they end with the same members.
  - A member that is removed is no longer the lead of that organization.
  - **When it runs**: as the repair of the tree does (see "Organization tree", "When it runs").
  - **The notice**: each removal writes one line to the organization log (014): the agent, the
    organization, the kind "line" and the time. The open org chart shows the line "<agent> was
    removed from <organization>. It is in <other>, which is not on one line with it." at the bottom
    of the canvas for 10 seconds. A repair is not a change of the user, so it makes no notification
    and has no Undo.

## Access

Each organization holds three items of access. Tools and the daily token limit go down the tree: a
member gets the tools of each organization that it is a member of, and of the higher organizations
of those, and every limit of those organizations holds for it. The hand-off range does not go up to
a member of a lower organization: a member counts only for the organizations that it is a member
of, each with its own value, or with the value that it takes from its parent when it is "Inherit"
(see "Who can send to whom").

- **Tools** and **Hand-off range** have the value "Inherit" by default. "Inherit" means: take the
  value of the parent organization. A lower organization can set its own value, and that value then
  goes down to its own lower organizations.
  - **The value of an organization** is its own value when it is not "Inherit". Otherwise it is the
    value of its parent, and so on up to the top organization. A top organization with "Inherit"
    has no tool, and the hand-off range "Own organization".
  - The form shows a value "Inherit" with a muted line "Now: <value> from <organization>", or "Now:
    none" for a tool that nobody gives.
- **Daily token limit** has no "Inherit". The limit of an organization and the limits of its higher
  organizations all hold at the same time.
- An agent that is a member of more than one organization gets the access of each one. Tools that
  these organizations give add up. For the hand-off range, the widest range holds. For the daily
  token limit, every limit holds.
- A change counts from the next turn, the next send, or the next task. A turn that runs keeps what
  it started with.
- Permission levels and permission rules (007) do not change. A tool that an organization gives
  asks the same approvals as before. The review of the tools of a connection (018) does not change.

### Tools

- In the form, the part "Tools" lists the skills (017) and the connections (018) of this computer.
  Each row has the value "Inherit", "On" or "Off".
- The value is the same fact as the list "the agents that may use it" in the skill (017) or the
  connection (018). That list can hold agents and organizations. An organization in the list has
  the value "On" or "Off". An organization that is not in the list has the value "Inherit". A form
  of a skill or a connection shows the organizations in its picker, with the mark "organization",
  and the value of each. "All agents" stays as it is.
- An agent may use a skill or a connection when "All agents" is on, or the list holds the agent, or
  the value of at least one organization that the agent is a member of is "On". "Off" in an
  organization takes away only what that organization would get from its higher organizations. It
  does not take away a tool that the agent gets from another organization, from its own entry in the
  list, or from "All agents".
- The agent may use it wherever that skill or connection works (017, 018), also in its direct chat.
- An agent that leaves an organization loses the tools of that organization from its next turn.
- Skills and connections do not sync (019). So the tools of an organization are a fact of each
  computer. The other computer of a sync pair shows the part with its own skills and connections.

### Daily token limit

- In the form, the field "Daily token limit" is off by default. On, it takes a number from 10,000
  to 100,000,000 tokens.
- **What counts**: the tokens (005, "Usage of a task") of each task of an agent that is a member of
  this organization or of one of its lower organizations, on the day. Every source counts: a chat, a
  channel, another agent, a routine, a workflow, a card of the board, an outside program, Teams,
  the summary of older messages, and the looks of the line for its questions. A task counts once in
  each organization that its agent is a member of, and once in each higher organization of those. An
  organization counts a task once, also when the agent is a member of it and of one of its lower
  organizations.
- **The day**: from midnight to midnight in the time of the computer that runs the task. Tasks of
  both computers of a sync pair count when they have synced.
- At 80% of the limit, the form shows the muted line "80% of the daily token limit is used." It
  makes no notification.
- **At the limit**: no new task of those agents starts. A part, a nudge, a check, a reply to a
  mention, or a task of another source that would start ends at once as Blocked (005) with the
  reason "The daily token limit of <organization> is used." A look of the lead or of the line passes
  the question to the user with that reason. A turn that runs goes on to its end. Its tokens still
  count.
- **A task from a direct chat** is never stopped by the limit. It counts in the limit.
- **More than one limit**: the limit of a higher organization stops the members of its lower
  organizations too. When more than one limit is used, the reason names the organization that comes
  first in the order of names, ignoring case.
- An agent in no organization has no limit.
- The blocked tasks show on Today (021) as other blocked work does. Retry works after the next
  midnight, or after the user raises or turns off the limit.
- The usage page (006) shows, for each organization with a limit, the tokens used today and the
  limit.

### Hand-off range

- In the form, the field "Hand-off range" has four values: "Inherit" (the default), "Own
  organization", "Own and lower organizations", and "All agents". It says to whom a member may send
  work when the hand-off rule is "Along the organizations".
- With the hand-off rule "Any agent", the range has no effect. The form then shows the muted line
  "The hand-off rule is 'Any agent'. The range has no effect."
- See "Who can send to whom".

## Who can send to whom

With the hand-off rule "Along the organizations", the app checks each "send message" (007) at the
time of the send. The sender S may send to a receiver R when R is not archived and one of these
holds:

1. S and R are members of one organization.
2. R is the main agent (002).
3. S is the main agent.
4. S is the lead of an organization C, and R is the lead of the parent organization of C, or the
   lead of a sub-organization of C.
5. S is a member of an organization whose range is "Own and lower organizations", and R is a member
   of that organization or of one of its lower organizations.
6. S is a member of an organization whose range is "All agents".

The range of an organization is its value of "Hand-off range" (see "Access"). Rules 5 and 6 read
the organizations that S is a member of, and not the higher organizations of those. "Own
organization" is the range that rule 1 gives, so it adds no right.

More rules:

- An archived lead counts as no lead (see "Concepts").
- An agent in no organization can send only to the main agent. With no main agent, it can send to no
  agent.
- A send that the rule does not allow fails. No task starts. The step shows the reason "<R> is not
  on your path. Send it to <A>." The sender gets the reason as a failed step, and its turn goes on.
  - **A chain**: a row of agents from S to R in which each agent may send to the next one by the
    rules above. The rule applies to the first send only. A chain of 2 agents is a send that the
    rule allows. <A> is the second agent of the shortest chain from S to R.
  - **Equal chains**: when more than one first agent gives a chain of the same length, the lead of
    an organization of S comes first, then the main agent, then the other agents in the order of
    their names, ignoring case. "An organization of S" is an organization that S is a member of; the
    lead of an organization is a member of it. A lead that S reaches only by rule 4 (the lead of a
    parent organization or of a sub-organization) is in the last group, unless it also leads an
    organization that S is a member of. Agents in the same group go by name too. Names are unique,
    ignoring case (002), so the order of names is complete.
  - **No chain**: when S has no chain to R, the reason is "<R> is not on your path, and no agent
    can pass it on. Tell the user."
- A refused send is not a hand-off of the org chart (029). It counts for no limit of 005.
- The reply of a receiver always comes back to the sender (007). A reply is not a send.
- The rule does not touch the work that the user gives: a direct chat, a channel job, a mention
  in a channel or in a direct chat (003, 004), `@all`, the fast pick, a routine, a workflow, a
  card of the board, and the parts that a lead gives in its own channel. Channels give no right
  to send.
- **List agents**: with "Along the organizations", the tool "list agents" (007) gives only the
  agents that the sender may send to. Each row also gives the organization that gives the right
  (the shared one, the one of the lead, or the one of the range), or the words "main agent". The
  tool tells the agent that the rule is on, and that work for other agents goes through the agents
  on the list.
- **Main agent**: it is told that every agent can bring work to it, and that it passes work on along
  the organizations: to the lead of an organization when the organization has one.
- A change of the rule, of a range, or of a member counts from the next send. A send that started
  before the change ends as it started.
- The rule holds in the same way for agents that use the tools of the app and for agents on each
  vendor runtime (006), because the app checks the send.

## Ask up the line

This section adds a step to "Questions of members" (004). It applies only when "Ask up the line" is
on.

- **Kind of a pass**: when the lead of the channel passes a question, it names one of two kinds:
  "Only the user can choose" (a choice of taste, money, a payment, a message or a file that leaves
  the computer, a deletion, an account, a key or a secret) or "Not sure". A pass for the time limit
  is the kind "late". A failure of the lead is the kind "failure".
- A pass of the kind "Only the user can choose" goes to the user at once, as in 004. Nobody else
  looks at it.
- A pass of another kind goes to the next agent on the line. The line is for the member that asks,
  in this order:
  1. The leads on the way up from its deepest organization (see "One line"): the lead of that
     organization first, then the lead of its parent, and so on up to the top organization. An
     organization shows once on the way.
  2. The main agent.
- An agent of the line is skipped when it is archived, blocked by a usage limit, the member that
  asks, or an agent that already looked at this question (the lead of the channel too). The line
  has at most 3 agents after the lead of the channel. Agents after the third are skipped. A member
  in no organization has the main agent only.
- Each agent of the line reads what the lead of the channel reads (004, "What the lead reads"), and
  also the reason of each pass before it. It does exactly one of two things, as the lead does:
  answer, or pass with a kind and a reason.
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
  limit of the organizations of the agent that looks. It is not a hand-off of the org chart (029).
- An approval card never goes up the line. Only the user answers an approval.
- The answer of an agent of the line is not words of the user (007).
- Each look writes one line to the channel log (014), as a look of the lead does, with the place of
  the agent on the line.

## Migration

The first start of this version changes the data of each profile once.

- **Which channels make an organization**: a channel that has a parent channel, a sub-channel, a
  tool, or a daily token limit makes one. When the hand-off rule is "Along the channels", every
  channel with two or more members makes one too, so that no path of work is lost. Archived channels
  count, so that nothing is lost. A channel with none of these makes no organization.
- **What the organization gets**: the name of the channel (a taken name gets a number, ignoring
  case, inside the length limit), its members, its lead, its daily token limit, its tools (a channel
  in the list of a skill or a connection becomes the organization with the value "On"), and as
  parent the organization of the parent channel. The hand-off range of each organization is
  "Inherit".
- **What the channel loses**: its parent channel, its tools and its daily token limit. The channel
  keeps its name, topic, instructions, members, lead, settings, picture and messages.
- **The hand-off rule**: the value "Along the channels" becomes "Along the organizations". "Any
  agent" does not change. "Ask up the line" does not change.
- **The limit counts more**: after the migration, a daily token limit counts the tasks of the
  members from every source (see "Daily token limit"), not only the tasks of one channel.
- **Agents in channels that do not make one line**: the organizations that the migration makes can
  hold an agent in organizations that are not on one line (the agent was in two channels with no
  parent between them). The migration then applies the repair of "One line", but it takes the
  channel that was made first as the one that the agent joined first (a tie goes to the lower
  id). The agent stays a member of that channel, and it keeps its place in the other channel. Each
  removal from an organization writes one line to the organization log. This can take away a path
  of hand-off that a shared channel gave under the rule "Along the channels".
- **Two computers**: two computers of a sync pair that migrate before they sync end with the same
  organizations, not with doubles. Both must hold this version to sync (019).
- **Older agent files**: a file made before this version may hold a parent channel or a daily token
  limit for a channel. The import ignores them.

## Surfaces

- **Ways in**: the org chart (029): "New organization", a click on a node, and the menus and drags
  of "Edit on the chart". The button "New agent" and the row "Workflows" of the form. The row
  "Organizations" of the agent profile (002). The settings part "Hand-off
  rules" (hand-off rule, ask up the line). The forms of skills and connections (organizations in the
  picker). No key, no command of the message box, and no entry in the search of the place list.
- **Devices**:
  - The computer can do all of this.
  - A linked computer (012) with the switch "Can create and change agents" can make, edit and
    delete organizations, set the hand-off range and the daily token limit, and edit on the chart.
    The same switch allows the button "New agent" of the form. It cannot change the part "Hand-off rules", the tools of an organization, skills or connections
    (012). It sees them read-only. Without the switch it sees the form read-only, and it changes
    nothing.
  - The phone (011) shows the organizations in the list of the org chart, the blocked parts with
    their reasons, and a refused send as a failed step on a tool card, with the text of the step.
    The phone does not translate that text. The phone changes nothing of this spec.
  - Each profile (022) has its own organizations, its own part "Hand-off rules" and its own tools.
- **Runtimes**: the hand-off rule, the line and the token limit are checked by the app. They are
  the same for agents that use the tools of the app and for agents on each vendor runtime (006). A
  vendor runtime gets the skills and connections of its organizations in the way 017 and 018 give
  their own skills and connections to it.
- **Ways out**: "Parent organization" back to "None". A value of access back to "Inherit". The
  hand-off rule back to "Any agent". "Ask up the line" off. The daily token limit off. A member,
  the lead or the parent changed on the chart has Undo (029). A delete asks first (flow 4) and has
  no Undo, because an organization holds no work, only these settings.
- **Seeing the state**: the tree, the goal, the lead mark, the counts and the outcome on the org
  chart; the line of the rule in the legend of the chart (029); the reason of a refused send in the
  step; the pass lines on a question card; "From <organization>" and "Organizations" in the agent
  profile; the line of 80% in the form; the blocked parts; the usage page. All hold after a restart.
- **Words**: Organization, Parent organization, Sub-organization, Top organization, On one line,
  Deepest organization, Access, Inherit,
  Hand-off range, Hand-off rules, Hand-off rule, Any agent, Along the organizations, Ask up the
  line, Tools, Daily token limit (see the glossary).

## Data

- **Sync (019)**: an organization syncs with its name, goal, members, lead, parent organization,
  hand-off range and daily token limit. The hand-off rule and "Ask up the line" sync as data of the
  agents, like the handbook (002): a change on one computer counts on the other after it syncs, and
  the later change wins. The organizations in the agent lists of skills and connections do not sync,
  because skills and connections do not sync. The usage of today of an organization is computed
  from the tasks that synced.
- **Export (014)**: the archive holds the organizations with all their fields, the hand-off rule,
  "Ask up the line", and the organizations in the agent lists of skills and connections.
- **Agent file (002)**: holds no organization, no hand-off rule and no "Ask up the line". Those
  belong to the profile. An organization in a file is not in this version.
- **Workflow file (010)**: holds nothing of this spec.
- **Owner of a workflow (010)**: the owner syncs with the workflow. The export (014) holds it. An
  organization that is deleted leaves its workflows with no owner.
- **Phone cache (011)**: no change.
- **Organization log (014)**: one line for each repair of the tree and of a line (the organization,
  the agent for a line, the kind and the time), and one line for each send that the hand-off rule refused, with the sender, the
  receiver and the time, and no text of the message.
- **Channel log (014)**: one line for each look of the line (see "Ask up the line").

## Out of scope

- Membership that goes down or up the tree, and instructions of a channel that go down the tree.
- A link between a channel and an organization, a channel that gives access, and a part that a lead
  gives to a whole organization.
- Archive and restore of an organization. An organization holds no work, so a delete with a confirm
  is enough.
- A picture or a section for an organization. The goal is not a picture and not a section.
- A rule of its own for each agent. The hand-off rule is one rule for the profile.
- A token limit for an agent, a week or a month, or a cost in money.
- A model, an effort, a permission level or a workspace that an organization gives to its members.
- A reporting line on an agent, or a field "reports to" (029).
- Approvals that go up the line. Only the user answers an approval.
- A retrospective that saves by itself, and a proposal that changes a permission level, a
  workspace, a model or an organization.
- Reviews of the work of an agent, and scores. The chart shows the counts of 029, not a grade.
- Organizations in an agent file.
- A member of organizations that are not on one line (see "One line").
- A choice of the organization that the prefix of 036 shows.

## Acceptance

- Make organizations "Product", "Docs" and "Site" with the form. Set the parent of "Docs" to
  "Product" and of "Site" to "Docs". The parent field of "Product" shows "Docs" and "Site" muted
  with "This is a sub-organization of this organization." A fourth organization under "Site" is
  refused with "The tree would have more than 3 levels."
- A new organization with no member shows as a node with the muted line "No members."
- Goal: set the goal of "Docs" to "Ship the Docs site." The node "Docs" on the chart shows that line
  under its name, and a member of "Docs" answers a message in its direct chat with the goal in its
  turn. Add "Write only in English." to the instructions of that agent: the instruction wins. An
  agent that is in no organization reads the goal of none.
- A goal of 401 characters is refused with the reason in words. An empty goal gives the agent
  nothing, and the node shows no goal line.
- Retrospective: an organization "Docs" whose members have 5 parts with the verdict "Not met" and 1
  with "Met". The menu of its node has "Look back…". After the answer, one to three proposals show.
  A proposal of the kind "Instructions" opens the profile of its agent with the new text in the
  field, and nothing is saved until the user saves it. A proposal of the kind "Skill" opens the skill
  form filled in. Close every form without saving: the profile of the agent and the list of skills
  are the same as before.
- The request of a retrospective holds the labels and the verdicts, and no message, no prompt, no
  thinking and no tool output.
- An organization with no member: "Look back…" is refused with the reason in words and no request is
  made.
- An agent is a member of "Product" and of "Docs" under it: its turn holds the goal of "Product"
  before the goal of "Docs", and the goal of "Docs" before its own instructions.
- Make an organization named "product": it is refused, because the name is taken (the check
  ignores case).
- Delete "Product" that has the sub-organization "Docs", and no parent: the confirm says "1
  sub-organization becomes a top organization." After "Delete", "Docs" is a top organization, and its
  members are still agents. "Product" is gone from every skill list.
- "Site" is under "Docs", and "Docs" is under "Product". Delete "Docs": the confirm says "1
  sub-organization moves up to Product." After "Delete", "Site" is under "Product". A member of
  "Product" and "Site" is still a member of both.
- One line: "Docs" is under "Product", and "Ops" is a top organization. Agent A is a member of
  "Docs". Add A to "Product": it works. Add A to "Ops": it is refused with "A is in Docs, which is
  not on one line with Ops." The form of "Ops" shows A muted, with "In Docs.", and A cannot be
  ticked. The menu "Add to organization…" of A shows "Ops" muted with "Not on one line with Docs."
- "Docs" and "Site" are two sub-organizations of "Product". Agent B cannot be in both: it is
  refused. B can be in "Docs" and in a sub-organization of "Docs".
- A is a member of "Product" and "Docs" (on one line). Put "Docs" under "Ops" (a top organization):
  it is refused with "A is in Docs and Product, which would not be on one line." "Move to the top"
  on "Docs" is refused in the same way. In "Put under…", "Ops" shows muted with "Would split the
  line of A." Remove A from "Product": the move works.
- A is a member of "Docs" and "Product", and "Ops" is a sub-organization of "Product". "Move to
  organization…" from "Docs" to "Ops": A is a member of "Product" and "Ops", and not of "Docs". The
  check ran after A left "Docs", so the move worked.
- The repair of a line: before two computers sync, computer 1 adds agent A to "Docs" and computer 2
  adds A to "Ops". The two organizations are not on one line. After the sync both computers hold A
  in the organization where A was added first, and not in the other. The line "A was removed from
  <organization>. It is in <other>, which is not on one line with it." shows on the open chart, and
  the organization log has one line. If A was the lead of the organization that it left, that
  organization has no lead.
- An import holds an agent in two organizations that are not on one line: after the import, the
  same repair has run, with the tie order of "One line", and the organization log has a line.
- An import holds a fourth level and a loop: after the import, the same repairs have run. Each
  repair has a line in the organization log.
- Two computers sync. Before they sync, computer 1 puts "Docs" under "Site", and computer 2 puts
  "Site" under "Docs". After the sync both computers hold the same tree: the parent field of the
  organization with the later change is cleared, and the line "The parent of <name> was cleared. The
  tree would have a loop." shows on the open chart. The tree has no loop.
- The organization "Docs" is under "Product". Its menu on the chart shows "Put under…" with the
  organizations that the tree allows, but not "Product". "Move to the top" is on the menu.
- Tools: turn "On" the skill "Release notes" in "Product". A member of "Site", which is under "Docs",
  which is under "Product", has the value "Inherit" in both lower organizations. It gets the skill
  in its next turn, also in its direct chat. Its profile shows "From Product". The form of "Site"
  shows "Now: On from Product". The skill form shows "Product" in its list with the mark
  "organization".
- Set the skill to "Off" in "Docs": the members of "Docs" and of "Site" lose it from the next turn.
  The members of "Product" keep it. Set it to "On" in "Site": the members of "Site" have it again.
  A member of "Docs" that is also a member of "Product" keeps the skill.
- "All agents" is on for a skill: "Off" in "Docs" takes nothing away.
- Remove a member from "Site": its next turn has no such skill.
- A connection given by an organization asks the same approval as before for a risky tool.
- Daily token limit of 50,000 on "Docs". Two members of "Site" (under "Docs") ran tasks that the
  stand-in provider reports as 41,000 tokens in all, from a chat, a part and a routine: the form of
  "Docs" shows "80% of the daily token limit is used." A part reaches 51,000: the turn goes to its
  end. The next part ends as Blocked with "The daily token limit of Docs is used." Today shows it.
  Raise the limit to 100,000 and press Retry: the part runs.
- The limit is used: a new message of the user in the direct chat of a member still starts a task,
  and its tokens count.
- The limit of "Product" is used: a new part of a member of "Site" ends as Blocked with the reason
  that names "Product".
- An agent that is a member of "Docs" and of its parent "Product" runs 10,000 tokens: "Docs" counts
  10,000 and "Product" counts 10,000, not 20,000.
- Hand-off rule "Any agent": agent A of "Docs" sends to agent X in no organization. A task starts.
  The form of "Docs" shows the muted line about the range.
- Hand-off rule "Along the organizations", with main agent M, "Product" with lead P, and "Docs" under
  "Product" with lead D and member A:
  - A sends to D: a task starts.
  - A sends to M: a task starts.
  - A sends to P: the step fails with "P is not on your path. Send it to D." No task starts, and the
    chart draws no hand-off line.
  - D sends to P: a task starts. P sends to D: a task starts.
  - M sends to A: a task starts.
  - X, in no organization, sends to A: the step fails with "A is not on your path. Send it to M."
  - Turn off "Main agent" for M. X sends to A: the step fails with "A is not on your path, and no
    agent can pass it on. Tell the user."
  - A calls "list agents": the list holds D and M only, with "Docs" and "main agent".
  - M sends to A, and A replies: the reply comes back to M.
  - A channel has A and X as members: A still cannot send to X.
- Set the hand-off range of "Product" to "Own and lower organizations". The range of "Docs" is
  "Inherit". P sends to A: a task starts (rule 5). A sends to a member of "Site" under "Docs": a task
  starts. A sends to P: the step fails, because "Own and lower organizations" has no way up.
- Set the range of "Site" to "All agents". A member of "Site" sends to X in no organization: a task
  starts. A member of "Docs" still cannot.
- The same refused send by an agent on a stand-in vendor runtime fails in the same way.
- "Ask up the line" on. Member A of "Docs" (lead D, parent "Product" with lead P) asks a question in
  a channel whose lead L passes it as "Not sure". D looks first: the card shows "L: <reason>" and "D
  looks at it". D passes as "Not sure": P looks. P answers: the card shows "Answered by P". "Needs
  you" stays empty.
- The same, but P passes: M, the main agent, looks. M passes: the question is in "Needs you" with
  all pass lines, and one notification shows.
- L passes as "Only the user can choose": the question goes to the user at once. Nobody on the line
  looks.
- P does not answer in 2 minutes: M looks. M does not answer: the question passes to the user with
  "No agent on the line answered in time." The whole line after L took at most 5 minutes.
- The user answers while P looks: the answer of the user wins, and the look of P stops.
- Member A is in "Docs" and in "Site", which is under "Docs", and "Docs" is under "Product". L
  passes the question as "Not sure". The line is the lead of "Site", then D (lead of "Docs"), then P
  (lead of "Product"), and then M. After the third agent, the others are skipped (see above). An
  agent that leads two of these organizations looks once.
- A member in no organization asks: after L passes as "Not sure", M looks.
- "Ask up the line" off: a pass of L goes to the user, as in 004.
- An approval card in a part goes to the user only.
- Migration: before the update, "Docs" has the parent channel "Product", a tool and a daily token
  limit of 50,000, and the channel "Chat" has none of these. After the first start, the
  organizations "Product" and "Docs" exist, with the same members and leads, "Docs" under "Product",
  the tool "On" and the limit of 50,000 on "Docs". The channels "Docs" and "Product" have no parent
  field, no tool and no limit, and keep their messages. "Chat" has no organization.
- Migration with an agent in two channels that do not make one line: the channels "Docs" (made
  first) and "Ops" each have a tool, no parent, and the member A. After the first start, the
  organizations "Docs" and "Ops" exist, A is a member of "Docs" and not of "Ops", and the channel
  "Ops" still has A. The organization log has one line for the removal.
- Migration with the hand-off rule "Along the channels": the rule is now "Along the organizations",
  and the channel "Chat" with 2 members made an organization, so the two members can still send to
  each other.
- Two computers hold the same old data and migrate before they sync: after the sync each holds one
  organization "Docs", not two.
- Two computers sync. Change the hand-off rule on one: the other uses it after it syncs. The
  organizations, the hand-off ranges and the token limits show on both. The tools of an organization
  show on each computer with its own skills.
- Export a profile and import it into an empty profile: the tree, the limits, the ranges, the rule,
  "Ask up the line" and the organizations of skill lists are the same.
- A linked computer with "Can create and change agents" makes an organization and sets a parent. It
  sees the part "Hand-off rules" and the tools read-only. Without the switch, it sees the form
  read-only and changes nothing.
- Switch to the Korean interface: the fields, the reasons of a refused send, the pass lines, the
  token lines and the part "Hand-off rules" are Korean.
- Open the form of a new organization, press "New agent" next to Members, give the name "Ada" and a
  model, and save: the form of the organization is still open, "Ada" is in the members, and no
  direct chat opened. Pick "Ada" as the lead and save the organization: "Docs" has "Ada" as a
  member and as the lead.
- Press "New agent" and save the agent, then close the form of the organization without saving:
  "Ada" exists as an agent, in no organization, and "Docs" does not exist.
- The button "New agent" adds an agent who is in no organization, so "One line" never refuses the
  save because of it.
- The organization "Docs" owns the workflows "Weekly" and "Digest". The row "Workflows" of its form
  lists both. A click on "Weekly" opens it on the Workflows page. Delete "Docs": the confirm says
  that two workflows have no owner then, and after the delete both workflows show no owner.
- An organization with no workflow shows no row "Workflows" in its form and no line about workflows
  in its delete confirm.
- A linked computer without the switch "Can create and change agents" sees the button "New agent"
  off.
