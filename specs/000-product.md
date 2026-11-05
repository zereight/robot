# 000 Product

## Purpose

ROBot lets one person run a small team of AI agents on their own computer. The interface follows a
chat server: servers on the far left, a list of places beside them, the conversation in the
middle, and an activity panel on the right. Agents appear as members with a face, a name and a bot
tag, so the user reads their work as they read messages from colleagues.

## Concepts

- **Server**: a computer that runs agents. The user's own computer is the first server. The user
  can link other computers and phones (see 012). A linked computer shows as a server in the rail.
  The phone connects to servers; it does not run agents.
- **Profile**: a separate space on one computer, with its own agents, chats, accounts, settings
  and linked devices (see 022). A server is one profile on one computer. A computer with one
  profile works as this spec says everywhere.
- **Agent**: a member that does work. One agent can be the main agent that splits work across the
  others. It has a face, a name, a short role line, a model, a
  workspace folder, and a memory. An agent keeps its identity and history when the user changes
  its model or restarts the app.
- **Direct chat**: a conversation between the user and one agent. It can have more threads, and a
  thread can be forked from a message.
- **Channel**: a conversation with a name and a topic, where the user and several agents work on
  one job. One agent can be the lead; it can split a job into parts for other agents.
- **Task**: one piece of work that an agent does. A task can have child tasks. Tasks have a state:
  queued, running, waiting for the user, done, failed, or cancelled.
- **Routine**: a task that runs on a schedule.
- **Workflow**: a set of connected steps that runs when a trigger fires.

## Platforms

- **Computer**: a Mac with Apple silicon (M1 or later) that runs macOS. This holds for a MacBook,
  a Mac mini, an iMac and any other Mac with such a chip. ROBot has no app for an Intel Mac, for
  Windows or for Linux. A server (see 012) is always a Mac with Apple silicon.
- **Phone**: an iPhone (iOS) or a phone with Android. Both systems have the same features (011).
- A phone is a client only. It needs a Mac that runs ROBot and that the phone has paired with.
  A user who has no Mac cannot use ROBot with a phone alone.

## Main flows

1. First start: the user picks a language and theme, connects at least one model account, and
   creates or picks a first agent.
2. Direct chat: the user opens an agent and sends a message. The reply streams in. Tool use shows
   as compact cards inside the reply. The user can stop the agent at any time.
3. Channel work: the user writes a job in a channel. The lead agent posts a plan. Each part shows
   as a step in the activity panel, and replies to a part are reachable from a small chip under
   the message that started it. When the parts end, the lead checks each result against the done
   test that it wrote for the part, and then posts one summary (see 004).
4. Phone: the user pairs the phone with a computer, then reads and sends messages and answers
   approval requests from the phone. The phone can pair with more than one computer.
5. Other computers: the user pairs a second computer with the first. Each computer then shows the
   other as a server and directs its agents. Each computer keeps its own agents and data, unless
   the user turns on sync (019).
6. Sync: the user sets two computers to sync. Both then hold the same agents, chats, memory,
   routines and workflows, and the user can work on either one.

## Rules

- Conversations, files, memory and settings stay on the computer that runs the agent. That
  computer's local database is the source of truth. A linked device shows this data and keeps
  only a cache (012). Two computers that sync (019) each hold a full copy, and a change on one
  reaches the other.
- Model providers and pages the agent visits use the network. Nothing else sends conversation
  content off the computer, except a decision model that the user sets up on purpose (see 013 and
  014), and the connections that the user adds on purpose (see 018 and 014). Both are off until
  the user sets them up. An outside program on this computer that the user adds (023) can read
  what ROBot gives it and send it on by itself. It is off until the user turns it on. A Teams
  link that the user turns on (028) reads one Microsoft Teams chat, and sends the answers to work
  that a message of that chat started back to the same chat. The text passes through the service
  of Microsoft. It is off until the user turns it on.
- A picture from the web in a Markdown text does not load by itself. The user presses "Load image"
  for each picture (see 003, "Pictures from the web"). A picture can carry data in its address.
- The app sends no analytics and no failure reports.
- The program of the test devices connection (032) is from another vendor, and it can report by
  itself. The app starts it with those reports off, and the panel of that program sends nothing,
  because the app gives the panel no address other than this computer. The only request that the
  app makes for test devices is a download that the user starts (032, 014).
- Secrets never appear in logs, exports or diagnostics.
- ROBot does not train or change a model. An agent gets better at its job only through things that
  the user can see and edit: its instructions (002), its memory (008), its knowledge (016), and the
  skills that the user saves (017). Interface text and documents do not say that a model learns,
  trains or evolves. The rule covers text that the user reads. It does not cover the instructions
  that the app sends to a model. The memory page and the knowledge page of an agent show one muted
  line with this fact (see 008 and 016).
- The visual style is calm: flat surfaces, no decorative gradients, sentence case, medium and
  semibold weights only, one line icon set, motion under 300 ms that respects reduced motion
  settings. The look follows `DESIGN.md`: three lights carry meaning and nothing else does. The
  accent violet shows where the user is and what can be pressed. The mint glow shows an agent, a
  channel or a task that works now. The rose neon shows that the app answers the user (see the
  light rule below). The surfaces of the window are told apart by their lightness,
  so a panel shows as its own plane and not as a box with a line around it. A sentence that the
  user reads is set at the body text size, never at the size of a label. A code block, an error
  line and a reason that explains a state are sentences for this rule. At the small text size
  the smallest step of text still reads: no step of the scale goes below 11 px at that setting.
- A block shows what kind it is by the tint of its surface or by a mark at its start. It does not
  carry a stripe of colour on its side.
- A **danger button** deletes or removes something that exists: a workflow or a step of one, a
  routine, an agent, a channel, a thread, a skill, a connection, an account, a linked device, a
  saved secret, a browser profile, an article or a source of knowledge, a rule, or a memory item.
  It shows in the colour of danger, and the text on it reads on that colour in both themes. A menu
  item with the same result shows its text in the colour of danger.
- A danger button asks first when nothing on that screen puts the thing back: the delete of a
  workflow or a routine with their runs, a step, a connection or a note of a workflow, a
  connection, an account, a link to a device, and a source of knowledge. The question is one line
  that names what goes away. Its button is a danger button, and the other button keeps the data.
  Two cases do not ask. A delete that an Undo row follows at once (008, 016) shows in the colour
  of danger only. So does a step that the user can simply make again, as a rule (007).
- Light is the one exception to the flat style. It shows who or what is here, and nothing else:
  the app mark glows, an avatar glows in the dark theme (see 002, "Avatars"), and so does the
  badge of the app mark on a working agent (see 003, "States"). Light is not used to decorate a
  surface, a button or a text. Light that does not belong to the app mark, to an avatar or to the rose neon needs a change of
  this spec.
- The **rose neon** is the light that answers the user. In the desktop app, it shows as a soft
  halo on a control that has the pointer or the keyboard focus, on a control that is pressed, and
  once on the result of an action that the user just did (for example a sent message or a
  copied pairing link). It fades in and out in less than 300 ms. At rest, a screen has no rose
  neon, and the rose neon never marks a state that the app keeps (selected, working, unread).
  The halo is a glow around a control. It is not a border, a gradient fill or a glass surface.
  The rose neon reads in both themes. With reduce motion, the halo of the pointer and of the
  keyboard focus appears with no fade, and the echo after an action does not show.
- A motion that ends takes less than 300 ms. A motion that does not end shows one thing only:
  that work goes on. It has one of two shapes. A **breath** is a mark that glows, grows a little
  and fades, in 1.4 s: the light of the badge of a working agent (003, "States") and the working
  dot of a place (001, "Place rows"). A **turn** is a mark that goes round: the spinner of a
  running step and of the look of the lead (004). A breath has no direction. No other part
  repeats a motion. With reduce motion, nothing moves.

## Out of scope

- Selling or billing.
- Hosting agents on a remote cloud service.
- An app for an Intel Mac, for Windows or for Linux.
- Use of ROBot on a phone alone, with no Mac. The phone runs no agents (012).
- Import of data from other apps. A separate tool may do this later; it is not part of ROBot.

## Acceptance

- A new user can go from first start to a streamed agent reply without reading documentation.
- A delete or a remove shows as a red button in both themes. Pressing the delete of a workflow,
  a routine, a connection, an account, a link to a device or a source of knowledge asks first
  with a line that names what goes away. "Keep it" changes nothing.
- The same Mac pairs with an iPhone and with an Android phone, and both work the same way (011).
- Two profiles on one Mac keep their agents, chats and accounts apart, and a phone that is paired
  with one of them sees only that one (022).
- A channel job with two parts shows two plan steps, and both reply chips open the right replies.
- With the network off except for the model provider, all features in this spec still work. The
  connections of 018 that use a web address are the exception: they need their address.
