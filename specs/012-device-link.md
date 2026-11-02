# 012 Device link

## Purpose

The user links their own devices: phones and computers. A linked device opens a computer's
server, for example a phone, MacBook 1 and MacBook 2 that all work with each other's agents.
Devices connect to each other directly: on one network, or through a VPN that the user sets up
(for example Tailscale). No ROBot service sits between them, and conversation content never goes
through, and is never stored on, a third-party server.

## Concepts

- **Device**: a phone or a computer that runs ROBot. It has a name that the user chooses, a kind
  (phone or computer), and an identity that the app makes on first start.
- **Server**: a computer and its agents (see 000). Every computer is a server for its own
  agents. A phone is never a server.
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
   one. The dialog has a switch, "Let <device name> create and change agents", on by default.
   When it is on, the text also says that the device can make and change agents, channels and
   memory on this computer (see "Create and change agents").
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

### Remove access

- On the server: Settings → Devices lists the linked devices that can open this computer. The
  user picks one and chooses "Remove access". That device cannot connect again until it is
  paired again.
- On the server, each linked device in that list has the switch "Can create and change agents".
  It takes effect at once, also for a connection that is open. While the two computers sync
  (019), the switch for that device shows as on and cannot be changed. A link made before this switch
  existed has it off until the user turns it on.
- On the client: Settings → Devices lists the servers this device can open. The user picks one
  and chooses "Remove". The link ends on both sides. The cache of that server is deleted.

### Name and switch

- Settings → Devices shows the name of this device. The user can change it. Linked devices show
  the new name the next time they connect. The default name is the name of the computer.
- "Let other devices connect" is a switch. It is off at first start. "Pair a device" turns it on
  after the user agrees. When it is off, this computer accepts no connection, also not from
  linked devices.

## What a client can do on a server

| Can do | Cannot do (open it on the server) |
| --- | --- |
| See places in the sections of the server, unread counts, working dots | Delete or restore agents and channels |
| Read messages, search places and messages | Change model accounts, skills, connections and settings |
| Send, stop, reply, edit the last message, retry | Make the permission level of an agent looser, or add, edit or delete a permission rule (007) |
| Attach files and download files from messages | Choose a workspace folder |
| Answer approval cards and questions | Routines, workflows, usage page, the action log, knowledge of an agent (016), check, download or repair an agent runtime (006) |
| See the task list and task details; stop a task | Browser "Take control"; accept or request changes on a part in review (004); the Today page (021); memory proposals and memory history (008) |
| Only with "Can create and change agents": create, edit, duplicate and archive agents; create and edit channels; edit memory | Export and import of data |

A client sees the user sections of the server (001) and cannot make, rename, order or delete
them, or move a place into another section. The page buttons and pages that a client cannot use
show a muted line: "Open this on <server name>."
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
  instructions, model and effort. The section of an agent is not offered. For a channel: name,
  topic, members and lead. A client does not archive, delete or restore channels.
- **Memory:** a client does the same four things as the profile of an agent on the server (008):
  list and search, add, edit and delete items. It has no switch for memory on or off.
- **Model:** the client picks from the model accounts that are connected on the server. It cannot
  add, change or disconnect an account, and it never sees a key.
- **Workspace:** the server makes a new, empty workspace folder in its default folder (013) for
  each agent that a client creates or duplicates. A client cannot choose or change a folder. The
  profile on a client says "Workspace: on <server name>" and shows no path.
- **Permission level:** an agent that a client creates starts at the level that the server uses
  for new agents ("Ask for risky steps"). A client can set a stricter level. From the loosest to
  the strictest, the levels are "Full access", "Ask for risky steps", "Ask for everything" and
  "Read only" (007). A client cannot set a looser level, and it cannot add an "Always allow"
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

- A client asks for: server summary, places (with the user sections and the section of each
  place), a page of messages, search of places and of messages (001), send message, stop, edit,
  retry, mark a place as read, approve, answer question, upload attachment, download attachment,
  task list, task details, stop a task.
- The phone app (011) may ask for more: end a request (see 004), start and fork a thread,
  compact a conversation, and run or edit a workflow. The aim of 011 is that the phone can do
  whatever the user can do in a conversation on the computer. A computer client does not offer
  these in this version, and each of them needs its own slice. The rules of "Create and change
  agents" apply to every client, the phone too: running a workflow needs only the right to send
  messages, and editing a workflow needs the switch "Can create and change agents".
- A server pushes: new and changed messages, task state changes, agent state changes, approval
  requests and questions, unread counts, and changes to the sections or to the section of a
  place.
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

## Out of scope

- Sync of agents and data between computers. See 019. A link alone copies nothing.
- An agent on one computer that joins a channel of another computer.
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
- Type a wrong code 5 times: the code ends. Wait 5 minutes: the code ends.
- Pair a computer with itself: a plain error shows.
- With both devices in one VPN: pair on the same Wi-Fi, then switch the phone to mobile data.
  It reconnects and works. Turn the VPN off on the phone: the server shows Offline. Turn it on:
  the server comes back without a new pairing.
