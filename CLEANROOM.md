# Clean-room rules

ROBot must contain no code, text, assets or structure taken from OpenBot or OpenOwnBot
(`zereight/openownbot` and its upstream). These rules make that
provable.

## Two roles

| Role | May read the old code | Writes |
| --- | --- | --- |
| Spec author | Yes | Behaviour specs in `specs/` only |
| Implementer | **No, never** | Code, tests, styles, assets, strings |

One person or agent holds one role. An agent that has read the old code is a spec author for the
life of this project. An implementer session starts with no access to the old repositories, the old
app bundle, or old data, and must not search for them.

## What a spec may contain

- What the user sees and does: screens, flows, states, empty and error cases.
- Data the user owns, described as concepts and fields, not as tables or types.
- Rules: limits, ordering, permissions, what is stored where.
- Wire behaviour between desktop and phone, described as messages and their meaning.

## What a spec must not contain

- Code, pseudo-code that mirrors old code, file names, module names, function or type names,
  CSS class names, token names, database table or column names, IPC channel names.
- Text copied from the old app: interface strings, prompts, comments, docs.
- Screenshots or assets of the old app. Describe the layout in words instead.

A reviewer checks each spec against this list before an implementer receives it.

## Implementation rules

- Write every file from the spec and public documentation only.
- Dependencies come from public registries under licenses that allow use.
- Make new assets: icons from a public icon set, new avatars, new logo.
- Write all interface text anew, in English and Korean.

## Provenance

Every pull request states its role and confirms the rules. See
[docs/provenance.md](docs/provenance.md).
