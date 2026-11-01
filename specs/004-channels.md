# 004 Channels

## Purpose

The user gives a job to a group of agents in one place and watches them divide and finish it.

## Concepts

- **Channel**: name (1 to 60 characters), topic (up to 200), members (agents), one optional lead
  agent, and a section in the place list.
- **Lead**: the agent that reads each new job first. It can answer itself or split the job into
  parts and give each part to a member.
- **Part**: a child task (see 005) given to one member, with a short label.
- **Mention**: `@Name` in a message sends that message to the named agent directly.

## Flows

1. Create: the user picks "New channel", types a name and topic, adds members, and optionally picks
   a lead.
2. Post a job: the user writes in the channel. Without a mention, the lead gets it. With no lead,
   the app asks which member should take it.
3. Split: the lead posts a short plan message and starts parts. Each member posts its replies in
   the channel under its own face and name.
4. Thread chips: under the message that started a part, a chip shows the member's face, the part
   label and the reply count. A click scrolls to the newest reply of that part and flashes it,
   with a "Back to the message" control.
5. Finish: when all parts end, the lead posts one summary message.
6. Change members: the user adds or removes members in channel settings. A member that works
   cannot be removed until its part ends or the user stops it.

## Activity panel ("Now")

- Title "Now" with an activity icon.
- One card per member: face, name, state (idle, working, waiting, offline).
- When a member leads active work, its card lists the plan steps: up to 8 steps, labels cut at
  48 characters, each with a state icon: to do (empty circle), running (spinner), done (check),
  failed (cross). Each icon has a text label for screen readers.
- Cancelled parts do not show. When all work ends, the steps leave the card.

## Rules

- Agents in a channel see the channel messages; each agent keeps its own memory and workspace.
- The user can stop one part or all work in the channel.
- A failed part shows its error in the channel; the lead decides whether to retry or report.

## Acceptance

- A job split into two parts shows two plan steps, two chips, and one summary at the end.
- Stopping the channel cancels all running parts; their steps leave the panel.
