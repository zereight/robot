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
- **Agent**: a member that does work. It has a face, a name, a short role line, a model, a
  workspace folder, and a memory. An agent keeps its identity and history when the user changes
  its model or restarts the app.
- **Direct chat**: a conversation between the user and one agent.
- **Channel**: a conversation with a name and a topic, where the user and several agents work on
  one job. One agent can be the lead; it can split a job into parts for other agents.
- **Task**: one piece of work that an agent does. A task can have child tasks. Tasks have a state:
  queued, running, waiting for the user, done, failed, or cancelled.
- **Routine**: a task that runs on a schedule.
- **Workflow**: a set of connected steps that runs when a trigger fires.

## Main flows

1. First start: the user picks a language and theme, connects at least one model account, and
   creates or picks a first agent.
2. Direct chat: the user opens an agent and sends a message. The reply streams in. Tool use shows
   as compact cards inside the reply. The user can stop the agent at any time.
3. Channel work: the user writes a job in a channel. The lead agent posts a plan. Each part shows
   as a step in the activity panel, and replies to a part are reachable from a small chip under
   the message that started it.
4. Phone: the user pairs the phone with a computer, then reads and sends messages and answers
   approval requests from the phone. The phone can pair with more than one computer.
5. Other computers: the user pairs a second computer with the first. Each computer then shows the
   other as a server and directs its agents. Each computer keeps its own agents and data, unless
   the user turns on sync (016).
6. Sync: the user sets two computers to sync. Both then hold the same agents, chats, memory,
   routines and workflows, and the user can work on either one.

## Rules

- Conversations, files, memory and settings stay on the computer that runs the agent. That
  computer's local database is the source of truth. A linked device shows this data and keeps
  only a cache (012). Two computers that sync (016) each hold a full copy, and a change on one
  reaches the other.
- Model providers and pages the agent visits use the network. Nothing else sends conversation
  content off the computer.
- Secrets never appear in logs, exports or diagnostics.
- The visual style is calm: flat surfaces, no decorative gradients or glows, sentence case,
  medium and semibold weights only, one line icon set, motion under 300 ms that respects reduced
  motion settings.

## Out of scope

- Selling or billing.
- Hosting agents on a remote cloud service.
- Import of data from other apps. A separate tool may do this later; it is not part of ROBot.

## Acceptance

- A new user can go from first start to a streamed agent reply without reading documentation.
- A channel job with two parts shows two plan steps, and both reply chips open the right replies.
- With the network off except for the model provider, all features in this spec still work.
