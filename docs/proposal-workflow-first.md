# Proposal: workflow first, roles from skills

Status: proposal. No spec says this yet. The owner decides the open questions at the end. Then a
spec-writer slice changes the specs. This note changes no behaviour.

## The idea

The Workflows page is the home of ROBot. Each workflow has one responsible agent, its **owner**.
The user talks to the owner on the canvas, and the owner edits the workflow in that talk. The user
does not make agents one by one. When a step needs a new role, the owner gets a new skill for that
step. The owner keeps memory and improves itself from its runs. `tla-ts` checks every change.

This agrees with `docs/what-an-agent-is.md`: words and skills add instructions only. A new role is
a skill. It is not a new agent.

## What the specs say now, and what the proposal changes

| Spec | Now | Proposed |
| --- | --- | --- |
| 001 | The app opens on the place list of agents. The Workflows button opens a page of its own. | The app opens on the workflow list. The agent list stays as a page, and it is not the home. |
| 010 | A workflow has no owner (shared) or one owner. A step names an agent. Participants are checked. | Every workflow has one owner. A step names skills and a prompt, and the owner runs it. No participant rule. |
| 010 | The assistant is any agent that the user picks in a panel. | The panel is the direct chat of the owner. The user picks nothing. |
| 010 | A new workflow starts with owner "None". | A new workflow starts with an owner: an agent that exists, or a new agent that the app makes for it. |
| 017 | The user or the agent makes a skill from work or from a teach flow. | The same, and also from a step on the canvas: "Give this step a new role" makes a skill and adds it to the step. |
| 002 | Self-improvement proposes changes to Soul, skills and memory. | The owner also proposes changes to its workflow after a run. The user accepts each one. A change that fails the Check cannot be accepted. |
| 008 | One memory scope for each agent. | Open question 4. |
| 037 | The main agent has the manage tool "Make a workflow" with agent steps. | Steps name skills. The tool takes skills and a prompt for each step. |

## Behaviour in detail

### Home

1. The user starts the app. The workflow list shows. A card shows the name, the owner, the state of
   the last run and the state of the Check.
2. With no workflow, the page shows one button, "New workflow", and one line that says what a
   workflow is.

### New workflow

1. The user presses "New workflow" and types a name.
2. The user picks the owner from the agents that exist, or picks "New agent". "New agent" makes an
   agent with a name, a face and the default model, and no role text. The user does not fill a form.
3. The canvas opens with the chat of the owner beside it.

### Talk on the canvas

1. The chat is the direct chat of the owner (003). The app tells the owner which workflow is open
   (010, "Assistant").
2. The owner changes the workflow with the same tools and rules as the assistant of 010. A change
   keeps the earlier graph as a version.
3. The owner can say that a step needs a role it does not have. It proposes a skill. The user sees
   the text, edits it, and accepts. The skill is saved (017) and added to that step.

### Step

1. A step has a name, a prompt, and a list of skills (zero or more).
2. At run time the owner works the step. The text of each skill of the step goes before the prompt,
   as 017 says for a slash call.
3. A step does not name another agent. Work for another agent uses "send message" inside the
   step (007).
4. The permission level, the workspace and the memory are those of the owner. A step cannot change
   them.

### Check

1. The Check of 010 stays. It also finds a step whose skill is deleted or off.
2. Every change by the owner, by the user or by a self-improvement proposal passes the Check before
   it saves. A failed Check shows the problem and the steps on its path, as 010 says.
3. `tla-ts` checks the graph. It is not the engine that runs it (`docs/rebuild-plan.md`, decision
   3).

### Memory and self-improvement

1. After a run ends, the owner can read the run and make proposals (002, "Self-improvement"). A
   proposal can change the workflow, a skill, the Soul or memory.
2. The user accepts or refuses each proposal. The user can undo an accepted one.
3. A proposal never changes the permission level, the rules, the workspace or the connections
   (002). This stays as it is.

## Slices

| Slice | Role | Work |
| --- | --- | --- |
| W1 | spec-writer | 001, 010, 000, glossary: home, required owner, steps with skills, chat of the owner. |
| W2 | spec-writer | 002, 008, 017, 037: self-improvement of a workflow, scope of memory, skill from a step, manage tool. |
| W3 | spec-writer | Workflow file (`docs/workflow-file-format.md`) and CC Workflow Studio file: steps with skills. |
| W4 | implementer | Schema and data for owner and step skills. C1 already resets the schema. |
| W5 | implementer | Home page, new workflow dialog, chat of the owner. |
| W6 | implementer | Run a step with skills. Check of the skills. |
| W7 | implementer | Proposals for a workflow. Accept only after the Check. |

W4 to W7 start after W1 to W3 are merged.

## Open questions

These are also in `docs/spec-questions.md`. Do not guess them in a spec.

1. **Agents page.** Does the agent list stay as a page? A user who has many agents needs a place to
   see them. Proposed: it stays, and it is not the home.
2. **Another agent in a step.** Can a step name another agent? Proposed: no in W1. Use "send
   message" in the step. If yes, the participant rule of 010 stays for that case.
3. **Delete the owner.** A workflow must have an owner. Proposed: the confirm of a delete asks for
   a new owner for each workflow, and the delete does not go on without one.
4. **Memory scope.** One owner can have many workflows. Their facts mix in one memory scope.
   Proposed: one scope for each agent as now, and each memory item can name a workflow. The user
   can filter by it. 008 decides.
5. **Chat of the owner.** One thread for each workflow, or the main thread of the owner? Proposed:
   one thread for each workflow, so the talk about one workflow does not mix with the others.
6. **Files.** A workflow file holds agent names now. Proposed: it holds skill texts for each step
   and the owner as a name. Import makes a new agent for an owner that does not exist.
7. **Routines (009).** A routine starts a task of an agent. Does it start a workflow of its owner
   too? Not part of this proposal. A routine stays as it is until the owner says otherwise.
8. **What the Check proves.** The Check finds a step that never runs and a loop. Does the owner
   want it to prove more (for example, that every approval step is on the way to an effect)?
   Each added property is a spec change to 010, "What the check finds".
