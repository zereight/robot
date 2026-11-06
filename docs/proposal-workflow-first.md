# Proposal: the workflow is the product

Status: proposal. No spec says this yet. The owner decides the open questions at the end. Then a
spec-writer slice changes the specs. This note changes no behaviour.

## Decisions of the owner

| No. | Decision |
| --- | --- |
| 1 | There is no agent list and no agent page. |
| 2 | A node holds a prompt, like a skill. It also holds a provider, a model and a reasoning level. |
| 3 | The workflow is fixed by the user before it runs. It is not a dynamic workflow. |
| 4 | The responsible agent is one skill document. It is not an entity that the user changes. |
| 5 | One responsible agent has one workflow. |
| 6 | Each workflow has one chat. |
| 7 | The workflow file stays editable, and it is in TLA form. |
| 8 | The check verifies the TLA. |
| 9 | A node can use a decision model (013), for example Jev. |
| 10 | A decision node that has no winner asks the user. A scheduled run with no user waits as a task that waits for the user (005). |
| 11 | A task is one run of a node. |
| 12 | A routine becomes a trigger of a workflow. Spec 009 ends. |
| 13 | The user's own skills and the slash call stay, as texts that a node prompt can include. |
| 14 | The TLA module holds the graph, the prompts as strings, and the rules of the check. |
| 15 | The app writes the standard rules (no deadlock, every node can run, every approval node comes before its effect). The user adds more in the module. |
| 16 | No migration of old data. |
| 17 | A text node can use tools: shell, files, browser and memory (007, 008). A decision node uses none. |
| 18 | A workflow has one workspace folder and one permission level (007). A new workflow gets an empty folder in the default workspace folder (013) and the default level of a new agent. A node can pick a stricter level than the workflow, never a looser one. Only the user changes the folder and the levels. A node and a self-improvement proposal cannot. Reason: the check needs the level of each node before the run. |

## The model

```text
workflow  =  graph of nodes  +  one responsible document  +  one chat  +  one memory
node      =  prompt  +  provider  +  model  +  reasoning level
```

- **Responsible document**: a text, like a skill (017). It says who answers for the workflow, its
  character and its limits. It is the Soul of the old model. The user edits the text. There is no
  "change the agent" action. The text can change by a self-improvement proposal that the user
  accepts.
- **Node**: has no agent. It runs its prompt on its model, after the responsible document. A node
  is a **text node** (a model that writes text) or a **decision node** (see below).
- **Decision node**: asks a decision model (013, "Decision model") one question with a fixed list
  of options. The model gives a probability for each option. The node takes the option with the
  highest probability when it is at least the threshold of the node. Each option is one outgoing
  connection. It uses no reasoning level and writes no text.
- **Chat**: the user talks to the workflow. The responsible document answers. The talk edits the
  workflow. A change keeps the earlier graph as a version.
- **Memory**: one scope for each workflow. The workflow learns from its runs.
- **Check**: verifies the TLA form of the workflow. A change passes the check before it saves.

## What goes, what changes

| Spec | Now | Proposed |
| --- | --- | --- |
| 001 | The app opens on the agent list. | The app opens on the workflow list. No agent list. |
| 002 | The agent is the main object: face, model, workspace, permission, memory, Soul. | Removed as an object. Soul, memory and self-improvement move to the workflow (see 008, 010). |
| 003 | A direct chat with an agent. | A chat with a workflow. One chat for each workflow. |
| 005 | A task is one run of an agent. | A task is one run of a node (decision 11). |
| 007 | Workspace folder and permission level for each agent. | Open question 1. |
| 008 | One memory scope for each agent. | One scope for each workflow. |
| 009 | A routine starts a task of an agent. | Ends. A trigger of a workflow takes its place (decision 12). |
| 010 | Owner is none or one agent. A step names an agent. | Every workflow has one responsible document. A node has a prompt and a model. No participant rule. |
| 017 | A skill is a text that the user or the agent calls. | The same. A node prompt and the responsible document have the form of a skill (decision 13). |
| 037 | Manage tools make and change agents and workflows. | Only the tools for a workflow stay. |
| 011, 012, 019 | The phone and the sync carry agents. | They carry workflows. |

## Behaviour

### Home

1. The workflow list shows. A card shows the name, the state of the last run and the state of the
   check.
2. With no workflow, the page shows one button, "New workflow", and one line that says what a
   workflow is.

### New workflow

1. The user presses "New workflow" and types a name.
2. The app makes the responsible document with a short default text. The user can edit it.
3. The canvas opens with the chat beside it.

### Chat and edit

1. The chat is the chat of this workflow. No other chat talks about it.
2. The responsible document answers. It changes the graph with the tools of 010, "Assistant".
3. Every change passes the check. A failed check shows the problem and the steps on its path, and
   the change does not save.

### Node

1. A node has a name, a prompt, a provider, a model and a reasoning level (006).
2. At run time the app sends the responsible document and the node prompt to the model of the
   node. The node gets the input of the step before it.
3. A text node can use the tools of 007 in the folder and at the level of the workflow (decision 18).

### Decision node

1. The user writes the question and 2 or more options, and sets a threshold (the default is 0.9).
2. The model is one of the choices of 013: Jev, Clef or a local server. The workflow uses the
   choice that the user saved in settings.
3. At run time the node sends the question, the options and the input of the step. The run goes
   on along the connection of the option that wins.
4. The run view shows the probability of each option.
5. When no option reaches the threshold, when the model gives no answer in 3 seconds, or when the
   choice is off or has no key, the node asks the user to pick the option, with the approval card
   (the same rule as 007, "Ask when unsure"). Decision 10 says what the node does.
6. The words of the input go to the service of the choice. The settings text of 013 says so.
7. The check (below) sees a decision node as a branch with one state for each option.

### Check

1. The check reads the TLA form of the workflow. It reports a deadlock, a node that never runs and
   a rule that a state breaks.
2. `tla-ts` is the tool (MIT). It checks. It does not run the workflow
   (`docs/rebuild-plan.md`, decision 3).

### File

1. The file is a TLA module that the user can edit. Decision 14 says what the module holds.
2. An import checks the module and shows the review screen (014).

### Self-improvement

1. After a run, the workflow can propose a change to its responsible document, to a node prompt,
   to the graph or to its memory.
2. The user accepts or refuses each one, and can undo an accepted one.
3. A change that fails the check cannot be accepted.

## Slices

| Slice | Role | Work |
| --- | --- | --- |
| W1 | spec-writer | 000, 001, 010: the model above. Remove the agent list. |
| W2 | spec-writer | 002, 003, 005, 007, 008, 009, 017, 037: remove the agent as an object. Move Soul, memory and self-improvement to the workflow. |
| W3 | spec-writer | 011, 012, 014, 019, `docs/workflow-file-format.md`: carry workflows. The file is TLA. |
| W4 | implementer | Schema reset for the new model. |
| W5 | implementer | Home, new workflow, chat of the workflow. |
| W6 | implementer | Node run with provider, model and reasoning. |
| W7 | implementer | The check on the TLA form. |
| W8 | implementer | Memory and self-improvement for a workflow. |

W4 to W8 start after W1 to W3 are merged. W2 is large: this proposal removes the main object of
the app.

## Open questions

None. All questions have an answer from the owner. W1 to W3 can start.

## Notes

- **Name of the decision model.** The owner wrote "Jev Omni" and said the name is a typo. The
  repository holds Jev and Clef (013). The OpenRouter model list holds `typesafe/jev-router` and
  no model with the name Omni (checked once, not a proof that it does not exist). The proposal
  does not name a model. A decision node uses the model name that the user saves in settings (013).
