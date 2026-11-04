# Token savings: what is known

This note backs spec 026. It lists what the author found out about the programs that ROBot runs,
and how sure each fact is. It is not a spec. It was written on 2026-11-03 from public sources and
from one test run. Programs change fast, so check a fact again before a slice relies on it.

How sure a fact is:

- **Read**: the author read the public documentation or the public source.
- **Tested**: the author ran it and saw it.
- **Name only**: a name was found in the program file. Nobody tested what it does.

## Why the three savings work

A model keeps no memory. Each request sends the whole conversation again: instructions, tool
definitions, every earlier message and every tool result. The cost of a run is about the number of
requests times the size of each request. So a saving must make a request smaller or remove a
request. A saving that the app cannot reach inside the loop of a program cannot do either.

The three savings of 026 come from the public MIT project `NVlabs/SoL-Pi`, an add-on for pi (read).
Its authors report 45 to 49 percent fewer tokens than plain pi and about 94 percent of the score of
plain pi, on tasks that run for hours. Nobody checked these numbers for ROBot. The project also
says the gain is small on short tasks.

## What each program lets the app change

| Program | What the app can reach | How sure |
| --- | --- | --- |
| Agent on an API account | Everything: the app runs the loop and the tools. | Read (the app's own code) |
| pi | Add-ons load at start. An add-on can change the tools and what the model reads. | Read, tested (installed and loaded) |
| Claude Code | Permission requests before a step. Settings and environment variables at start. Hooks. | Read |
| Codex (`exec` mode) | Events only, and settings at start. | Read |
| Codex (through its App Server) | Permission requests, input during a turn, a compact command. | Read (adapter documentation) |
| opencode | Settings at start. | Read |

Facts about the programs (version when tested: Claude Code 2.1.316, opencode 2.2.5, Codex 0.31.0):

- Claude Code has hooks. The program file holds the names `updatedToolOutput` and
  `updatedMCPToolOutput` (name only). If a hook can replace the result of a built-in tool, the
  saving "Set big results aside" can reach Claude Code. This is the most useful open question.
- Claude Code has environment variables for the size of a command output, the size of an MCP
  output and the point of its own compact: `BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS`,
  `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `DISABLE_AUTO_COMPACT`
  (name only).
- opencode has a `compaction` setting and a `tool_output` setting (name only).
- The installed Codex 0.31.0 has no setting for tool output size or compact point (name only, a
  newer Codex can differ). The adapter `codex-acp` merges a JSON object into the Codex settings
  (read).
- A pi add-on that the user installed also loads in a run of the app, unless the app turns add-on
  discovery off (read in the code of the app and in the help of pi; not tested). 026 says that the
  app sets the savings, so the app must do this.
- The tool list of a vendor program is a large fixed part of each request (see the test below).

## ACP

ACP (Agent Client Protocol) is a protocol between a client and an agent program. Many programs
speak it, some through an adapter. The adapters for Claude Code (`claude-agent-acp`, Apache-2.0),
Codex (`codex-acp`, Apache-2.0) and pi (`pi-acp`, MIT) are separate packages (read).

What ACP gives (read):

- Events: tool calls, plans, usage of the context (`usage_update`), and compaction
  (`compaction_update`). Permission requests that the client answers.
- Slash commands, sent as an ordinary prompt. So a command such as a compact runs between turns
  only.
- Session settings: model, effort and mode.

What ACP does not give (read):

- A way to change what the model of the program reads. The only methods of this kind are the
  client file and terminal methods of version 1. Programs use them rarely, and the draft of
  version 2 removes them.

Limits of the adapters (read):

- `claude-agent-acp` needs `@anthropic-ai/claude-agent-sdk`, whose package license field reads
  "SEE LICENSE IN README.md". `AGENTS.md` allows MIT-compatible licenses only. A person
  must read the terms before the app depends on it.
- `pi-acp` starts pi without the tool list, the skill switch, the context-file switch and the
  extra system text that the app sets today. The permission levels of the app would get weaker.
  It calls itself an early version.
- All three adapters change often.

## Test run: Claude adapter

Setup: `claude-agent-acp` 0.100.0, a small model, a folder with two text files, a budget cap, no
user settings. The login of the subscription worked with no API key variable. The whole test cost
less than one cent. One or two runs each, so these numbers show what happens, not how often.

| Question | Result | How sure |
| --- | --- | --- |
| Does the context size arrive for each request? | Yes: `usage_update` with `used` and `size`, ten or more times a turn. | Tested |
| Does a total cost arrive? | Yes, on the last `usage_update` of a turn. It looked cumulative. | Tested |
| Do input, output, cache read and cache write tokens arrive for a turn? | Yes, in the result of the prompt. Draft in the protocol. | Tested |
| Can the app see each model request? | Yes, with the opt-in raw messages. They repeat while streaming, so count by message id. | Tested |
| Does a permission request arrive? | Yes. | Tested |
| Do the options of the session pass through? | Yes: model, tool list, setting sources, budget. | Tested |
| Can the app start a compact? | Yes, by sending `/compact`. The compact is reported with its summary text. | Tested |
| Do `plan` events arrive? | No event in two runs. The tool list of this Claude Code version had no to-do tool in the first run. In the second run the model did not use one. | Not settled |

Three results that change how to build the savings:

1. **The tokens of a compact are not in the usage of its turn.** The result of the `/compact` turn
   reported zero tokens. The tokens (about 9,000) were in an extra field of the result. A total
   that adds only the usage of each turn misses them. 026 says the task counts them.
2. **A compact of a short context does not pay.** The context was 5,747 tokens before the compact
   and 1,335 after, but the next request was 6,414 tokens: the fixed part (instructions and tool
   definitions, about 4,800 tokens) is not in the 1,335. The compact also cost a request. So the
   run was no smaller. 026 says a short context is never compacted.
3. **The fixed part of a request can be the largest cost of a short task.** With three tools the
   fixed part was about 4,800 tokens. With the default tool set it was about 18,300. The same kind
   of task used 16,400 tokens in the first case and 77,500 in the second, and cost about three
   times as much. The model behaved a little differently in the two runs, so this is not a clean
   comparison. A smaller tool set means a weaker agent, so 026 does not use it.

## Open questions

- Can a Claude Code hook replace the result of a built-in tool? Test with a hook that shortens a
  large result, and check what the model reads afterwards.
- Do the Claude Code environment variables above change the size of a result or the compact point?
- Do `plan` events arrive from the Claude adapter when the model uses a to-do tool?
- What does the Codex adapter report for usage, compaction and plans? The same test has not been
  run for it.
- What are the terms of `@anthropic-ai/claude-agent-sdk`, and may the app depend on it?
- Does a longer, more realistic run show a saving from "Set big results aside" for an API agent?
  Compare two runs of the same task, with the switch on and off, with the task view (005).
