# Agent file format

This document tells how to write and read an agent file. A tool can use it to make agent files
for ROBot without the code of the app. The behaviour of export and import is in
[specs/002-agents.md](../specs/002-agents.md).

Format version: **1**.

## What the file is

- The file is one JSON object in UTF-8 text. A byte order mark at the start is allowed.
- The file name ends in `.json`.
- The file is at most 10 MB (10 485 760 bytes). ROBot refuses a larger file before it reads it.
- The file holds 1 to 40 agents.
- For each agent, the file holds: name, role line, instructions, face, and routines.
- The file never holds a model, a workspace folder, a permission level, a key, a secret, a chat
  history or a memory. See "What the file does not hold".

## Fields

Text lengths count characters, not bytes. A character with a code point above U+FFFF counts as
one.

### The file object

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `format` | string | yes | Must be `"robot-agents"`. |
| `version` | integer | yes | Must be `1`. ROBot refuses a higher number. |
| `agents` | array of agent objects | yes | 1 to 40 entries. |

### Agent object

| Field | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `name` | string | yes | | 1 to 40 characters after ROBot removes spaces at both ends. |
| `role` | string | no | `""` | The role line. At most 120 characters after ROBot removes spaces at both ends. |
| `instructions` | string | no | `""` | Text that the agent always follows. No limit of its own: the 10 MB limit of the file applies. Line breaks are allowed. |
| `face` | face object or `null` | no | `null` | See below. When it is missing or `null`, ROBot draws a face from the name. |
| `routines` | array of routine objects | no | `[]` | No limit of its own: the 10 MB limit of the file applies. |

### Face object

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `shape` | integer | yes | 0 to 5. The drawn character. |
| `hue` | integer | yes | 0 to 9. The colour. |

A picture that a user uploaded as a face is not in the file.

### Routine object

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `name` | string | yes | 1 to 60 characters after ROBot removes spaces at both ends. |
| `prompt` | string | yes | 1 to 20 000 characters. ROBot does not remove spaces. The agent gets this text at each run. |
| `schedule` | schedule object | yes | See below. |

The file has no field for the place of a routine. A routine from a file always posts in the chat
of its agent.

### Schedule object

The field `kind` selects the form. All times use the time zone of the computer that runs the
routine. Other fields of the object are ignored.

| `kind` | Other fields | Meaning |
| --- | --- | --- |
| `"once"` | `at`: number | One run at the instant `at`. `at` is in milliseconds since 1970-01-01 00:00 UTC. |
| `"every"` | `minutes`: integer, 1 or more. `from`: number | A run at the instant `from`, and then every `minutes` minutes. `from` is in milliseconds since 1970-01-01 00:00 UTC. |
| `"daily"` | `times`: array of strings, at least one | A run each day at each time. A time is `"H:MM"` or `"HH:MM"` on a 24-hour clock, for example `"08:30"`. |
| `"weekly"` | `days`: array of integers from 0 to 6, at least one. `time`: string | A run on each of the days, at `time`. 0 is Sunday and 6 is Saturday. `time` has the same form as in `"daily"`. |
| `"cron"` | `expr`: string | A run when the expression matches. The expression has five fields that a space separates: minute (0-59), hour (0-23), day of month (1-31), month (1-12), day of week (0-6, and 7 is Sunday). Each field takes `*`, a number, a list (`1,15`), a range (`1-5`) and a step (`*/10`, `0-30/5`). Names such as `MON` are not allowed. When both day fields are not `*`, a day that matches one of them runs. |

A schedule that does not follow this table makes ROBot refuse the whole file.

## What the file does not hold

The file has no field for these. If a tool writes one, ROBot ignores it. ROBot ignores every field
that this document does not define.

- **Model.** The user picks one model for all imported agents when they import the file.
- **Workspace folder.** ROBot makes a new, empty folder for each new agent.
- **Permission level.** A new agent gets the default level, as an agent that the user makes by hand.
- **Keys and secrets.**
- **Chat history and memory.**

So an import cannot give an agent more rights than the user gives it by hand.

## Secrets in text

ROBot replaces text that looks like a secret with `[redacted]`. It does this when it writes a file,
and again when it reads one. This applies to the name, the role line, the instructions, and the
name and prompt of each routine. It applies to:

- keys that start with `sk-`
- `Bearer` tokens
- GitHub tokens
- AWS access key IDs
- Slack tokens
- Google API keys
- JSON web tokens
- private key blocks
- every key that is stored in the app on that computer

A tool must not write secrets into an agent file.

## How ROBot imports a file

1. ROBot checks the size, then the whole file. If one value is not valid, ROBot refuses the whole
   file and makes no agent.
2. The user sees the review screen (spec 014, "Review before an import"): each agent, its
   instructions and its routines, with tick boxes. Routines start not ticked. The user picks one
   model for all of them, and confirms.
3. ROBot makes the agents in the order of the file. It makes new agents only. It never changes an
   agent that exists.
4. If the name of an agent is taken on the server, the agent gets a number: `Ada` becomes `Ada 2`,
   then `Ada 3`. ROBot ignores case when it compares names, and it counts archived agents. The name
   stays inside 40 characters: ROBot cuts the end of the name to make room for the number.
5. Every routine starts paused. The user turns it on.
6. If a step fails after some agents are made, those agents stay. ROBot shows the name of the agent
   where it stopped, and the reason.

## When ROBot refuses a file

| Cause | Note |
| --- | --- |
| The text is not JSON, or `format` is not `"robot-agents"`. | |
| `version` is not an integer of 1 or more. | |
| `version` is higher than 1. | The file comes from a newer format. |
| `agents` is not an array, or it is empty. | |
| `agents` has more than 40 entries. | |
| The file is larger than 10 MB. | |
| Two agents have the same name. | ROBot removes spaces at both ends and ignores case when it compares. |
| A value has the wrong type or is outside its limit. | The message names the place, for example `agents[1].name`. |
| A schedule is not valid. | The message names the place, for example `agents[0].routines[2].schedule`. |

## Example

```json
{
  "format": "robot-agents",
  "version": 1,
  "agents": [
    {
      "name": "Ada",
      "role": "Researcher",
      "instructions": "Find sources. Give short answers.",
      "face": { "shape": 2, "hue": 7 },
      "routines": [
        {
          "name": "Morning digest",
          "prompt": "Summarise the news about my topics.",
          "schedule": { "kind": "daily", "times": ["08:30"] }
        }
      ]
    },
    {
      "name": "Bob",
      "role": "Code reviewer",
      "instructions": "Review changes. Name the risk first."
    }
  ]
}
```
