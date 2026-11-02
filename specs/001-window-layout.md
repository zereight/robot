# 001 Window layout

## Purpose

One window shows everything the user needs to direct agents, in the layout of a chat server, so a
new user knows where to look.

## Concepts

- **Server rail**: a narrow column at the far left edge of the window. One round tile per server,
  then an add button. The selected server has a short bar at its left side.
- **Page buttons**: under the servers, icon buttons open whole pages: agents and chats, workflows,
  tasks, usage. At the bottom: help and settings.
- **Place list**: a column beside the rail. A search field at the top, then sections. A section has
  a name and its places. A place is an agent (direct chat) or a channel.
- **Built-in sections**: Channels, then Agents. They always exist. The user cannot rename,
  delete or move them.
- **User section**: a group that the user makes inside Channels or inside Agents. It holds places
  of that one kind. See "User sections".
- **Conversation**: the main area. A header line, the messages, and the message box at the bottom.
- **Activity panel**: an optional column at the right. In a channel it shows who works on what.

## Flows

1. The user clicks a server tile. The place list and the conversation change to that server.
2. The user clicks a place. The conversation opens it. The place row shows as selected.
3. The user types in search. The list shows only places whose name matches. Escape clears it.
4. The user collapses a section by clicking its name. The app remembers this per section.
5. The user hides or shows the activity panel with a header button. The app remembers this.
6. The user drags the edge of the place list to change its width, between 200 and 400 px.

## User sections

The Channels section holds channel sections. The Agents section holds agent sections.

### Layout

- Inside a built-in section, the places that are in no user section come first. The user sections
  follow, in the order the user set.
- A user section has a header like the built-in header: a chevron and the name, muted. It sits 12
  px further in. Its places sit 12 px further in too.
- A new user section is last, open, and empty.
- An empty user section shows a short muted line that tells how to put a place in it.
- A collapsed section (built-in or user) shows its header only. The header then shows the sum of
  the unread counts of its places, as a badge, and the working dot when one of its places works.
  The sum of a built-in section includes the places of its user sections.

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
- One built-in section holds at most 20 user sections.
- A place is in at most one section. A place with no section shows in the built-in section.
- Delete of a section moves its places to "No section". It deletes no place.
- The order of the places inside a section does not change.
- The sections and the places in them belong to the server. The computer and the phone show the
  same ones. The open or closed state of a section belongs to the device (step 4 of "Flows"
  above).
- Section names are text of the user. They are not translated.
- Search (step 3 of "Flows" above) looks at place names only. A section with no match hides, and
  a section with a match opens, also when it is collapsed.
- Up and down in the list move through the places that show, in the order shown. A collapsed
  section has no places that show.

## Place rows

- One line, 34 px high: a 24 px face for an agent, or a `#` mark for a channel, then the name.
- Names are muted. They are full contrast when the row is selected, hovered, or has unread
  messages.
- An unread count shows as a small badge at the right end.
- A working agent has a small success-colour dot on its face. A channel with work running has the
  same dot on its `#` mark.
- The row's accessible name includes the last message, but the row does not show it.
- A place that waits for the user stays in its own section and keeps its badge. There is no
  separate group for places that need the user.
- Right click (or a long press) on a place opens a menu. "Mark as read" clears the unread count of
  that place only, not of other places. The same menu has "Move to section" (see "User sections").

## Header

- Direct chat: the agent's face, name, model, the context meter (see 003), and the list of threads.
- Channel: `#`, the name, a thin divider, then the topic in muted text. The topic truncates.

## States

- No server connected: the rail shows only the add button; the main area explains how to start.
- No places in a section: the section shows a short muted line, not an empty gap.

## Rules

- Window width under 800 px: the rail narrows to 56 px and the activity panel closes.
- On macOS the rail leaves room for the window buttons at the top left.
- Keyboard: Cmd/Ctrl+K focuses search. Up and down move through places. Enter opens one.

## Acceptance

- Selecting a server, then a place, opens the right conversation; the selection survives a
  restart.
- At 760 px width, the activity panel is hidden and the rail is 56 px wide.
- Make the agent section "Research", then use "Move to section" on one agent: the agent shows
  under "Research" and not among the other agents. After a restart, it still does.
- Make the agent section "Research" again, with another case ("research"): the app refuses it. Make
  a channel section "Research": the app accepts it.
- Collapse a user section that holds an agent with 2 unread messages: its header shows the badge
  2. Open the section: the badge leaves the header and shows on the agent.
- Drag a channel onto the header of an agent section: the channel does not move. Drag it onto a
  channel section: it moves.
- Delete a section that holds two agents, and confirm: both agents show in Agents with no section.
  No agent is deleted.
- Type part of an agent name that is in a collapsed user section: the section opens and shows the
  agent. Escape clears the search and the section collapses again.
