# 001 Window layout

## Purpose

One window shows everything the user needs to direct agents, in the layout of a chat server, so a
new user knows where to look.

## Concepts

- **Server rail**: a narrow column at the far left edge of the window. One round tile per server,
  then an add button. The selected server has a short bar at its left side. The first tile is
  this computer. Tiles of linked computers (012) follow in the order of pairing. A linked tile
  shows the first letter of the computer's name and the connection state (012).
- **Page buttons**: under the servers, icon buttons open whole pages: agents and chats, workflows,
  tasks, usage. At the bottom: help and settings.
- **Place list**: a column beside the rail. A search field at the top, then sections. A section has
  a name and its places. A place is an agent (direct chat) or a channel.
- **Conversation**: the main area. A header line, the messages, and the message box at the bottom.
- **Activity panel**: an optional column at the right. In a channel it shows who works on what.

## Flows

1. The user clicks a server tile. The place list and the conversation change to that server.
   On a linked computer, the places and the pages work as 012 says. The plus buttons on the
   sections show only when that computer lets this device create and change agents.
2. The user clicks a place. The conversation opens it. The place row shows as selected.
3. The user types in search. The list shows only places whose name matches. Escape clears it.
4. The user collapses a section by clicking its name. The app remembers this per section.
5. The user hides or shows the activity panel with a header button. The app remembers this.
6. The user drags the edge of the place list to change its width, between 200 and 400 px.
7. The user clicks the add button on the rail. A dialog opens: "Connect to a computer" (012).
   The user can also remove a linked tile with its context menu.

## Place rows

- One line, 34 px high: a 24 px face for an agent, or a `#` mark for a channel, then the name.
- Names are muted. They are full contrast when the row is selected, hovered, or has unread
  messages.
- An unread count shows as a small badge at the right end.
- A working agent has a small success-colour dot on its face. A channel with work running has the
  same dot on its `#` mark.
- The row's accessible name includes the last message, but the row does not show it.

## Header

- Direct chat: the agent's face, name and model.
- Channel: `#`, the name, a thin divider, then the topic in muted text. The topic truncates.

## States

- No server connected: the rail shows only the add button; the main area explains how to start.
- A linked server that is offline: its tile is muted, and the place list shows the cached places
  (012).
- No places in a section: the section shows a short muted line, not an empty gap.

## Rules

- Window width under 800 px: the rail narrows to 56 px and the activity panel closes.
- On macOS the rail leaves room for the window buttons at the top left.
- Keyboard: Cmd/Ctrl+K focuses search. Up and down move through places. Enter opens one.

## Acceptance

- Selecting a server, then a place, opens the right conversation; the selection survives a
  restart. This also holds for a linked computer.
- The add button opens the connect dialog.
- At 760 px width, the activity panel is hidden and the rail is 56 px wide.
