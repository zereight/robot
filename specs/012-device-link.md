# 012 Device link

## Purpose

The user links their own devices: phones and computers. A linked device opens a computer's
server, for example a phone, MacBook 1 and MacBook 2 that all work with each other's agents.
Devices connect to each other directly: on one network, or through a VPN that the user sets up
(for example Tailscale). No ROBot service sits between them, and conversation content never goes
through, and is never stored on, a third-party server.

## Concepts

- **Device**: a phone or a computer that runs ROBot. It has a name that the user chooses, a kind
  (phone or computer), and an identity that the app makes on first start. A computer is a Mac with Apple
  silicon. A phone is an iPhone or a phone with Android. The link and its messages are the same for both
  phone systems.
- **Server**: a profile on a computer, and its agents (see 000 and 022). Every profile is a
  server for its own agents. A phone is never a server.
- **Client**: a device that opens a server. A phone is always a client. A computer is a client
  when it opens another computer. It shows that computer as a server tile in its rail (see 001).
- **Link**: the trust between two devices that were paired. A link is for one direction: the
  client may open the server. Two computers can have a link in both directions.
- **Pairing code**: a QR code, a 6-digit code and a link text that one computer shows to start a
  pairing.

A client does not copy the agents or the data of a server. The server keeps the data (014). The
client shows it and sends commands.

## Flows

### Pair (computer shows, other device joins)

1. On the computer that will be the server: Settings → Devices → "Pair a device". The pairing
   screen shows the QR code, the 6-digit code, the addresses of the computer, and a "Copy link"
   button. The addresses are all that other devices can use to reach this computer, on the local
   network and in a VPN. The code ends after 5 minutes or after one pairing.
2. On the other device, one of these:
   - Phone: scan the QR code, or type the address and the code.
   - Computer: Settings → Devices → "Connect to a computer", or the add button on the server
     rail. The dialog lists computers that are near (same network) and have a valid pairing code
     on screen. The user picks one and types the code, or pastes the link text, or types an
     address and a code.
3. If the joining device is a computer, it asks one more question: "Let <name> open this
   computer too?" It is on by default. On means the link goes in both directions. The switch
   "Can create and change agents" for that other direction is off at first. The user turns it on
   in Settings → Devices on the joining computer.
4. The server shows "Allow <device name>?" with the device kind, Allow and Deny. The text says
   that the device can direct the agents of this computer, including steps that change files and
   run commands. For a two-way link, the text also says that this computer can open the other
   one. The dialog has a switch, "Let <device name> create and change agents". It is on by
   default for a computer and off by default for a phone, because the phone app has no screens
   for it in this version (011).
   When it is on, the text also says that the device can make and change agents, channels,
   memory and workflows on this computer (see "Create and change agents" and "Workflows").
5. On Allow, both sides store each other's identity. Later connections need no code. The new
   server appears in the client; the client opens it at once.

### Use a linked server

1. The user clicks the server tile of a linked computer. The place list and the conversation
   change to that server (001).
2. The user works as in a direct chat or a channel: read, send, stop, attach files, reply,
   answer approvals and questions (003, 004, 007).
3. Another device that uses the same server sees the same messages at once.
4. If the server lets this device change agents, the user can also create and change agents and
   channels of that server (see "Create and change agents").
5. The user opens the Workflows page of that server, runs and stops workflows, and sees their
   runs (see "Workflows").

### Remove access

- On the server: Settings → Devices lists the linked devices that can open this computer. The
  user picks one and chooses "Remove access". That device cannot connect again until it is
  paired again. The step asks first, and its question names the device (000, "Danger buttons").
- On the server, each linked device in that list has the switch "Can create and change agents".
  It takes effect at once, also for a connection that is open. While the two computers sync
  (019), the switch for that device shows as on and cannot be changed. A link made before this switch
  existed has it off until the user turns it on.
- On the client: Settings → Devices lists the servers this device can open. The user picks one
  and chooses "Remove". The link ends on both sides. The cache of that server is deleted. Both
  steps ask first, and the question names the other computer (000, "Danger buttons").

### Name and switch

- Settings → Devices shows the name of this device. The user can change it. Linked devices show
  the new name the next time they connect. The default name is the name of the computer.
- "Let other devices connect" is a switch. It is off at first start. "Pair a device" turns it on
  after the user agrees. When it is off, this computer accepts no connection, also not from
  linked devices.

## What a client can do on a server

| Can do | Cannot do (open it on the server) |
| --- | --- |
| See places in the sections of the server, unread counts, working dots; see the org chart (029); see the organization prefix of agents (036) | Delete or restore agents and channels |
| Read messages, search places and messages | Change model accounts, skills, connections and settings. Review the tools of a connection (018). Make a skill from work (017). Hand over a chat (003) |
| Send, stop, reply, edit the last message, retry | Make the permission level of an agent looser, or add, edit or delete a permission rule (007) |
| Attach files and download files from messages | Choose a workspace folder |
| Answer approval cards and questions | Routines, usage page, the action log, knowledge of an agent (016), check, download or repair an agent runtime (006) |
| See the task list and task details; stop a task | Browser "Take control"; accept or request changes on a part in review (004); the Today page (021); memory proposals and memory history (008) |
| See the workflow list, open a canvas, see run history, run details and live run state; run and stop a workflow; answer an approval step of a run | The workflow assistant panel; export and import of workflow files; the workflows log (014) |
| Only with "Can create and change agents": create, edit, duplicate and archive agents; create and edit channels; make, edit and delete organizations, also the parent organization, the hand-off range and the daily token limit (030), and edits on the org chart (029); edit memory; create, edit, duplicate, turn on or off and delete workflows | Export and import of data |

A client sees the user sections and the pinned places of the server (001). It cannot make,
rename, order or delete a section, move a place into another section, or pin or unpin a place.
A client can mark a place or a message as read or as unread (001, 003). The read state follows
the server. The Today, Board, Routines and usage page buttons and pages, and the
other parts in the right column, show a muted line on a client: "Open this on <server name>."
A client cannot make an agent less careful than it is now (007). For this reason an approval
card on a client has no "Always allow" choice. If a client sends one, the server takes it as one
"Allow" and keeps no rule. The rules of the server hold for every client. A Deny rule refuses a
step that a client asked for, and a card shows "Denied by a rule" or "Allowed by a rule" on the
client as on the server. The action log of the server (007) names the linked device that
answered a card, in the same entry.

### Create and change agents

A client with the switch "Can create and change agents" (see "Remove access") works with the
agents and channels of the server in the same screens as on the server (002, 004, 008): the plus
button on a section, the agent profile, the channel settings, the memory list.

- **Fields a client can set:** name, face (shape and hue; no uploaded image), role line,
  instructions, model, effort, backup model and the switch "Read the handbook". The section of an agent is not
  offered. For a channel: name, topic, instructions, picture, members and lead. A client can also read and
  change the handbook (002), and turn the memory check of an agent on or off (008). A client does
  not archive, delete or restore channels.
- **Outside content:** a client shows the line "Holds outside content" in the header of a place
  (007). It cannot clear the mark.
- **Memory:** a client does the same four things as the profile of an agent on the server (008):
  list and search, add, edit and delete items. It has no switch for memory on or off.
- **Model:** the client picks from the model accounts that are connected on the server. It cannot
  add, change or disconnect an account, and it never sees a key.
- **Workspace:** the server makes a new, empty workspace folder in its default folder (013) for
  each agent that a client creates or duplicates. A client cannot choose or change a folder. The
  profile on a client says "Workspace: on <server name>" and shows no path.
- **Permission level:** an agent that a client creates starts at the level that the server uses
  for new agents ("Ask for risky steps"). A client can set a stricter level. From the loosest to
  the strictest, the levels are "Full access", "Ask when unsure", "Ask for risky steps", "Ask
  for everything" and "Read only" (007). A client cannot set a looser level, and it cannot add an "Always allow"
  rule.
- **Names:** the rules of 002 and 004 hold on the server. A name that is taken gives a plain
  error on the client.
- **Working agents:** a client cannot archive an agent while it works. It stops the agent first.
- **Record:** the profile of an agent, on the server and on clients, shows "Last changed by
  <device name>" with the time, when a client made the last change. A later change in the window
  of the server removes the line. A change that arrives by sync (019) leaves it as it is. A
  change shows on the server and on all clients at once.
- **No switch:** a client without the switch sees the profiles as read-only text, and the plus
  buttons are not shown. A try to change anything gets the error "Not allowed", with the line
  "<server name> does not let this device change agents. Turn it on in Settings → Devices on
  that computer."

### Workflows

A client opens the Workflows page of the server (010) in the same screens as on the server.

- **View:** the workflow list, each canvas with its steps, notes and node numbers, the run
  history, the details of each run, and the live state of a run. The server pushes each change.
- **Run and stop:** these need only the right to send messages. A client starts a manual run,
  stops a run, and answers an approval step of a run. The run history shows "Started by <device
  name>" for a run that a client started. An approval step that a client answered shows "Allowed
  by <device name>" or "Denied by <device name>".
- **Change:** create, edit, duplicate, turn on or off, delete, and restore a version need the
  switch "Can create and change agents". Without it, the canvas is read only and shows no edit
  controls. A try gets the "Not allowed" error of "No switch" above. The rule of 010 holds: a
  workflow cannot be edited while it runs.
- **Server things:** an agent step picks from the participants of the workflow (010, "Owner and
  participants"), that is, from the agents of the server that are not archived when the workflow
  has no owner. The field "Owner" follows "Change". A
  model step and a condition in "Ask a model" mode pick from the model accounts of the server. A
  post step picks a place of the server. A client never sees a key or a path.
- **Web hook:** a client sees the kind of trigger and, for a web hook, the name of the computer
  that listens. It sees neither the address nor the secret (010).
- **On the server only:** the assistant panel, because it can change many things at once, and
  export and import of workflow files. The panel shows the muted line "Open this on <server
  name>." on a client. The phone keeps its own assistant rule (011).
- **Sync:** a workflow that runs on another computer through sync (019) shows the same "Runs on
  <name>" line on the client. Run is off for it on the client, as on the server. A client does
  not offer "Run on this computer"; the user chooses it on the server.
- **Offline:** while the server is offline, the page shows "<server name> is offline." It shows
  no cached workflows.

## Profiles

A server is one profile on one computer (022). Where this spec says "computer" for a server, it
means a profile on a computer.

- The link, the pairing code, the device name, the switch "Let other devices connect", the list
  of devices that can open it, and the switch "Can create and change agents" belong to one
  profile. Settings → Devices shows those of the open profile.
- A profile is reachable while the app runs, also when another profile is open.
- A client that is linked to a profile sees that profile only. It cannot learn the name or the
  number of the other profiles of the computer.
- A profile cannot link to another profile of the same computer. The dialog says "This is the
  same computer."
- Deleting a profile ends its links like "Remove access" for each device. The cache of a client
  is deleted as this spec says for a removed link.
- The limit of 10 linked devices holds for each profile.

## Connection

- A client connects straight to an address of the server. The app has no relay and no
  connection service, so only the two devices see the traffic.
- On one network, linking works with no set-up. For reach from other networks, for example a
  phone on mobile data, the user puts the devices in one VPN. The app does not install or
  manage the VPN. Its pairing screen and its Devices settings say this in one short line.
- The pairing code and the link text hold every address that the pairing screen shows. The
  client tries them in order and stores the one that worked. If a server moves, the client tries
  the stored addresses again. The user can also type a new address for a server in Settings →
  Devices.
- All traffic is end-to-end encrypted with the keys of the link. A connection from a device that
  is not linked is closed.
- While a pairing code is valid, the computer can be found by name on its network. At other
  times it is not announced.

## Messages

- A client asks for: server summary, places (with the user sections, the section of each place,
  and the role line of each agent), a page of messages, search of places and of messages (001),
  send message, stop, edit, retry, mark a place as read, approve, answer question, upload
  attachment, download attachment, task list, task details, stop a task, workflow list, one
  workflow, run history, run details, create, update, delete and turn on or off a workflow, run a
  workflow, stop a run, the org chart (029), and the changes of the org chart: a new organization, and its members, lead
  and parent (029, 030). A client reads the part "Hand-off rules" and the tools of an organization
  (030), and does not change them.
- The phone app (011) may ask for more: end a request (see 004). The aim of 011 is that the phone
  can do whatever the user can do in a conversation on the computer. Start and fork a thread,
  compact a conversation and "Run next" are on no client in this version (003, 005), and each of
  them needs its own slice.
- The rules of "Create and change agents" and "Workflows" apply to every client, the phone too:
  running and stopping a workflow need only the right to send messages, and a change to a
  workflow needs the switch "Can create and change agents".
- A server pushes: new and changed messages, task state changes, agent state changes, approval
  requests and questions, unread counts, changes to the sections or to the section of a place,
  changes to the name or to the role line of an agent, changes to workflows, changes to the state
  of a run, and changes to the org chart (029).
- A server pushes the start and the end of a quiet turn (005, "Quiet line"), with the name and
  the seconds on the quiet clock at the time of the push. The client counts on from that value.
  It does not get a push each second. A client that connects while a turn is quiet gets the quiet
  state with the other state of the server.
- Each message has a type, an id, and a version number. Both sides use one protocol version. A
  peer with another version gets a clear "Update the app" error.
- A server answers each client by what that client may do (see above). A request for something
  else gets a plain "Not allowed" error.

## States

Each server tile on a client shows one state:

| State | What the user sees |
| --- | --- |
| Connecting | A small progress mark on the tile. |
| Online | The tile as normal. |
| Reconnecting | A muted tile and the line "Reconnecting". The app retries with backoff, at most 30 seconds between tries. |
| Offline | A muted tile with an offline mark. The place list and the last messages show from the cache, marked "Offline". The message box is off and says "<server name> is offline." |
| Not allowed | The server removed this device. The tile shows "Pair again". The cache is deleted, and the place list and the open conversation of that server are cleared. A strip above the view, and the line in the message box, say "<server name> removed this device." |
| Update the app | One side has another protocol version. The text says which side must update. |

Pairing errors are plain lines in the dialog: wrong code, code ended, the computer is not
reachable (the text asks the user to check the network or the VPN), the computer does not
accept connections, this is the same computer.

## Rules

- A code works once and ends after 5 minutes. After 5 wrong tries the code ends and the
  computer shows a new one only when the user asks.
- A computer cannot link to itself. Pairing the same device again replaces the old link.
- Up to 10 linked devices can open one computer. One device can open up to 10 servers.
- The server keeps the read state of each place. Reading a place on one device clears its
  unread count on all devices.
- A message that came from another device shows a small muted line: "from <device name>". A
  card that a client answered shows "Allowed by <device name>" or "Denied by <device name>".
- Two linked devices with the same name show with a number after the name.
- A client cache holds the newest 200 messages of each place that the user opened while the
  server was online. A place that was never opened shows nothing while the server is offline.
  The cache lives on the client, is deleted with the link, and is never part of an export
  (014).
- A server needs a running app to answer. A sleeping or closed computer is offline.
- A server holds back the notices to its phones while its computer is in use (015, "Phone notices
  while the user works"). The data still reaches the phone.
- A server tells its linked devices when an agent is on its backup model, and until when (006).
  The device shows this in the header of the chat. The hold is not data to sync.

## Out of scope

- Sync of agents and data between computers. See 019. A link alone copies nothing.
- An agent on one computer that joins a channel of another computer.
- A server that is not a Mac with Apple silicon: an Intel Mac, a Windows or Linux computer, a
  phone, or a service on the internet. So a phone with no such Mac has no server to open (000).
- A relay or a connection service that links devices which share no network. The user uses a
  VPN for this.
- Setting up or checking the VPN.
- Screens on the phone to create or change agents. The rules above hold for every client, but
  the phone app (011) does not show these screens in this version.
- A push to a closed phone app. This needs a service that is not in this spec. A phone gets
  notifications only while the app runs (011).
- Pairing by Bluetooth or by a shared account.

## Acceptance

- Pair MacBook 1 with MacBook 2 with the copied link. MacBook 1 shows a tile for MacBook 2.
  Send a message to an agent of MacBook 2 from MacBook 1: the reply streams in both apps, and
  the message in MacBook 2 shows "from MacBook 1".
- Pair a phone with both computers. The Servers screen lists both as online.
- Answer a shell approval for MacBook 2 from MacBook 1: the task goes on, and the card on
  MacBook 2 shows "Allowed by MacBook 1".
- Quit the app on MacBook 2: the tile on MacBook 1 goes to Offline, the last messages stay, and
  the message box is off. Start the app again: the tile goes to Online without a new pairing.
- Remove access for MacBook 1 on MacBook 2: the next request from MacBook 1 fails, the tile
  shows "Pair again", and its cache is gone.
- With "Let other devices connect" off, a linked device cannot connect.
- Pair MacBook 1 with MacBook 2 and leave the switch "Let MacBook 1 create and change agents"
  on. On MacBook 1, open the tile of MacBook 2 and create an agent "Writer" with a model. The
  agent shows on MacBook 2 with a new empty workspace folder, "Last changed by MacBook 1", and
  the level "Ask for risky steps". Edit its instructions from MacBook 1: the change shows on
  MacBook 2 at once and applies to the next turn.
- On MacBook 1, set the level of that agent to "Ask for everything". Try to set it back: the
  client offers no looser level, and a request for one gets "Not allowed".
- Turn the switch off on MacBook 2 while MacBook 1 is connected: the next change from MacBook 1
  fails with the line that names MacBook 2, and the plus buttons and fields on MacBook 1 turn
  read-only.
- A link that was made before the switch existed has it off.
- MacBook 1 cannot delete an agent of MacBook 2, cannot change a model account, and a request
  for a folder path is refused.
- On MacBook 1, open the Workflows page of MacBook 2 with the switch off. The list and the
  canvas show with no edit controls. Run a workflow: the steps light up on both computers, and
  the run history shows "Started by MacBook 1". Stop the run from MacBook 1: it stops. A request
  to edit the workflow gets "Not allowed".
- Turn the switch on and add a step from MacBook 1: the canvas on MacBook 2 shows it at once.
  The assistant panel and workflow export and import show "Open this on MacBook 2."
- A workflow of MacBook 2 that runs on a third computer through sync shows "Runs on <name>" on
  MacBook 1, and Run is off.
- On MacBook 1, open the Org chart page of MacBook 2 with the switch off. The chart of MacBook 2
  shows with no edit control. An agent of MacBook 2 starts a task: its node shows "working" on
  MacBook 1 within 1 second. Turn MacBook 2 off: the page shows "MacBook 2 is offline." and no
  chart (029).
- Turn the switch on and drag an agent of MacBook 2 to another organization on MacBook 1: the member
  moves on MacBook 2, and the line with "Undo" shows on MacBook 1 (029).
- Type a wrong code 5 times: the code ends. Wait 5 minutes: the code ends.
- Pair a computer with itself: a plain error shows.
- A Mac has two profiles. Pair one phone with each. Each phone lists one server and shows nothing
  of the other profile. Removing access in one profile does not change the other.
- With both devices in one VPN: pair on the same Wi-Fi, then switch the phone to mobile data.
  It reconnects and works. Turn the VPN off on the phone: the server shows Offline. Turn it on:
  the server comes back without a new pairing.
- The computer has had keyboard input 10 seconds ago: a stand-in phone gets the data of a new
  reply, and no notice. After 30 seconds without input the notice arrives, unless the user has
  already read the place on the computer.
- An agent is on its backup model: a stand-in phone shows "Backup until" in the header. It shows
  no button "Use the main model now" when the switch "Can create and change agents" is off.
