# 036 Organization prefix

## Purpose

The user sees at once which organization an agent works in. The name of an agent shows with the
name of its organization in front of it, for example "[Docs] Ada". The stored name does not change.

## Concepts

- **Organization prefix**: the text "[<organization>]" and one space, in front of the name of an
  agent. <organization> is the deepest organization of the agent (030, "One line"). An agent in no
  organization has no prefix.
- **Shown name**: the prefix and the name, for example "[Docs] Ada". The prefix is a muted label,
  and the name keeps its look. The name that the app stores does not change.
- **Prefix text**: the first 16 characters of the name of the organization. When the name is
  longer, the text ends with "…". The whole name shows in a note when the pointer rests on the
  prefix, and a screen reader reads "<name>, <whole organization name>".
- **Switch "Show the organization before an agent name"**: a setting of this computer. It is on at
  first (see 013, "Appearance"). The phone has its own switch (see 011). A linked computer (012)
  uses the switch of the computer that shows the name.

## Rules

- **What the prefix is made of**: the deepest organization of the agent now. It changes at once when
  the agent joins or leaves an organization, when the organization is renamed, and when the switch
  changes. It shows on old messages too, because the name on a message is a label of the agent, and
  the app draws it from the agent as it is now.
- **Where it shows**: wherever the window shows the name of an agent as a label, as the sender of a
  message, or as the owner of a piece of work. These are:
  - the place list: the rows of agents, also in the compact list, in "Pinned" and in user sections,
    and the results of the search of places (001, "Place rows");
  - the header of a direct chat (003);
  - the header line of each message of an agent, and the sender of a quoted reply (003);
  - the mention list (see below), and the lists of members and of the lead of a channel (004);
  - the rows of tasks, Today, "Needs you", the cards of the board, and the cards of approvals and
    questions (005, 021, 024);
  - the rows of agents on the usage page (006), in the archive list (013), and in the pickers of
    agents of skills, connections, routines and workflows (010, 009, 017, 018);
  - a linked computer (012) and the phone (011), in the same places.
- **Where it does not show**: the org chart (029), because each node sits in the node of its
  organization, and the form of an organization (030). The name field of the form of an agent and
  of its profile: they show the stored name. A name inside a sentence, for example "A works in
  Docs." or "<agent> looks at it". The text that a model reads: the names that an agent sees in its
  prompt, in the result of "list agents", and as the target of "send message" are always the stored
  names. Files and exports, logs, the Teams link (028), system notifications (015), the menu bar
  item and the title of the window.
- **Order**: the order of agents never follows the prefix. Each list keeps its order.
- **Mention**: in the mention list (004) each agent shows with its prefix, for example "[Docs]
  Ada". The user types after "@", and the list shows the agents whose name or whose whole
  organization name matches, with the match rule of the list. The text that the pick puts in the
  message box is "@Ada", with no prefix, and the sent message holds "@Ada" (004).
- **Search of places** (001): the search text matches the name of an agent, its role line (001) and
  the whole name of its deepest organization.
- **A name that is too long**: the prefix is cut as "Prefix text" says. In a place row the badge is
  cut first and then the name (001, "Place rows"), and the prefix is cut last.
- **Switch off**: no prefix shows anywhere. The mention list and the search of places do not match
  the organization name.
- **Cost**: the prefix is computed from data that the app has. It adds no request to a model, no
  task and no sync.

## Flows

1. The user opens Settings → Appearance and sees the switch "Show the organization before an agent
   name", on. The place list shows "[Docs] Ada" for Ada, a member of "Docs".
2. The user turns the switch off. Every prefix goes within 1 second. The user turns it on, and they
   come back.
3. The user adds Ada to "Product", the parent of "Docs". The prefix stays "[Docs]", because "Docs"
   is the deepest. The user removes Ada from "Docs": the prefix is "[Product]".
4. The user renames "Docs" to "Documentation". Every prefix of its members changes within 1
   second, also in the open conversation.
5. The user types "@" and "doc" in the message box of a channel. The list shows "[Docs] Ada". The
   user picks it. The box holds "@Ada".

## Surfaces

- **Ways in**: the switch in Settings → Appearance (013) on the computer, and the switch in the
  Settings of the phone (011). No key, no command of the message box and no entry in the search.
- **Devices**:
  - The computer shows the prefix as above.
  - A linked computer (012) shows the prefixes of the agents of the linked server. A read of the
    organizations of that server needs only the link. The switch is the one of the computer that
    shows the name. The state of the switch does not change the other computer.
  - The phone (011) shows the prefix in the places list, the header of a conversation, the header
    line of a message, the cards that name an agent, and the mention list. It has its own switch,
    in the part "Chat" of its Settings, on at first. The org chart list of the phone (029) shows
    no prefix.
  - Each profile (022) has its own organizations, so its own prefixes. The switch is a setting of
    the computer and holds for every profile of it.
- **Runtimes**: no change. A model never reads a prefix, so an agent on a vendor runtime (006) and
  an agent that uses the tools of the app act in the same way.
- **Ways out**: the switch off. An agent leaves its organizations, and the prefix goes with it.
- **Seeing the state**: the prefix itself, the switch in the settings, and the note on the prefix.
  All hold after a restart.
- **Words**: Organization prefix, Shown name, Show the organization before an agent name (see the
  glossary).

## Data

- **Sync (019)**: nothing is stored for the prefix, so nothing syncs for it. The organizations sync
  (030). The switch is a setting, and settings are local (019).
- **Export (014)**: the archive holds the switch like the other settings. It holds no prefix.
- **Agent file (002)** and **workflow file (010)**: hold nothing of this spec.
- **Phone cache (011)**: holds the name of the deepest organization of each agent that the phone
  shows, as it holds the role line of an agent. The prefix changes on the phone after the next
  read of the server.

## Out of scope

- A prefix for a channel, a prefix with the whole path ("[Product / Docs]"), and a choice of the
  organization that shows when an agent has more than one.
- A colour or a picture for an organization.
- A prefix in a system notification, in the Teams link, in a file or in the text of a model.
- A prefix inside a sentence, and in the name field of the form of an agent.

## Acceptance

- Make "Docs" with Ada, and Ada's row in the place list shows "[Docs] Ada" with the role badge after
  the name. The stored name in the form of the agent is "Ada".
- Turn the switch off in Settings → Appearance: the row shows "Ada". Turn it on: "[Docs] Ada" is
  back. Restart: the switch keeps its state.
- Ada is in "Docs" under "Product". Add Ada to "Product": the prefix is "[Docs]". Remove Ada from
  "Docs": the prefix is "[Product]". Remove Ada from "Product": no prefix.
- Rename "Docs" to "Documentation" while the conversation with Ada is open: the header, the message
  headers, and the row show "[Documentation] Ada" within 1 second. An old message shows the new
  prefix too.
- An organization with the name "Research and Development Group" shows "[Research and Dev…]" in the
  row. The note on the prefix shows the whole name. A screen reader reads "Ada, Research and
  Development Group".
- An agent in no organization shows no prefix. The org chart shows "Ada" with no prefix, in the node
  of "Docs".
- Type "@doc" in the message box of a channel with Ada: the list shows "[Docs] Ada". Pick it: the
  box holds "@Ada". Send: the message holds "@Ada", and the agent gets its message as before. With
  the switch off, "@doc" shows no agent unless a name matches.
- Type "docs" in the search of places: the row of Ada shows. The order of the rows does not change.
- The tool "list agents" of Ada gives the names with no prefix, and "send message" to "Bo" works.
- Archive Ada: the row in the archive list shows "[Docs] Ada".
- Two agents in two organizations that have long names show the prefix cut, and the name is cut
  after it, with the role badge hidden first (001).
- On a linked computer, the places list of the server shows "[Docs] Ada". Turn the switch off on
  that computer: its rows lose the prefix, and the other computer keeps its own.
- On the phone, the places list and a conversation show "[Docs] Ada". Turn off its switch: the
  prefix goes. The org chart list shows "Ada" with no prefix.
- Switch to the Korean interface: the switch and the notes are Korean. The organization name keeps
  its own text.
- No request to a model, no task and no sync item is made when the prefix changes.
