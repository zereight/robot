# What an agent is

This note gives one model for a question: is this thing an agent, or is it a text that an agent
reads? The note backs no behaviour. The specs stay the source. Use the note to speak about the
product and to decide where a new part belongs. A reference to the code goes stale; check it again
before you rely on it.

## The equation

```text
body:     instructions × action space × state × loop
relation: ownership · isolation
executor: model
```

The four parts of the body multiply. One part at zero makes no agent. The two relations are
conditions of the whole equation. Without them, the question "the state of which agent" has no
answer, and the product is not defined.

The model is not a part of the body. The user can change the model of an agent (002, 006), and the
agent keeps its name, its memory, its workspace and its history. The app holds identity as a
question of responsibility, not of behaviour.

## The four parts

| Part | Meaning | At zero | Spec |
| --- | --- | --- | --- |
| Instructions | What the agent must do | It does anything | 002, "Soul", "Handbook" and "Role instructions" |
| Action space | What the agent can do | It only speaks | 007, "Permission level" |
| State | What stays after the turn | It starts blank at each call: a completion | 007, "Workspace"; 008, "Scope" |
| Loop | More than one step, and one way to end | One request gives one answer | 003; 005, "States" |

Before a turn, the app joins three texts in one order: the handbook, the role instructions and the
Soul of the agent (002, "Soul"). These texts are the part *instructions*. The Soul is the one text
of the three that belongs to one agent: it says who the agent is. "Soul" is the word that the user
reads; the part keeps the name *instructions* in this note, because it holds all three texts.

### The action space makes an agent, not the words

Words change the instructions only. "You are a Rust expert" changes no permission, no tool, no
folder and no loop. The action space stays the same. So a text that only adds words is a skill, not
an agent.

The code shows this. A skill is a text in front of the message of the user:

- `packages/shared/src/skills.ts` — `skillLead` makes the text of a skill.
- `apps/desktop/src/main/services/Chat.ts` — the turn puts that text before the message.

The user calls a skill with a slash, or the agent loads one when a task needs it (017). A skill has
instructions only. It has no permission, no folder, no loop and no state
of its own. The product is zero.

## The two relations

**Ownership.** One place answers for the result. Each turn is a task with an owner, a state and a
result (005). Work that no place owns is not work of an agent.

**Isolation.** The state and the action space of an agent do not mix with those of another agent.
The app puts this fact in the data, not in a text:

- one workspace folder for each agent (007),
- one memory scope for each agent, and no agent reads the memory of another (008),
- one permission level for each agent (007).

Isolation is not a part of the product, because a part can be small. Isolation cannot be small. If
two agents share one state, that state has no single owner. 025 shows the same fact from the other
side: two agents can use one folder, but then the app needs a rule for the mix, a file claim (025).
Isolation means "the mix has a named rule", not "no mix".

## The model is an executor

The loop can belong to a program, not to the app. 026 says it:

> How much a saving can do depends on who runs the loop of the agent.

The table in 026, "Where each saving works", gives the result. An agent on an API account works in
the loop of the app, so the app reaches all three savings. The same agent on Claude Code, Codex,
opencode, Muse Code or Cursor works in the loop of that program, so the app reaches less. The model
and the loop are different axes.

## How to count agents

Do not count names. Count the sets of state and action space that share no member.

- Two agents with two folders and two memories are two agents.
- One agent with one hundred skills is one agent.
- One agent whose role text names five jobs is one agent with a wide instruction. It is not five
  agents. The app says the same: the agent cannot change its permission level, its workspace, the
  skills that it may use, or the handbook (002, "Changes from the chat").

A role line is not a part of this equation. The turn prompt of a direct chat holds the handbook and
the Soul of the agent. It holds no role line. A model reads the role line in one place only: the
answer of the settings tool (002, "Changes from the chat"). The turn prompt of a direct chat names
no one. The role line is a label for placement, not an identity. 002,
"Role label", "What the model reads" holds this rule.

## What this model explains

- A large set of skills does not make a large set of agents. The instructions grow. The action
  space and the state stay at one.
- Self-improvement makes no new agent and no new action space. A proposal can change the part
  *instructions* (the Soul, a skill) and the part *state* (memory), and only after the user accepts
  it. A proposal can never touch the permission level, the rules, the workspace or the connections
  (002, "Self-improvement"), so the action space stays as the user set it.
- A routine is not an agent. It is a timer that starts a task of an agent (009). It has no folder,
  no memory and no permission level of its own, and it works in the workspace of its agent.
- A workflow step is not an agent. It uses the loop and the tools of an agent, or a model with no
  tools (010).
- An agent that works in an own copy of a Git repository is still one agent (035). The copy is a
  state of one task, not a second agent.

## Where this model can be wrong

- A worker with no state that does work in one request. Some products call it an agent. This model
  calls it a tool call, and the place that keeps the state is the agent. If a reader accepts the
  other word, the part *state* is wrong.
- A worker with no tools that only writes text. This model calls it a text in the instructions, and
  the person who sends the request is the actor. If a product gives it memory and a loop, it
  becomes an agent again.
- The part *instructions* almost never reaches zero, because the message of the user is an
  instruction. So in practice, test three parts only: action space, state and loop.

## Words

Use "agent" for a worker with the four parts and the two relations. Use "Soul" for the text that
says who one agent is (002). Use "skill" for saved
instructions that the user calls with a slash (017). Do not call a skill an agent. Do not call a
text that only adds words an agent.
