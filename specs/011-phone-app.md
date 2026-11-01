# 011 Phone app

## Purpose

The user follows and directs agents from an iPhone or Android phone while away from the computer.

## Concepts

- The phone does not run agents. It shows the servers it is paired with and acts on them.
- **Paired server**: a computer that accepted this phone (see 012). A phone can pair with
  several computers, for example two laptops. Each one keeps its own agents and data.

## Screens

1. **Servers**: list of paired servers with the connection state of 012 and the total unread
   count of each. Add server opens the pairing camera.
2. **Places**: the server's sections, agents and channels, with unread counts and working dots,
   as on desktop.
3. **Conversation**: message rows as on desktop, Markdown, tool cards (tap for details), the
   message box with attach (photos, files), stop, and reply.
4. **Approvals**: approval and question cards can be answered in the conversation or from a
   notification.
5. **Settings**: language, theme, notifications, unpair.

## First start

The phone asks the user for a device name that the computer will show, then opens the pairing
camera.

## Rules

- Native look on each platform: system fonts, system back gesture, bottom sheets for menus.
- The phone keeps a cache of recent messages for each server so the last view opens offline,
  marked "Offline". Unpairing a server deletes its cache.
- Notifications: a reply in a direct chat, a mention, an approval request, a failed task. Each
  kind can be turned off.
  They show while the app runs and is linked to the server. A closed app gets none (012).

## Acceptance

- Pair, open an agent, send a message, see the streamed reply, answer an approval.
- Pair with two computers: both show on the Servers screen, and each opens its own agents.
- With the computer off, the phone shows the cached conversation with the offline mark.
