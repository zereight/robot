# 011 Phone app

## Purpose

The user follows and directs agents from an iPhone or Android phone while away from the computer.

## Concepts

- The phone does not run agents. It shows the servers it is paired with and acts on them. So it
  works only with at least one Mac that runs ROBot (000, 012).
- The app exists for iOS and for Android, with the same screens and the same features.
- **Paired server**: a computer that accepted this phone (see 012). A phone can pair with
  several computers, for example two laptops. Each one keeps its own agents and data.

## Screens

1. **Servers**: list of paired servers with the connection state of 012 and the total unread
   count of each. Add server opens the pairing camera.
2. **Places**: the server's sections, agents and channels, with unread counts and working dots,
   as on desktop. This includes the user sections, with the same order and the same badge on a
   collapsed header. The user can open and close a section on the phone. The phone remembers
   this for itself. In this version the phone cannot make, rename, order or delete a section, and
   it cannot move a place to a section. The user does this on the computer.
3. **Conversation**: message rows as on desktop, Markdown, tool cards (tap for details), the
   message box with attach (photos, files), stop, and reply.
4. **Approvals**: approval and question cards can be answered in the conversation or from a
   notification.
5. **Needs you**: one list of what waits for the user on a server: approval cards, question cards,
   and failed channel parts. A failed part has "Retry" and "End the request", as on the computer
   (see 004). A card for browser control that is no longer valid leaves the list.
6. **Workflows**: the workflows of a server. The user sees them as numbered step lists, runs one,
   reads the runs, edits steps, and asks the assistant, as on the computer (see 010).
7. **Settings**: language, theme, notifications, unpair.

## First start

The phone asks the user for a device name that the computer will show, then opens the pairing
camera.

## States

- **No server yet**: the Servers screen and the pairing camera say, in one short line, that the
  phone works with a Mac that runs ROBot, and that the user installs ROBot on the Mac first. The
  screen offers Add server. The phone does nothing else until one pairing is done.

## Same as the computer

The phone follows the computer in these points: the `@all` mention in channels (004), the random
name button and the role list for agents (002, 013), the word "archived" for channels (004), the
context meter and the Compact control (003), threads and fork (003), the command list (003),
the main agent switch (002), the end of a request (004), the search of messages (001), and the
line that tells how far a failed turn went, with the button "Send again" (003, 005). The phone
shows no marketplace.

## Rules

- Native look on each platform: system fonts, system back gesture, bottom sheets for menus.
- iOS and Android have every feature of this spec. No feature is for one system only.
- The phone keeps a cache of recent messages for each server so the last view opens offline,
  marked "Offline". Unpairing a server deletes its cache.
- Notifications: a reply in a direct chat, a mention, an approval request, a failed task. Each
  kind can be turned off.
  They show while the app runs and is linked to the server. A closed app gets none (012).

## Out of scope

- Use with no Mac. The phone runs no agents, and no service hosts them for it (000, 012).

## Acceptance

- Pair, open an agent, send a message, see the streamed reply, answer an approval.
- Pair an iPhone and an Android phone with the same Mac. Both list the same places. A message
  sent from one shows on the other at once, with "from <device name>".
- Start the app with no paired server: the Servers screen says that a Mac with ROBot is needed,
  and offers Add server.
- Pair with two computers: both show on the Servers screen, and each opens its own agents.
- With the computer off, the phone shows the cached conversation with the offline mark.
