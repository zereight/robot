# 011 Phone app

## Purpose

The user follows and directs workflows from an iPhone or Android phone while away from the
computer. The user can start a run, see how far it has gone, ask the chat of the workflow about
it, and give feedback, from the phone.

## Concepts

- The phone does not run workflows. It shows the servers it is paired with and acts on them. So it
  works only with at least one Mac that runs ROBot (000, 012).
- The app exists for iOS and for Android, with the same screens and the same features.
- **Paired server**: a profile on a computer that accepted this phone (see 012 and 022). A phone
  can pair with several servers, for example two laptops. Each one keeps its own workflows and
  data. The phone sees only the profile it is paired with, and nothing of the other profiles of
  that computer. It cannot add, switch, rename or delete a profile.

## Screens

1. **Servers**: list of paired servers with the connection state of 012 and the total unread
   count of each. Add server opens the pairing camera.
2. **Workflows**: the workflows of the server, as the workflow list on the computer (001). A card
   shows the name, the state of the last run and the state of the check. In this version the
   phone cannot make a workflow from the list. The user does this on the computer.
3. **Workflow**: one workflow. It has two parts: the run view and the chat.
   - **Run view**: the nodes as a numbered list, not as a canvas. Each line shows the number, the
     name, the kind (text node or decision node) and the state of the node in the last run or in
     the run that goes now. A tap on a node opens its result. For a decision node it also shows
     the probability of each option (010). A run that stopped or waits shows the reason in one
     line at the top of the view. The view has "Run" and "Stop". The phone has no canvas editor.
   - **Chat**: the one chat of the workflow (010). It shows message rows as on desktop, Markdown,
     tool cards (tap for details), the message box with attach (photos, files), stop, and reply.
     The switch "Show tool steps" in Settings folds plain tool steps as on the computer (003,
     "Folded tool steps").
4. **Ask and give feedback**: in the chat of the workflow, the user can ask how far a run has gone,
   why it stopped or waits, and what the results so far are. The responsible document answers
   (010). While a run goes, the user can send feedback on the results so far. It is a message in
   the chat, like any other. It works as on the computer (010). It needs only the right to send
   messages (012).
5. **Approvals**: approval and question cards can be answered in the chat or from a notification.
   The card of a decision node that asks the user to pick an option (010) is one of them.
6. **Needs you**: one list of what waits for the user on a server: approval cards, question cards
   and the cards of decision nodes. A card for browser control that is no longer valid leaves the
   list.
7. **Change a workflow**: the user changes a workflow on the phone only through the chat. The
   responsible document changes the graph (010). This needs the switch "Can create and change
   workflows" of that computer (012). Without the switch the chat tells the user that the change is not
   allowed. The canvas and the file of a workflow are on the computer only in this version.
8. **Settings**: language, theme, chat, notifications, unpair. The chat part holds the
   switch "Show tool steps", on at first.

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
| Phone 1 | First start, pairing, Servers, Workflows, the run view, the chat of a workflow (read, streamed replies, send, stop, reply, attach photos and files, open files), ask and give feedback, approval and question cards, Needs you, offline cache of messages, notifications while the app is open, Settings. |
| Phone 2 | The list in "Same as the computer". |
| Phone 3 | The list in "More on the phone", and voice (027). |

Until a screen comes, the phone does not show it. Phone 1 is a complete app: every screen it
shows works.

## Same as the computer

The phone follows the computer in these points: the context meter (003), "Mark as unread" (003),
the command list (003), the line that tells how far a failed turn went, with the button "Send
again" (003, 005), and the box and the button "Load image" for a picture from the web (003). The
phone shows no marketplace. In this version the phone shows the chat of a workflow as one thread.
It has no Compact control, no fork and no "Run next" (003, 005). It does not make a skill from work
(017) and does not review the tools of a connection (018).

## More on the phone

- **Share to a workflow**: the share sheet of iOS and the share menu of Android list ROBot. The
  user shares text, a link, an image or a file from another app. A small sheet opens. It lists the
  paired servers and their workflows, with the workflow used last first, and has a box for a
  message and "Send". The app does not open its full screens. It sends the shared item to the chat
  of that workflow as text or as an attachment, with the message. The limits of 003 apply.
  "Cancel" closes the sheet and sends nothing. The phone keeps no copy of the shared item. If the
  server is offline, the sheet says so and sends nothing.
- **Notice mark**: a notice of a reply, an approval or a failed task shows the mark of the app.
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
  marked "Offline". The cache holds messages only. The workflow list, the run view and the nodes do
  not show from the cache (012, "Offline"). Unpairing a server deletes its cache.
- Notifications: a reply in the chat of a workflow, an approval request (this includes the pick
  of a decision node), a failed task. Each
  kind can be turned off.
  They show while the app runs and is linked to the server. A closed app gets none (012). On
  iPhone this means in practice while the app is open or was open a moment ago. The settings
  screen says this in one line, so the user does not expect a notice from a closed app.
- An answer from a notification needs the app: a tap opens the card in the chat.
- The settings of the phone stay on the phone.

## Out of scope

- Use with no Mac. The phone runs no workflows, and no service hosts them for it (000, 012).
- A canvas editor on the phone, and the file of a workflow (010, 014). They are on the computer.

## Acceptance

- Pair, open a workflow, send a message in its chat, see the streamed reply, answer an approval.
- Pair an iPhone and an Android phone with the same Mac. Both list the same workflows. A message
  sent from one shows on the other at once, with "from <device name>".
- Start the app with no paired server: the Servers screen says that a Mac with ROBot is needed,
  and offers Add server.
- Pair with two computers: both show on the Servers screen, and each opens its own workflows.
- With the computer off, the phone shows the cached chat with the offline mark, and no workflow
  list and no run view.
- Scan the QR code of a computer: the computer asks "Allow <phone name>?" with the kind phone.
  Allow: the server opens on the phone with no typing.
- Deny the camera: "Type it instead" pairs with the address and the code.
- The computer removes the phone: the next request fails and the Servers screen shows "Pair
  again" for that computer.
- Put the app in the background for one minute, then open it: the server goes back online
  without a new pairing, and a reply that ended in the meantime shows.
- Open a workflow and press "Run": the node lines show their states as the run goes. Press
  "Stop": the run stops.
- A run waits at a decision node that asks the user. The phone shows the card in Needs you and in
  a notice. Pick an option: the run goes on.
- During a run, ask in the chat "How far are you, and what do you have so far?" The answer tells
  the node that works, the nodes that are done, and their results so far. Send "Make the summary
  shorter" about a result: the responsible document takes it as feedback, and the chat shows that
  it got it. A phone without the switch "Can create and change workflows" can do both.
- A run failed. Ask "Why did it stop?" in the chat: the answer gives the node and the reason. The
  run view shows the same reason.
- A phone without the switch asks the chat to add a node: the chat says that the change is not
  allowed, and the graph does not change.
- Share a link from another app on a stand-in phone: the sheet lists the paired servers, the user
  picks a workflow and presses Send, and the chat of that workflow gets a message that holds the
  link. With the server offline, the sheet says so and nothing is sent.
- A message with three images shows a stack. A tap opens the viewer, and a swipe goes to the next
  image.
- Open the thinking row of a reply: the sheet lists every thought of the turn.
- Turn off "Show tool steps" in Settings: a reply with plain steps shows one folded line per run,
  and a tap opens the cards. A step that waits still shows as its own card. A step that runs
  joins its run, and the line keeps its place while the turn goes on. A reply that thinks before
  each of its steps shows one thought line, and its steps fold as one run.
