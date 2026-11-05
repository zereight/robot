# 001 Window layout

## Purpose

One window shows everything the user needs to direct agents, in the layout of a chat server, so a
new user knows where to look.

## Concepts

- **Server rail**: a narrow column at the far left edge of the window. One round tile per server,
  then an add button. The selected server has a short bar at its left side. The first tile is
  the open profile on this computer (see 022). Tiles of linked computers (012) follow in the
  order of pairing. A linked tile shows the first letter of the computer's name and the
  connection state (012).
- **Page buttons**: under the servers, icon buttons open whole pages: agents and chats, Today
  (see 021), workflows (see 010), routines (see 009), tasks, the board (see 024), the org chart
  (see 029), test devices (see 032), usage. The workflows button opens the workflow list. The
  routines button opens the routines list. Each page shows only its own list. At the bottom: help
  and settings, then the profile button
  when the computer has two or more profiles (see 022). The Today button shows a badge with the
  number of items in "Needs you" (021). The badge hides at 0, and it reads "99+"
  above 99. It hides when a linked server is on the screen.
- **Place list**: a column beside the rail. A search field at the top, then sections. A section has
  a name and its places. A place is an agent (direct chat) or a channel. The search field also
  searches messages (see "Message search").
- **Built-in sections**: Channels, then Agents. They always exist. The user cannot rename,
  delete or move them.
- **User section**: a group that the user makes inside Channels or inside Agents. It holds places
  of that one kind. See "User sections".
- **Organization section**: a group of the view "By organization" of Agents. It holds the agents
  whose deepest organization (036) is one organization. The app makes it. The user does not. See
  "Agents by organization".
- **Conversation**: the main area. A header line, the messages, and the message box at the bottom.
- **Activity panel**: a panel that shows who works on what in a channel, and the running tasks of a
  direct chat. It uses the panel column.
- **Panel column**: an optional column at the right of the window, used by one panel at a time: the
  activity panel, or the panel of the test devices connection (032). Each panel keeps its own width
  and its own open state. The user drags the left edge of the column to change its width, between 320
  and 720 px. The header buttons switch between the two panels.
- **Frame**: the part of the window that shows a panel of a program of another vendor (018, 032). It
  has a thin border, it fills the column, and it has no address of its own: the app gives it the
  addresses it may reach.

## Flows

1. The user clicks a server tile. The place list and the conversation change to that server.
   On a linked computer, the places and the pages work as 012 says. The plus buttons on the
   sections show only when that computer lets this device create and change agents.
2. The user clicks a place. The conversation opens it. The place row shows as selected.
3. The user types in search. The list shows only the places whose name matches, the agents whose
   role line or whose organization (036) matches, and a group of matching messages (see "Message search"). Escape clears
   it.
4. The user collapses a section by clicking its name. The app remembers this per section.
5. The user hides or shows the panel column with a header button. The app remembers this, and which
   panel it holds.
6. The user drags the edge of the place list to change its width, between 200 and 400 px.
7. The user clicks the add button on the rail. A dialog opens: "Connect to a computer" (012).
   The user can also remove a linked tile with its context menu.

## User sections

The Channels section holds channel sections. The Agents section holds agent sections.

### Layout

- Inside Channels, the places that are in no user section come first. The user sections follow,
  in the order the user set.
- Inside Agents, the user sections come first, in the order the user set. After them, the section
  "Unassigned" holds the agents that are in no user section. It is always last. It shows when
  Agents holds a place or a user section. When Agents holds neither, the list shows the empty
  line and does not show "Unassigned". The user cannot rename, delete or move it. It is not a
  user section, and it does not count toward the limit of 20. Its name is translated. The user
  can collapse it. A collapsed "Unassigned" shows the unread sum and the working dot, as a user
  section does. When it has no agent, it shows a short muted line. A drop on its header means no
  section, the same as a drop on the Agents header.
- A user section has a header like the built-in header: a chevron and the name, muted. It sits 12
  px further in. Its places sit 12 px further in too.
- A new user section is last, open, and empty.
- An empty user section shows a short muted line that tells how to put a place in it.
- A collapsed section (built-in or user) shows its header only. The header then shows the sum of
  the unread counts of its places, as a badge, and the working dot when one of its places works.
  The dot breathes as the dot of a place does (see "Place rows"). The sum of a built-in section
  includes the places of its user sections.

### Flows

1. Make: the user opens the menu of the Channels header or of the Agents header and picks "New
   section". A name box opens in the list. Enter saves. Escape cancels.
2. Rename, order, delete: the user opens the menu of a user section header (a button on hover,
   or right click, or a long press). It lists "Rename", "Move up", "Move down" and "Delete
   section". "Move up" is off for the first section, and "Move down" for the last.
3. Delete with places: the app asks to confirm. The text says that the places move out of the
   section and that nothing else is deleted. The buttons read "Delete section" and "Back". A
   section with no place is deleted at once.
4. Move a place: the menu of a place (right click, or a long press) has "Move to section". It
   lists the user sections of the kind of that place, and "No section". The current one is
   marked.
5. Drag a place: the user drags a place row onto a header of its kind: a user section, or the
   built-in header (which means no section). The header under the pointer shows as selected.
   A drag never opens the place. Escape cancels the drag. A header of the other kind does not
   accept the row.
6. Choose in a form: the form of a new agent or channel, and the profile or settings of an
   existing one, have a "Section" choice (see 002 and 004).

### Rules

- A section name has 1 to 40 characters, after spaces at both ends are removed. In one built-in
  section, no two user sections have one name, ignoring case. A channel section and an agent
  section may have one name.
- One built-in section holds at most 20 user sections, at all levels (see "Sections inside
  sections").
- A place is in at most one section. A channel with no section shows in Channels, before the
  user sections. An agent with no section shows in "Unassigned".
- Delete of a section moves its places to no section. It deletes no place.
- The order of the places inside a section does not change.
- The sections and the places in them belong to the server. The computer and the phone show the
  same ones. The open or closed state of a section belongs to the device (step 4 of "Flows"
  above).
- Section names are text of the user. They are not translated.
- The filter of places (step 3 of "Flows" above) looks at the names of places, at the role
  line of agents, and at the name of the deepest organization of agents (036). A place matches when
  the typed text is a part of its name, or of its role line, or of that organization name, ignoring
  case. A channel has no role line, so only its name counts, also when a member has a
  role that matches. Cmd+K focuses the same field. The order of the places does not change.
  Messages have their own group (see "Message search"), and it does not look at role lines. A
  section with no match hides, and a section with a match opens, also when it is collapsed.
- Up and down in the list move through the places that show, in the order shown. A collapsed
  section has no places that show.

### Sections inside sections

- A user section can hold user sections of the same kind. The depth is at most 3 levels of user
  sections.
- A header, and the places under it, sit 12 px further in for each level.
- The menu of a user section header also has "New section inside". "Move up" and "Move down" order
  a section among the sections of its own level. "Move to section" on a place lists the user
  sections of its kind as a tree. A section cannot move into itself or into a section inside
  itself.
- A collapsed section shows one sum of the unread counts. The sum covers its places and the places
  of the sections inside it. The working dot shows when one of these places works.
- Each profile (022) has its own sections. An export of a profile holds them with the layout
  (014).
- Delete of a section that holds places or sections asks to confirm. The text says that the places
  and the sections inside move up one level and that nothing else is deleted. For a section of the
  first level, they move to the built-in section.
- The rule for names holds across all levels of one built-in section. The limit of 20 counts all
  levels.
- The phone shows the tree and cannot change it, as for sections (011).

### Agents by organization

The menu of the Agents header has a choice of view: "My sections" and "By organization". The
choice that is on shows a mark. "My sections" is the view that "User sections" above describes. It
is on at first.

- **By organization**: Agents holds one organization section for each organization that is the
  deepest organization (036) of at least one agent that shows in Agents. The sections are flat: no
  section holds another. An agent shows once, in the section of its deepest organization. A pinned
  agent shows in "Pinned" and not in its section (see "Pinned places"). An organization that is
  the deepest organization of no agent that shows has no section.
- **Order**: the organization sections follow the names of the organizations, ignoring case. After
  them, the section "No organization" holds the agents that are in no organization. It is always
  last. It shows when Agents holds an agent. When none of them shows in it, it shows a short muted
  line. When Agents holds no agent, the list shows the empty line and no section. The user cannot
  rename it, and the user can collapse it. The agents inside a section keep the order that
  "My sections" shows them in: the agents of the user sections first, then the agents of
  "Unassigned".
- **Header**: it looks like the header of a user section: a chevron and the name, muted, 12 px
  further in, and the places 12 px further in too. The name of an organization section is the name
  of the organization. It is text of the user and is not translated. A long name is cut with "…",
  and the whole name shows in a note when the pointer rests on it. A collapsed header shows the
  unread sum and the working dot, as a user section does (see "Layout").
- **Read only**: the app makes and keeps these sections from the organizations (030). A header has
  no menu, and it does not accept a drag. "New section" in the menu of the Agents header and "Move
  to section" in the menu of an agent are off in this view, with the reason "Switch to My sections
  to change sections." The user sections do not change, and they show again when the user picks
  "My sections".
- **At once**: the sections change when an agent joins or leaves an organization, when an
  organization is renamed or deleted, and when the deepest organization of an agent changes.
- **Prefix**: a row of an agent under an organization section shows no organization prefix (036),
  because the header names the organization. A row in "Pinned" shows it.
- **Filter**: the filter of places works as "Rules" below says. The organization name of an agent
  is one of the texts it matches. A section with a match opens, also when it is collapsed.
- **What belongs to the device**: the choice of view, and the open or closed state of each
  organization section. They belong to the open profile (022) on this computer. They do not sync.
- **Linked computer**: the view groups the agents by the organizations of that computer (012). The
  menu of the Agents header shows on a linked computer too, and it holds only the choice of view.
- **Phone**: the phone has no choice of view in this version. It shows "My sections" (011).
- **Cost**: the sections come from data that the app has. They add no request to a model, no task
  and no sync.

## Pinned places

- "Pin" in the menu of a place (right click, or a long press) puts the place in a group "Pinned"
  at the top of the place list, above Channels. "Unpin" is in the same menu. A pinned place shows
  in this group and not in its section. After "Unpin" it shows in its section again.
- The group holds agents and channels, in the order of pinning, the oldest first. It holds at most
  10 places. At 10, "Pin" is off, with the reason in words. A place that is archived or deleted
  leaves the group.
- The group has a header that the user can collapse. A collapsed header shows the sum of the
  unread counts and the working dot, as other collapsed headers do.
- The filter of places looks at pinned places too.
- Pins belong to the server. The phone and a linked computer show the same group. They cannot pin
  or unpin: the menu of a place there has no "Pin" and no "Unpin" (011, 012).
- Each profile (022) has its own pins. An export of a profile holds them with the layout (014).
- Two computers that sync (019) do not sync pins. They are part of the layout of one computer.

## Message search

- The search field also looks inside messages. Under the sections, a group named "Messages"
  lists the messages that match. The group shows only when the text has at least 2 characters
  and at least one message matches.
- The search covers the text of sent messages of the user and of agents, in direct chats (every
  thread) and in channels, on the server on screen. It does not cover tool cards, thinking,
  files, memory, queued messages, or places that are archived.
- A message matches when it holds every word of the text. A word matches as a part of a word, so
  "bud" finds "budget", and the last word matches while the user still types it. The order of
  the words and the case of the letters do not matter. The app uses the first 6 words and ignores
  the rest.
- The first 20 hits show within 1 second when the server holds 50,000 messages.
- Hits come newest first, 20 at a time. While more hits exist, the last row of the group is
  "Show more". The app finds at most 200 hits. If more messages match, the group ends with a line
  that asks the user to type more words.
- A hit row shows the face, the picture or the `#` mark and the name of the place, the time, and a short
  piece of the message around the first matching word, at most 120 characters, with "…" at a cut
  end. The matching words are marked. The piece is plain text. The app does not read Markdown or HTML in it.
- A click on a hit opens the place, and the thread that holds the message. The chat scrolls to
  the message and flashes it, in the same way as a click on a quote (see 003). The "Back"
  control returns to where the user was.
- If the search runs for more than 300 ms, the group shows a muted "Searching…" line. If no place
  and no message match, the list shows a muted "Nothing found." line.
- On a linked server (012), the server runs the search. While the link is offline, the app
  searches the cache of saved messages only, and a muted line says so.
- When two computers sync (019), each computer searches its own copy.
- The app keeps no list of past search texts. No log holds a search text (014).

## Place rows

- One line, 34 px high: a 24 px avatar (see 002, "Avatars"): the face for an agent, or the
  picture or the `#` mark for a channel, then the name.
- An agent that is in an organization shows the organization prefix before the name (036), for
  example "[Docs] Ada". It is a part of the name for the cut below: the prefix is cut last. Under
  an organization section it does not show (see "Agents by organization").
- An agent with a role line shows it as a **role badge** after the name: a small, muted label with
  the role line on one line. An agent with no role line, and a channel, show no badge. The badge
  is text of the user and is not translated.
  - The name comes first: the badge is cut before the name is. When the row is too narrow, the
    badge is cut with "…" at its end. When the room is less than the width of 4 letters of the
    badge, the badge hides, and then the name is cut with "…" as before, if it is too long. The
    unread count stays at the right end, after the badge.
  - The badge shows in the compact place list, in the group "Pinned", in user sections, on a linked
    computer (012) and on the phone (011). It changes at once when the role line changes.
  - The whole role line shows in a note when the pointer rests on the badge, and it is part of the
    accessible name of the row.
- Names are muted. They are full contrast when the row is selected, hovered, or has unread
  messages.
- An unread count shows as a small badge at the right end.
- A working agent has a small success-colour dot on its face, with a thin soft ring of the same
  colour. A channel with work running has the same dot on its `#` mark. The dot breathes while
  the work runs, as 000 says: the dot and its ring grow and fade, without end. With reduce motion,
  the dot is still. A dot shows only while a place works, and it goes at once when the work ends.
- The row's accessible name includes the last message, but the row does not show it.
- A place that waits for the user stays in its own section and keeps its badge. There is no
  separate group for places that need the user.
- Right click (or a long press) on a place opens a menu. "Mark as read" clears the unread count of
  that place only, not of other places. "Mark as unread" marks the latest message of an agent as
  unread (see 003). The same menu has "Pin" or "Unpin" (see "Pinned places") and "Move to
  section" (see "User sections").

## Header

- Direct chat: the agent's face, name, model, the context meter (see 003), the list of threads, and
  the "Device" button (see 032).
- Channel: `#`, the name, a thin divider, then the topic in muted text. The topic truncates.
- A conversation on a linked computer (012) shows no "Device" button.

## States

- No server connected: the rail shows only the add button; the main area explains how to start.
- A linked server that is offline: its tile is muted, and the place list shows the cached places
  (012).
- No places in a section: the section shows a short muted line, not an empty gap.

## Rules

- Window width under 800 px: the rail narrows to 56 px, and the panel column closes.
- The panel column shows one panel. A press on a header button of the other panel switches to it.
  The app remembers which one is open.
- The rail leaves room for the window buttons at the top left.
- The rail, the place list, the pages and the selection belong to the open profile. A switch of
  profile changes all of them, and each profile keeps its own selection (022).
- Keyboard: Cmd+K focuses search. Cmd+F finds in the open chat (003); on a page that is not a
  chat it does nothing. Cmd+Shift+D starts and stops dictation (027). Up and down move through
  places. Enter opens one. The help button opens a page that lists these keys.
- **Quit**: Cmd+Q, and "Quit" in the menu of the menu bar item (015), quit the app. When no agent
  works and no task waits for the user, the app quits at once. When an agent works or a task
  waits, the first press shows a short note over the window: "Press Cmd+Q again to quit. N tasks
  are running." A second press within 3 seconds quits. Holding the keys down for 1 second quits
  too. A quit stops the running tasks as a restart of the app does (005).
- **Closing the window**: it does not quit the app. The agents go on working. The user opens the
  window again from the Dock icon or from the menu bar item (015).

## Acceptance

- Selecting a server, then a place, opens the right conversation; the selection survives a
  restart. This also holds for a linked computer.
- The add button opens the connect dialog.
- The Workflows button opens the workflow list. The routines list is not on that page. The
  Routines button opens the routines list. The workflow list is not on that page.
- At 760 px width, the panel column is closed and the rail is 56 px wide.
- Make the agent section "Research", then use "Move to section" on one agent: the agent shows
  under "Research" and not among the other agents. The other agents show in "Unassigned", and
  "Unassigned" is under "Research". The header of "Unassigned" has no menu. After a restart, the
  agent is still under "Research".
- Make the agent section "Research" again, with another case ("research"): the app refuses it. Make
  a channel section "Research": the app accepts it.
- Collapse a user section that holds an agent with 2 unread messages: its header shows the badge
  2. Open the section: the badge leaves the header and shows on the agent.
- Drag a channel onto the header of an agent section: the channel does not move. Drag it onto a
  channel section: it moves.
- Delete a section that holds two agents, and confirm: both agents show in "Unassigned", under any
  user section that remains. No agent is deleted.
- Type part of an agent name that is in a collapsed user section: the section opens and shows the
  agent. Escape clears the search and the section collapses again.
- Give one agent the role "Designer" and another the role "Writer". Type "design": only the first
  agent shows. Type "writ": only the second shows. Type the name of the second agent: it shows.
  Press Escape: both show.
- Give an agent in a collapsed section the role "Researcher". Type "researcher": the section
  opens and shows the agent. A channel with a member of that role does not show.
- An agent with the role "Qa tester" shows the badge "Qa tester" after its name. Remove the role:
  the badge leaves. A channel row never shows a badge.
- Set the place list to its narrowest width. An agent with a short name, a long role and unread
  messages shows the whole name, a badge cut with "…", and the unread count at the right end. An
  agent with a name of 40 characters shows its name cut with "…" and no badge.
- Send "The budget is 4200 euros" to an agent. Search "euros budget": the group "Messages" shows
  the message with both words marked. A click opens the chat at that message and flashes it.
  "Back" returns to the earlier place.
- Search one letter: the group "Messages" does not show. Send a message that holds the text `<b>bold</b>`.
  Search "bold": the hit shows the tags as plain text and does not make the word bold.
- Archive the agent: its messages do not match any more. Restore it: they match again.
- Cut the link to a linked server and search: only cached messages match, and a muted line says
  this.
- Make a section "Research" and a section "Papers" inside it, and move an agent into "Papers": the
  agent shows under "Papers", 24 px in. Collapse "Research": its header shows the unread count of
  the agent. Delete "Papers" and confirm: the agent shows under "Research". A fourth level is
  refused: "New section inside" is off on a section of the third level, with the reason.
- Pin an agent and a channel: the group "Pinned" shows both above Channels, oldest pin first, and
  neither shows in its section. Pin the 11th place: "Pin" is off with the reason. Unpin the agent:
  it shows in its section again. The phone shows the same group.
- Open the menu of a place and pick "Mark as unread": the place shows the count 1.
- Press Cmd+Q while a stand-in agent works: the note shows and the app stays. Press it again
  within 3 seconds: the app quits. With nothing running, the first press quits.
- A section "Research" holds a section "Papers". Try to move "Research" into "Papers": the app
  refuses. Make 20 sections across all levels: the 21st is refused.
- Pin an agent and archive it: it leaves the group. Type part of the name of a pinned agent in the
  search field: the agent shows in the filtered list.
- On a stand-in phone and a stand-in linked computer, the menu of a place has no "Pin".
- Give the agent Ada the organization "Docs". Give the agent Bob the organizations "Docs" and
  "API" ("API" is under "Docs"), and leave the agent Cy in no organization. Pick "By
  organization" in the menu of the Agents header: the sections are "API" with Bob, "Docs" with Ada,
  and "No organization" with Cy, in this order, and no section is inside another. No row shows a
  prefix. After a restart the view is still "By organization". Pick "My sections": the user
  sections and "Unassigned" show as before.
- In "By organization", an organization with no agent has no section. Pin Ada: "Docs" has no
  section, and the row of Ada in "Pinned" shows "[Docs] Ada". Unpin Ada: "Docs" shows again.
- In "By organization", the headers have no menu, a drag of an agent onto a header does nothing,
  "New section" in the menu of the Agents header is off with its reason, and "Move to section" in
  the menu of Ada is off with its reason.
- In "By organization", rename "Docs" to "Manuals": the section shows the new name at once, in its
  new place in the order. Remove Ada from the organization: she moves to "No organization".
- In "By organization", collapse "Docs" while Ada has 2 unread messages: the header shows the badge
  2. Type "api" in the search field: the section "API" opens and shows Bob, and "Docs" hides.
- On a stand-in phone, the Places list shows the user sections and has no choice of view.
- Press Cmd+F on the Today page: nothing happens. Hold Cmd+Q for 1 second while an agent works: the
  app quits. Close the window while an agent works: the agent goes on, and the Dock icon opens the
  window again.
