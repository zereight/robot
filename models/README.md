# Models

Quint models of the rules in `specs/`. A model is a check tool for developers. It is not part of
the app, and it adds no behaviour. The specs stay the source.

| Model | Spec |
| --- | --- |
| `005-tasks.qnt` | [005 Tasks](../specs/005-tasks.md): states, slots, queue, restart, retry |

## Run

    bun run models:check

This runs the type check, the scenario tests, and a random search for a broken rule. It needs
Node. The first run downloads the evaluator of Quint to `~/.quint`.

- `quint test` runs only the runs whose name ends in `Test`. A run with another name is skipped,
  and the command still ends with code 0.
- The random search can miss a rule that breaks only after a long chain of steps. The scenario
  tests cover such chains. Add a scenario when you add a rule.
- `quint verify` checks every path to a bound. It needs Apalache and Java 21. It is not part of
  `models:check`.

## Open points

- 005: a task that waited for the user and is queued again after the answer is a queued task.
  The queue limit may then be exceeded by one. `heldTaskExceedsQueueLimitTest` shows it. The
  spec does not say what happens.
