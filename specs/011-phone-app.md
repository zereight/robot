# 011 Phone app

## Purpose

The user follows and directs agents from an iPhone or Android phone while away from the computer.

## Concepts

- The phone does not run agents. It shows the servers it is paired with and acts on them. So it
  works only with at least one Mac that runs ROBot (000, 012).
- The app exists for iOS and for Android, with the same screens and the same features.
- **Paired server**: a profile on a computer that accepted this phone (see 012 and 022). A phone
  can pair with several servers, for example two laptops. Each one keeps its own agents and
  data. The phone sees only the profile it is paired with, and nothing of the other profiles of
  that computer. It cannot add, switch, rename or delete a profile.

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
   (see 004). A question of a member that is with the lead (004) joins the list only when it
   passes to the user. A card for browser control that is no longer valid leaves the list.
6. **Workflows**: the workflows of a server. The user sees them as numbered step lists, runs one,
   reads the runs, edits steps, and asks the assistant, as on the computer (see 010). Running a
   workflow and reading its runs need only the link. Editing steps and asking the assistant need
   the switch "Can create and change agents" of that computer (012).
7. **Settings**: language, theme, notifications, unpair.

## First start

The phone asks the user for a device name that the computer will show, then opens the pairing
camera.

## States

- **No server yet**: the Servers screen and the pairing camera say, in one short line, that the
  phone works with a Mac that runs ROBot, and that the user installs ROBot on the Mac first. The
  screen offers Add server. The phone does nothing else until one pairing is done.

## Pairing on the phone

1. The camera reads the QR code of the pairing screen of a profile on a computer (012, 022). The
   QR code holds the addresses and the code, so the user types nothing.
2. "Type it instead" opens a form for an address and the 6-digit code. It is always there, also
   when the user did not allow the camera.
3. The phone does not ask "Let <name> open this computer too?": a phone is never a server.
4. Before the phone connects, it checks the code. On a phone this can take up to half a minute,
   and the line "Checking the code…" says so. The computer does not wait for this step, so its
   pairing time limit is not used up by it.
5. The phone shows "Waiting for <server name> to allow…" until the user answers on the
   computer. On Allow the new server opens. The errors are the plain lines of 012.

## Versions

| Version | Content |
| --- | --- |
| Phone 1 | First start, pairing, Servers, Places, Conversation (read, streamed replies, send, stop, reply, attach photos and files, open files), approval and question cards in the conversation, Needs you (approvals and questions only), offline cache, notifications while the app is open, Settings. |
| Phone 2 | Needs you with failed channel parts, Workflows, and the list in "Same as the computer". |

Until a screen comes, the phone does not show it. Phone 1 is a complete app: every screen it
shows works.

## Same as the computer

The phone follows the computer in these points: the `@all` mention in channels (004), the random
name button and the role list for agents (002, 013), the word "archived" for channels (004), the
context meter (003), the command list (003),
the main agent switch (002), the end of a request (004), the search of messages (001), and the
line that tells how far a failed turn went, with the button "Send again" (003, 005), and the box
and the button "Load image" for a picture from the web (003). The phone shows no marketplace. In
this version the phone shows the main thread of a direct chat only. It has no Compact control, no
fork and no "Run next" (003, 005). It does not start a handover (003) and does not make a skill from
work (017). It shows the muted line "Handed over to <name>" in a main thread, and it does not review
the tools of a connection (018).

## Rules

- Native look on each platform: system fonts, system back gesture, bottom sheets for menus.
- iOS and Android have every feature of this spec. No feature is for one system only.
- The phone keeps its identity key in the secure store of the system. Removing the app removes
  the key, so the phone must pair again. The computer keeps the old entry until the user removes
  it there.
- **Local network**: the system may ask whether the app can use the local network. Before that
  question the phone says in one line why it needs it: to reach the computer. If the user says
  no, the Servers screen says so and tells where to turn it on in the system settings.
- **Background**: when the app leaves the screen, the system may end the link after a short
  time. When the app comes back, the phone connects again at once and shows what it missed. The
  user does nothing.
- The protocol version of the phone and the computer must be the same (012). If not, the server
  shows "Update the app" and says which side must update.
- The phone keeps a cache of recent messages for each server so the last view opens offline,
  marked "Offline". Unpairing a server deletes its cache.
- Notifications: a reply in a direct chat, a mention, an approval request, a failed task. Each
  kind can be turned off.
  They show while the app runs and is linked to the server. A closed app gets none (012). On
  iPhone this means in practice while the app is open or was open a moment ago. The settings
  screen says this in one line, so the user does not expect a notice from a closed app.
- An answer from a notification needs the app: a tap opens the card in the conversation.

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
- Scan the QR code of a computer: the computer asks "Allow <phone name>?" with the kind phone.
  Allow: the server opens on the phone with no typing.
- Deny the camera: "Type it instead" pairs with the address and the code.
- The computer removes the phone: the next request fails and the Servers screen shows "Pair
  again" for that computer.
- Put the app in the background for one minute, then open it: the server goes back online
  without a new pairing, and a reply that ended in the meantime shows.
