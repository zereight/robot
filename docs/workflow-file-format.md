# Workflow file format

This document tells how to write and read a workflow file. A tool can use it to make workflow
files for ROBot without the code of the app. The behaviour of export and import is in
[specs/010-workflows.md](../specs/010-workflows.md), section "Workflow file".

Format name: **`robot-workflows`**. Format version: **1**.

## What the file is

- The file is one JSON object in UTF-8 text. A byte order mark at the start is allowed.
- The file name ends in `.json`.
- The file is at most 10 MB (10 485 760 bytes). ROBot refuses a larger file before it reads it.
- The file holds 1 to 20 workflows.
- For each workflow, the file holds: name, trigger, steps, connections, and notes.
- The file never holds a run, a version, a chat, a key, a secret, a channel, or an id. See "What
  the file does not hold".

## Fields

Text lengths count characters, not bytes. A character with a code point above U+FFFF counts as
one. "Removes spaces" means that ROBot removes the spaces at both ends of the text.

A field that this document does not define is ignored. A field that is marked "no" in the column
"Required" may be missing or `null`, and then it has its default.

### The file object

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `format` | string | yes | Must be `"robot-workflows"`. |
| `version` | integer | yes | Must be `1`. ROBot refuses a higher number. |
| `workflows` | array of workflow objects | yes | 1 to 20 entries. |

### Workflow object

| Field | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `name` | string | yes | | 1 to 60 characters after ROBot removes spaces. The names in one file must differ, ignoring case. |
| `trigger` | trigger object | no | manual | See below. |
| `steps` | array of step objects | no | `[]` | 0 to 30 entries. The order of the list gives the node numbers (see "Connections"). |
| `connections` | array of connection objects | no | `[]` | No limit of its own: the 10 MB limit of the file applies. |
| `notes` | array of note objects | no | `[]` | 0 to 50 entries. Notes do not count towards the 30 steps. |

### Trigger object

| `kind` | Other fields | Meaning |
| --- | --- | --- |
| `"manual"` | none | The user starts the workflow. |
| `"schedule"` | `schedule`: schedule object (required) | The workflow starts at the times of the schedule, while the workflow is on. |

A workflow that starts by a message in a channel, or by a web hook (spec 010), has no form in
the file. ROBot writes such a workflow with the trigger `"manual"`, and the secret of a web hook
stays out of the file. A file with another `kind` is refused.

### Schedule object

The field `kind` selects the form. All times use the time zone of the computer that runs the
workflow. Other fields of the object are ignored.

| `kind` | Other fields | Meaning |
| --- | --- | --- |
| `"once"` | `at`: number | One run at the instant `at`. `at` is in milliseconds since 1970-01-01 00:00 UTC. |
| `"every"` | `minutes`: integer, 1 or more. `from`: number | A run at the instant `from`, and then every `minutes` minutes. `from` is in milliseconds since 1970-01-01 00:00 UTC. |
| `"daily"` | `times`: array of strings, at least one | A run each day at each time. A time is `"H:MM"` or `"HH:MM"` on a 24-hour clock, for example `"08:30"`. |
| `"weekly"` | `days`: array of integers from 0 to 6, at least one. `time`: string | A run on each of the days, at `time`. 0 is Sunday and 6 is Saturday. `time` has the same form as in `"daily"`. |
| `"cron"` | `expr`: string | A run when the expression matches. The expression has five fields that a space separates: minute (0-59), hour (0-23), day of month (1-31), month (1-12), day of week (0-6, and 7 is Sunday). Each field takes `*`, a number, a list (`1,15`), a range (`1-5`) and a step (`*/10`, `0-30/5`). Names such as `MON` are not allowed. When both day fields are not `*`, a day that matches one of them runs. |

A schedule that does not follow this table makes ROBot refuse the whole file. The schedule is the
same as the schedule of a routine in the [agent file](agent-file-format.md).

### Step object

Every step has these fields. The field `kind` selects the other fields.

| Field | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `kind` | string | yes | | One of `"agent"`, `"condition"`, `"approval"`, `"post"`, `"notify"`. |
| `name` | string | yes | | 1 to 60 characters after ROBot removes spaces. It does not need to be unique. |
| `x` | number | no | on a grid | The place on the canvas, to the right. ROBot rounds it to an integer. Its size is at most 1 000 000. |
| `y` | number | no | on a grid | The place on the canvas, down. Same rule as `x`. |

A step with no `x` and `y` goes on a grid, three steps in a row: step number `n` (from 1) goes to
`x = ((n - 1) mod 3) * 230` and `y = floor((n - 1) / 3) * 110`. A tool that cares about the look
should give a place to each step. A step is 180 wide and 64 high.

Texts that are called "template" below may hold `{{input}}`, which becomes the result of the steps
before, and `{{trigger}}`, which becomes the text that started the run.

#### Kind `"agent"`: an agent step

An agent does a job. It is a task of that agent.

| Field | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `agent` | string | no | `""` | The name of the agent, at most 40 characters. See "How ROBot links the agent". |
| `prompt` | string | no | `""` | A template. At most 20 000 characters. ROBot does not remove spaces. |
| `effort` | string | no | the effort of the agent | One of `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`, `"ultra"`. The step runs one turn with this effort, if the model that runs the step lists it. If the model does not list it, the step uses the effort of the agent, and then the nearest level that the model lists (spec 006). |
| `continueOnFailure` | boolean | no | `false` | When `true`, the run goes on if this step fails. |

#### Kind `"condition"`: an if and else

A condition takes the branch `"yes"` or the branch `"no"`. It passes its input on unchanged.

| Field | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `mode` | string | no | `"contains"` | `"contains"` or `"ask"`. |
| `text` | string | no | `""` | At most 20 000 characters. In mode `"contains"`, it is the text that the input must contain, ignoring case. In mode `"ask"`, it is a question about the input that a model can answer with yes or no. |

The file holds no model for mode `"ask"`. ROBot chooses the model when the step runs.

#### Kind `"approval"`: wait for the user

The run waits at this step until the user approves or rejects. It passes its input on unchanged.

| Field | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `message` | string | no | `""` | The text that the approver sees. At most 20 000 characters. |

#### Kind `"post"`: post a message

The step posts a message in a channel. The file holds no channel, so the step has no place after
an import.

| Field | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `text` | string | no | `"{{input}}"` | A template. At most 20 000 characters. |

#### Kind `"notify"`: show a system notification

The step shows a system notification of the kind "workflow notice". The body is the first 200
characters of the input of the step. The step passes its input on unchanged.

| Field | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `title` | string | no | `""` | The title of the notification. At most 100 characters. When it is empty, the name of the step is the title. |

### Connection object

A connection joins the result of one step to the input of another. Steps are named by their node
number: the place in the list `steps`, counted from **1**. So the first step of the list is 1.

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `from` | integer | yes | The node number of the step where the connection starts. 1 to the number of steps. |
| `to` | integer | yes | The node number of the step where the connection ends. 1 to the number of steps. |
| `branch` | string | for a condition | `"yes"` or `"no"`. Needed when `from` is a condition. On a connection from another kind of step it is ignored. |

The same connection twice counts as once.

### Note object

A note is a text on the canvas. It has no connection, no node number, and no effect on a run.

| Field | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `text` | string | no | `""` | At most 2 000 characters. Line breaks are allowed. |
| `tone` | string | no | `"yellow"` | One of `"yellow"`, `"blue"`, `"green"`, `"pink"`. |
| `x` | number | no | on a grid | The place, as for a step. |
| `y` | number | no | on a grid | The place, as for a step. |

A note with no `x` and `y` goes on the same grid, in the rows below the steps: the first row for
notes is `ceil(number of steps / 3) + 1`, and `y = (that row + floor((m - 1) / 3)) * 110` for note
number `m`. A note is 200 wide.

## The rules of the graph

ROBot checks these rules for each workflow when it reads the file, and again when it writes one.

1. A workflow has at most 30 steps.
2. Each connection joins two steps that exist (`from` and `to` are node numbers that are in the
   list).
3. No connection joins a step to itself.
4. Each connection that leaves a condition has a `branch`.
5. Each condition has at least one connection with the branch `"yes"` and at least one with the
   branch `"no"`.
6. The connections make no loop.

A workflow with no steps is allowed.

## What the file does not hold

The file has no field for these. If a tool writes one, ROBot ignores it.

- **Runs, versions and chats.** A workflow comes without its history.
- **Ids.** ROBot gives new ids when it imports.
- **Channels.** A post step has no place until the user picks one.
- **Agents.** The file holds the name of an agent, not the agent.
- **A model for a condition.** ROBot chooses it.
- **On or off.** Every imported workflow is off.
- **Keys and secrets.**

## Secrets in text

ROBot replaces text that looks like a secret with `[redacted]`. It does this when it writes a file,
and again when it reads one. This applies to every text of the file: the names, the prompts, the
texts of conditions, posts and approvals, the titles, the agent names and the notes. It applies
to:

- keys that start with `sk-`
- `Bearer` tokens
- GitHub tokens
- AWS access key IDs
- Slack tokens
- Google API keys
- JSON web tokens
- private key blocks
- every key that is stored in the app on that computer

A tool must not write secrets into a workflow file.

## How ROBot imports a file

1. ROBot checks the size, then the whole file. If one value is not valid, or one workflow breaks
   the rules of the graph, ROBot refuses the whole file and makes no workflow.
2. The user sees the review screen (spec 014, "Review before an import"): each workflow with a
   tick box, the agent names that ROBot cannot find, and the parts that ROBot does not make. The
   user confirms.
3. ROBot makes the workflows in the order of the file. It makes **new workflows only**. It never
   changes a workflow that exists. It makes no agent, no channel and no routine.
4. If the name of a workflow is taken, ignoring case, the workflow gets a number: `Digest` becomes
   `Digest 2`, then `Digest 3`. The name stays inside 60 characters: ROBot cuts the end of the name
   to make room for the number.
5. **Every imported workflow is off.** Its schedule does not fire until the user turns it on.
6. If a step fails after some workflows are made, those workflows stay. ROBot shows the name of the
   workflow where it stopped, and the reason.

### How ROBot links the agent

An agent step is linked to the agent of the same server that has the same name as `agent`. ROBot
ignores case and spaces at both ends when it compares names. An agent that is archived does not
count.

If there is no such agent, the step has no agent. It shows "Pick an agent", and a run fails at that
step with the reason "No agent". `agent` that is empty or missing has the same result.

A post step always shows "Pick a place", and a run fails at that step with the reason "No place",
until the user picks a channel.

## When ROBot refuses a file

| Cause | Note |
| --- | --- |
| The text is not JSON, or `format` is not `"robot-workflows"`. | |
| `version` is not an integer of 1 or more. | |
| `version` is higher than 1. | The file comes from a newer format. |
| `workflows` is not an array, or it is empty. | |
| `workflows` has more than 20 entries. | |
| The file is larger than 10 MB. | |
| Two workflows have the same name. | ROBot removes spaces at both ends and ignores case when it compares. |
| A value has the wrong type or is outside its limit. | The message names the place, for example `workflows[1].steps[0].effort`. |
| A schedule is not valid. | The message names the place, for example `workflows[0].trigger.schedule`. |
| A workflow breaks a rule of the graph. | The message names the workflow and the place: a step or a connection, counted from 1. |

## Example

This file holds one workflow. It asks the agent `Ada` for a draft, asks a model if the draft is
polite, posts the draft if it is, and shows a notification if it is not.

```json
{
  "format": "robot-workflows",
  "version": 1,
  "workflows": [
    {
      "name": "Polite draft",
      "trigger": {
        "kind": "schedule",
        "schedule": { "kind": "daily", "times": ["08:30"] }
      },
      "steps": [
        {
          "kind": "agent",
          "name": "Draft",
          "x": 0,
          "y": 0,
          "agent": "Ada",
          "prompt": "Write a short note to the team about {{trigger}}.",
          "effort": "low"
        },
        {
          "kind": "condition",
          "name": "Polite?",
          "x": 260,
          "y": 0,
          "mode": "ask",
          "text": "Is this text polite?"
        },
        { "kind": "post", "name": "Post it", "x": 520, "y": -50, "text": "{{input}}" },
        { "kind": "notify", "name": "Warn me", "x": 520, "y": 60, "title": "The draft is not polite" }
      ],
      "connections": [
        { "from": 1, "to": 2 },
        { "from": 2, "to": 3, "branch": "yes" },
        { "from": 2, "to": 4, "branch": "no" }
      ],
      "notes": [{ "text": "Pick a channel for step 3 after the import.", "tone": "blue", "x": 520, "y": 160 }]
    }
  ]
}
```
