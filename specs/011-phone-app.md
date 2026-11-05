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
   as on desktop, including "Unassigned" at the bottom of Agents (001). The dot breathes as it
   does on the desktop (001), and the breath follows the
   setting "Reduce Motion" of the system. This includes the user sections, with the same order and
   the same badge on a collapsed header. The user can open and close a section on the phone. The
   phone remembers this for itself. In this version the phone cannot make, rename, order or
   delete a section, and it cannot move a place to a section, and it cannot pin or unpin a place.
   The user does this on the computer. The phone shows the group "Pinned" and the sections inside
   sections (001).
3. **Conversation**: message rows as on desktop, Markdown, tool cards (tap for details), the
   message box with attach (photos, files), stop, and reply. When the switch "Show tool steps"
   in Settings is off, each run of finished plain tool steps shows as one muted line with the
   count, and a tap opens it to read the cards. A step that runs, waits, failed, was refused, or
   carries a note always shows as its own card (003, "Folded tool steps").
4. **Approvals**: approval and question cards can be answered in the conversation or from a
   notification. A question card shows the look of the lead, its pass line and "Answered by
   <lead>" with the reason (004). The button "Correct" is on the computer only in this version.
5. **Needs you**: one list of what waits for the user on a server: approval cards, question cards,
   and failed channel parts. A failed part has "Retry" and "End the request", as on the computer
   (see 004). A question of a member that is with the lead (004) joins the list only when it
   passes to the user. A card for browser control that is no longer valid leaves the list.
6. **Workflows**: the workflows of a server. The user sees them as numbered step lists, runs one,
   reads the runs, edits steps, and asks the assistant, as on the computer (see 010). Running a
   workflow and reading its runs need only the link. Editing steps and asking the assistant need
   the switch "Can create and change agents" of that computer (012).
7. **Settings**: language, theme, chat, notifications, unpair. The chat part holds the
   switch "Show tool steps", on at first.
8. **Org chart**: a read-only list of the main agent, the channels with their members and leads
   (a sub-channel indented under its parent channel, 030), the state of each agent, and the work that agents handed to each other in the last 7 days. It
   is a list, not a canvas (see 029, "Phone"). A tap on an agent opens its chat, and a tap on a
   channel header opens the channel. It needs only the link.

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
| Phone 3 | The group "Pinned" and sections inside sections, the list in "More on the phone", and voice (027). |
| Phone 4 | The screen "Org chart" as a read-only list (029). |

Until a screen comes, the phone does not show it. Phone 1 is a complete app: every screen it
shows works.

## Same as the computer

The phone follows the computer in these points: the `@all` mention in channels (004), the random
name button and the role list for agents (002, 013), the role badge on the row of an agent (001),
the word "archived" for channels (004), the context meter (003), "Mark as unread" (003), the
command list (003), the main agent switch (002), the end of a request (004), the search of messages (001), and the
line that tells how far a failed turn went, with the button "Send again" (003, 005), the box
and the button "Load image" for a picture from the web (003), and the picture of a channel
(004). The phone shows no marketplace. In this version the phone shows the main thread of a
direct chat only. It has no Compact control, no fork and no "Run next" (003, 005). It does not
start a handover (003) and does not make a skill from work (017). It shows the muted line
"Handed over to <name>" in a main thread, and it does not review the tools of a connection
(018).

## More on the phone

- **Share to an agent**: the share sheet of iOS and the share menu of Android list ROBot. The user
  shares text, a link, an image or a file from another app. A small sheet opens. It lists the
  paired servers and their agents, with the agent used last first, and has a box for a message and
  "Send". The app does not open its full screens. It sends the shared item to that agent as text or
  as an attachment, with the message. The limits of 003 apply. "Cancel" closes the sheet and
  sends nothing. The phone keeps no copy of the shared item. If the server is offline, the sheet
  says so and sends nothing.
- **Avatars**: the phone draws the avatars of 002 (faces, pictures, the mark of the user and the
  mark of a channel) with the same drawing and colours as the desktop in the same theme. They
  follow the theme of the phone. A change of the theme changes every avatar at once, with no
  motion. The choice "system" works as it does for the rest of the phone app. A long list of
  messages stays smooth.
- **Face in a notice**: a notice of a reply, a mention, an approval or a failed task shows the face
  or the picture of the agent when the system allows an image in a notice. If not, it shows the
  mark of the app.
- **Thinking sheet**: the row of thinking in a reply opens a sheet that lists all thoughts of that
  turn in order. Opening it starts nothing.
- **Image stack**: a message with more than one image shows the images as a stack of cards, also
  while the message is still being sent. A tap opens a viewer where the user swipes through them.
- **Icon**: the Android app icon has a layer for the themed icons of the system.
- **Voice**: dictate, read aloud and voice chat. See 027.
- **Quiet notices**: the computer holds a notice back while the user works at it. See 015.

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
- The settings of the phone stay on the phone.

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
- Share a link from another app on a stand-in phone: the sheet lists the paired servers, the user
  picks an agent and presses Send, and the agent gets a message that holds the link. With the
  server offline, the sheet says so and nothing is sent.
- A message with three images shows a stack. A tap opens the viewer, and a swipe goes to the next
  image.
- Open the thinking row of a reply: the sheet lists every thought of the turn.
- Change the theme of the phone from dark to light: every avatar changes at once, with no motion.
  A face has a light disc, dark features and no glow. A picture does not change.
- Open the screen "Org chart": it lists the main agent, each channel with its members and lead, and
  the hand-offs of the last 7 days. A tap on an agent opens its chat. With the computer off, the
  screen says so and shows no list (029).
- Turn off "Show tool steps" in Settings: a reply with finished steps shows one folded line per
  run, and a tap opens the cards. A step that waits still shows as its own card.
