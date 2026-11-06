# Agent file format

This document tells how to write and read an agent file. A tool can use it to make agent files
for ROBot without the code of the app. The behaviour of export and import is in
[specs/002-agents.md](../specs/002-agents.md).

Format version: **2**. ROBot writes version 2 and reads versions 1 and 2.

| Version | What is new |
| --- | --- |
| 1 | Agents, with their routines. |
| 2 | Optional parts: `skills` and `handbook`. A file of version 2 with none of them reads the same as a file of version 1. Older versions of ROBot also wrote `channels`. ROBot now ignores that part (see "Parts that ROBot does not read now"). |

## What the file is

- The file is one JSON object in UTF-8 text. A byte order mark at the start is allowed.
- The file name ends in `.json`.
- The file is at most 10 MB (10 485 760 bytes). ROBot refuses a larger file before it reads it.
- The file holds 1 to 40 agents.
- For each agent, the file holds: name, role line, Soul (in the field `instructions`), face, and
  routines.
- A file of version 2 can also hold up to 100 skills and the handbook. The user picks them with two
  tick boxes when they export (see "Skills and the handbook").
- The file never holds a model, a workspace folder, a permission level, a key, a secret, a chat
  history, a memory, a proposal or a change log. See "What the file does not hold".

## Fields

Text lengths count characters, not bytes. A character with a code point above U+FFFF counts as
one.

### The file object

| Field | Type | Required | Rule |
| --- | --- | --- | --- |
| `format` | string | yes | Must be `"robot-agents"`. |
| `version` | integer | yes | Must be `1` or `2`. ROBot refuses a higher number. |
| `agents` | array of agent objects | yes | 1 to 40 entries. |
| `skills` | array of skill objects | no | Version 2 only. 0 to 100 entries. Default: none. |
| `handbook` | string or `null` | no | Version 2 only. 0 to 20 000 characters. Default: none. |

In a file of version 1, the fields `skills` and `handbook` are not defined, so ROBot ignores them
and lists them on the review screen under "Not imported".

### Agent object

| Field | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `name` | string | yes | | 1 to 40 characters after ROBot removes spaces at both ends. |
| `role` | string | no | `""` | The role line. At most 120 characters after ROBot removes spaces at both ends. |
| `instructions` | string | no | `""` | The Soul of the agent: the text that says who the agent is, and that it follows in every turn (002, "Soul"). The field keeps the name `instructions`, so a file of version 1 or 2 that ROBot wrote before the word "Soul" reads the same. No limit of its own: the 10 MB limit of the file applies. Line breaks are allowed. |
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

### Skill object (version 2)

| Field | Type | Required | Default | Rule |
| --- | --- | --- | --- | --- |
| `name` | string | yes | | 1 to 40 characters after ROBot removes spaces at both ends and a slash at the start. |
| `description` | string | no | `""` | At most 140 characters after ROBot removes spaces at both ends. |
| `instructions` | string | yes | | 1 to 20 000 characters, not only spaces. |
| `agents` | array of strings | yes | | The names of the agents of the file that may use the skill. At least one. Every name must be the name of an agent of the file. |

A skill that every agent may use has no special form in the file: ROBot writes the names of the
agents of the file. The file never says "all agents", so an import cannot give a skill to an agent
that is not in the file. The file may not hold two skills of one name (ROBot ignores case, spaces
at both ends and a slash at the start when it compares). A skill is not marked on or off: an
imported skill is always off.

## Skills and the handbook

The export dialog has two tick boxes. Both are off at the start.

| Tick box | What the file holds |
| --- | --- |
| Skills of these agents | Each skill that at least one picked agent may use, on or off, also a skill for all agents. A skill is written with the picked agents that may use it. |
| Handbook | The text of the handbook of the server. A handbook that is empty is not written. |

A part that the user did not tick is not in the file: ROBot writes no `skills` or `handbook` field
for it.

If an export would hold more than 100 skills, ROBot writes no file and tells the user why.

## Parts that ROBot does not read now

Older versions of ROBot wrote a field `channels` in a file of version 2. ROBot now has no channels.
It reads such a file, does not check the field `channels`, makes no channel, and lists the
channels on the review screen under "Not imported". The rest of the file imports as usual.

## What the file does not hold

The file has no field for these. If a tool writes one, ROBot ignores it. ROBot ignores every field
that this document does not define.

- **Model.** The user picks one model for all imported agents when they import the file.
- **Workspace folder.** ROBot makes a new, empty folder for each new agent.
- **Permission level.** A new agent gets the default level, as an agent that the user makes by hand.
- **Keys and secrets.**
- **Chat history and memory.**
- **Proposals and the change log** of self-improvement (002). An imported agent starts with none.
- **The Soul history.**
- **Whether a skill is on.** An imported skill is off.

So an import cannot give an agent more rights than the user gives it by hand.

## Secrets in text

ROBot replaces text that looks like a secret with `[redacted]`. It does this when it writes a file,
and again when it reads one. This applies to the name, the role line, the Soul (`instructions`),
and the name and prompt of each routine. In a file of version 2 it also applies to the name,
description and instructions of each skill, and the handbook. It applies to:

- keys that start with `sk-`
- `Bearer` tokens
- GitHub tokens
- AWS access key IDs
- Slack tokens
- Google API keys
- JSON web tokens
- private key blocks
- every key that is stored in the app on that computer, also the key of the decision model, the
  values of saved secrets and the secret values of connections

A tool must not write secrets into an agent file.

## How ROBot imports a file

1. ROBot checks the size, then the whole file. If one value is not valid, ROBot refuses the whole
   file and makes nothing.
2. The user sees the review screen (spec 014, "Review before an import"): each agent, its
   Soul and its routines, with tick boxes. Routines start not ticked. For a file of version 2 the
   screen lists the skills and the handbook after the agents, each with a tick box. Skills start
   ticked, and the handbook starts not ticked. A part where ROBot
   hid a secret starts not ticked. The user picks one model for all the agents, and confirms.
3. ROBot makes the agents in the order of the file. It makes new agents only. It never changes an
   agent that exists.
4. If the name of an agent is taken on the server, the agent gets a number: `Ada` becomes `Ada 2`,
   then `Ada 3`. ROBot ignores case when it compares names, and it counts archived agents. The name
   stays inside 40 characters: ROBot cuts the end of the name to make room for the number.
5. Every routine starts paused. The user turns it on.
6. ROBot makes the skills that are ticked, in the order of the file. A skill is made for the
   agents of the file that were made. A skill with no such agent is not made. A name that is taken
   gets a number, inside 40 characters. Every skill starts off. A skill past the limit of 100
   skills of the server is not made, and the skills before it are.
7. If the handbook is ticked, it replaces the handbook of the server. The old text stays in the
   history of the handbook.
8. The review screen lists under "Not imported" what the file holds and ROBot does not make: a
   field that this version does not know, the channels of an older file, a skill that has no agent
   left, and a skill past the limit.
9. If a step fails after some parts are made, those parts stay. ROBot shows the name of the part
   where it stopped (an agent, a skill or the handbook), and the reason.

## When ROBot refuses a file

| Cause | Note |
| --- | --- |
| The text is not JSON, or `format` is not `"robot-agents"`. | |
| `version` is not an integer of 1 or more. | |
| `version` is higher than 2. | The file comes from a newer format. |
| `agents` is not an array, or it is empty. | |
| `agents` has more than 40 entries. | |
| The file is larger than 10 MB. | |
| Two agents have the same name. | ROBot removes spaces at both ends and ignores case when it compares. |
| `skills` has more than 100 entries. | |
| Two skills have the same name. | |
| A skill agent is not the name of an agent of the file. | The message names the place, for example `skills[0].agents[1]`. |
| A value has the wrong type or is outside its limit. | The message names the place, for example `agents[1].name`. |
| A schedule is not valid. | The message names the place, for example `agents[0].routines[2].schedule`. |

## Example

```json
{
  "format": "robot-agents",
  "version": 2,
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
  ],
  "skills": [
    {
      "name": "Summarise",
      "description": "A short summary",
      "instructions": "Summarise the text in five lines.",
      "agents": ["Ada", "Bob"]
    }
  ],
  "handbook": "We write in short, plain sentences."
}
```
