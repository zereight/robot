# CC Workflow Studio file mapping

This document tells how ROBot reads and writes a file of CC Workflow Studio, a public tool that
draws a workflow on a canvas ([github.com/breaking-brake/cc-wf-studio](https://github.com/breaking-brake/cc-wf-studio)).
The behaviour of import and export is in [specs/010-workflows.md](../specs/010-workflows.md),
section "CC Workflow Studio files".

- ROBot follows the public form of the file. It uses no code and no package of that project.
- The form below comes from the public types and checks of `@cc-wf-studio/core` 0.4.0 (MIT), and
  from sample files of the project. A spec author reads them again when that tool changes its
  file form.
- A field that this document does not define is ignored.

## What the file is

- One JSON object in UTF-8 text. The file is at most 10 MB. ROBot refuses a larger file before it
  reads it.
- The object has one of two forms. ROBot reads both:
  - **Bare form**: the object holds `nodes` and `connections` (both arrays) at the top.
  - **Wrapped form**: the object holds `workflow`, and `workflow` is a bare form. Other fields at
    the top, such as `meta`, are ignored.
- A file with `format` equal to `"robot-workflows"` is a ROBot file (see
  [workflow-file-format.md](workflow-file-format.md)). A file that has neither the bare form nor
  the wrapped form is refused.
- The file holds one workflow.
- The file holds no result of a check (spec 010, "Check"). ROBot writes none and reads none. An
  imported workflow is "Not checked", and its switch "Check before a run" is on.

## Fields that ROBot reads

| Where | Field | Use |
| --- | --- | --- |
| workflow | `name` | The name of the workflow. ROBot removes spaces at both ends and cuts it to 60 characters. A workflow with no name is refused. |
| workflow | `nodes` | The nodes. |
| workflow | `connections` | The connections. |
| workflow | `subAgentFlows`, `slashCommandOptions` | Not read. "Not imported" lists `subAgentFlows` when it holds an entry, and `hooks` when `slashCommandOptions.hooks` holds an entry. |
| node | `id`, `type`, `name`, `data` | `id` is a string and is unique. `name` is a text. `data` is an object. |
| node | `position` | `x` and `y`, numbers. |
| node | `parentId` | The id of a `group` node. See "Place of a node". |
| connection | `from`, `to`, `fromPort` | The ends, and the port where the connection leaves. `fromPort` can be missing. |

A node with a missing id, a repeated id, a missing type or a `position` that is not two numbers
makes ROBot refuse the file, and the message names the node.

## Import: from node to step

| `type` | Result in ROBot |
| --- | --- |
| `start`, `end` | Nothing. "Not imported" does not list them. |
| `subAgent` | An agent step with no agent. See "Agent step". |
| `prompt` | An agent step with no agent. See "Agent step". |
| `ifElse` | A condition. See "Condition". |
| `askUserQuestion`, `switch`, `branch`, `skill`, `mcp`, `codex`, `subAgentFlow`, `branchSession`, `group`, and any other `type` | A note. See "Note from a node". |

### Agent step

- Name of the step: for `subAgent` its `data.description`, for `prompt` its `data.label`. If that
  is empty, the `name` of the node. ROBot removes spaces and cuts it to 60 characters.
- Prompt of the step:
  - `subAgent`: `data.agentDefinition`, an empty line, then `data.prompt`. An empty part leaves
    out its empty line.
  - `prompt`: `data.prompt`. For each key `k` in `data.variables` that has a text value, the text
    `{{k}}` becomes that value. Other `{{...}}` text stays as it is.
  - ROBot cuts the prompt to 20 000 characters. "Not imported" lists a cut ("Text cut").
- `agent` is empty. `effort` and `continueOnFailure` have their defaults.
- "Not imported" lists, once for each field name and workflow, the fields that ROBot does not
  make: `model`, `tools`, `memory`, `color`, `agentType`, `builtInType` of a `subAgent`. The row
  names the field as `subAgent.<field>`.

### Condition

- Name of the step: `data.evaluationTarget`, or the `name` of the node if that is empty. Same
  limits as the name of an agent step.
- Mode `"ask"`. Text: `data.evaluationTarget`, a line break, then `data.branches[0].condition`.
  The first line and its line break are left out when `evaluationTarget` is empty. ROBot cuts the
  text to 20 000 characters.
- A connection from the port `branch-0` has the branch `"yes"`. A connection from the port
  `branch-1` has the branch `"no"`. A connection from any other port, or with no port, is a lost
  connection (see "Connections").

### Note from a node

- Place: see "Place of a node". Tone: `"pink"`.
- Text: the line `Not imported: <type> <name>`, then a line break, then the text of the node:

| `type` | Text of the node |
| --- | --- |
| `askUserQuestion` | `data.questionText`, and the labels of `data.options` on one line, with commas. |
| `switch` | `data.evaluationTarget`, and the labels of `data.branches` on one line, with commas. |
| `branch` | The labels of `data.branches` on one line, with commas. |
| `skill` | `data.name`, a line break, `data.description`. |
| `mcp` | `data.toolName`. |
| `codex` | `data.label`, a line break, `data.prompt`. |
| `subAgentFlow`, `group` | `data.label`. |
| `branchSession` | `data.label`, a line break, `data.workDescription`. |
| other | empty |

- ROBot cuts the note text to 2 000 characters, and "Not imported" lists the cut ("Text cut").
  After 50 notes, a node makes no note, and "Not imported" lists it alone.
- "Not imported" lists each such node with its type, its name, and the reason "No step for this
  node".

### Place of a node

- A node that has `parentId` holds a place that is **relative to its group**. Its place on the
  canvas is its `position` plus the `position` of its group, and for a group in a group, plus the
  group above it, up the chain. A chain that loops makes ROBot refuse the file.
- ROBot rounds `x` and `y` to integers. A value with a size above 1 000 000 is cut to 1 000 000.
  The result is the field `x` and `y` of the step or note.

### Connections

- A connection joins two steps when both ends are nodes that became steps.
- A connection to or from `start` or `end` is dropped and is not a loss.
- A connection to or from a node that became a note is dropped. It is a **lost connection**. A
  step that was the end `to` of a lost connection is a **step that lost an input**. After the
  import it shows "Connect" (see 014).
- A connection with an unknown node id is a fault of the file. ROBot refuses the file.
- The same connection twice counts as once.
- A connection that joins a node to itself, and a loop, are refused by the rules of the graph (see
  [workflow-file-format.md](workflow-file-format.md)). So is a condition that has no connection
  for the branch `"yes"` or for the branch `"no"`, also when the connection was lost.
- The file holds more than 30 steps (agent steps and conditions together): ROBot refuses it.

## Export: from step to node

The file is a bare form. ROBot writes these fields.

| Field | Value |
| --- | --- |
| `id` | `workflow-` and the time of the export, in milliseconds since 1970-01-01 00:00 UTC. |
| `name` | The name of the workflow in lower case. A run of characters that are not `a-z`, `0-9`, `-` or `_` becomes one `-`, and a run of `-` becomes one `-`. A `-` at the start or the end is removed. The result is cut to 100 characters. If it is empty, `workflow`. |
| `version` | `"1.0.0"` |
| `nodes`, `connections` | See below. |
| `createdAt`, `updatedAt` | The time of the export, in ISO 8601 form. |

### Nodes

Every node has `id`, `type`, `name`, `position` and `data`. The `name` of a node uses only the
characters `a-z`, `A-Z`, `0-9`, `-` and `_`, at most 50 of them.

| ROBot | Node | Fields of `data` |
| --- | --- | --- |
| (added) | `start`, id and name `start` | `label`: `"Start"`. |
| (added) | `end`, id and name `end` | `label`: `"End"`. |
| agent step, node number `n` | `subAgent`, id and name `step-n` | `description`: the name of the step, cut to 200 characters. `agentDefinition`: empty. The tool reads it as a part of the prompt, so an agent name here would come back into the prompt. `prompt`: the prompt cut to 10 000 characters, or the name of the step when the prompt is empty. `outputPorts`: 1. |
| condition, node number `n` | `ifElse`, id and name `step-n` | `evaluationTarget`: `"The input of this step"`. `branches`: two entries. Entry 0 has `label` `"Yes"`. Entry 1 has `label` `"No"` and `condition` `"Otherwise"`. `outputPorts`: 2. See below for `condition` of entry 0. |
| approval, node number `n` | `askUserQuestion`, id and name `step-n` | `questionText`: the message cut to 500 characters, or `"Do you approve?"` when it is empty. `options`: two entries, `"Approve"` with `description` `"Go on"` and `"Reject"` with `description` `"Stop"`. `outputPorts`: 2. |
| post step, notify step | no node | The step is not written. See "Connections". |
| note | no node | Not written. |

`condition` of entry 0 of an `ifElse`: in the mode `"contains"` it is
`The input contains "<text>", ignoring case`. In the mode `"ask"` it is the text of the step. If
the text is empty it is `True`. The app cuts it to 500 characters.
So a condition in the mode `"contains"` comes back from an import in the mode `"ask"`.

Place: `x` and `y` are the place of the step, as ROBot holds it. The node `start` is 250 to the
left of the step that is farthest left, at the height of the first step. The node `end` is 250 to
the right of the step that is farthest right, at the height of the last step. With no steps they
are at (0, 0) and (250, 0).

### Connections

Each connection has `id` (`c-1`, `c-2`, and so on), `from`, `to`, `fromPort` and `toPort`.

| Node where the connection leaves | `fromPort` |
| --- | --- |
| `start`, `subAgent` | `output` |
| `ifElse` | `branch-0` for the branch `"yes"`, `branch-1` for the branch `"no"` |
| `askUserQuestion` | `branch-0`. The answer `"Reject"` (`branch-1`) has no connection. |

`toPort` is always `input`.

- The node `start` connects to every written step that has no input.
- Every written step that has no output connects to the node `end`. A workflow with no written
  step connects `start` to `end`.
- A step that is not written is skipped. Each connection that goes into it goes on to each
  step that it connects to, with the same branch. If it connects to nothing, the connection goes
  to the node `end`.

### The list "Not exported"

After the write, the app lists what the file does not hold:

- each step that is not written, with its kind and its name ("No node for this step"),
- the trigger, when it is not "manual" (a schedule, a message or a web hook),
- the notes, as a count,
- the agent, the effort and the mark "Continue on failure" of agent steps, as one count of steps,
- each text that the app cut, with the step.

If nothing is on the list, the app shows no list. The text `{{input}}` and `{{trigger}}` stays in
the prompts as plain text, and the list does not name it.

### Text that looks like a secret

ROBot hides it as in a ROBot file (see "Secrets in text" in
[workflow-file-format.md](workflow-file-format.md)), in every text of the import and of the
export.

## Checks

- A file that ROBot writes is accepted by `ccwf validate` of the CLI of that project. This is a
  check by hand. The test suite does not need the CLI.
- The test files of the import are written by hand from this document. No file of that project is
  copied into the repository, because the project has files under a licence that ROBot cannot
  take (AGPL-3.0).
