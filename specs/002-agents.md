# 002 Agents

## Purpose

The user makes agents, gives each one a clear identity and job, and changes them later without
losing their history.

## Concepts

An agent has:

- **Name**: 1 to 40 characters, unique on its server.
- **Face**: a generated round character with a hue and a shape. The user can pick another
  shape and one of ten hues, or upload an image.
- **Role line**: up to 120 characters, shown under the name in profiles.
- **Instructions**: free text that the agent always follows.
- **Model**: the provider and model it uses (see 006), and an effort level when the model has one.
- **Workspace**: a folder on the computer that belongs to this agent (see 007).
- **Section**: the place list section it shows in.
- **State**: idle, working, waiting for the user, or offline (its provider is not connected).

## Flows

1. Create: the user clicks "New agent", types a name, optionally a role and instructions, and
   picks a model. The app creates the workspace folder and opens the direct chat.
2. Create from a template: the user picks one of a few starter agents (for example a general
   assistant, a code reviewer, a researcher). The fields are filled in and can be changed.
3. Edit: the user opens the agent profile and changes any field. Changes apply to the next turn.
4. Duplicate: makes a new agent with the same fields and a new, empty workspace and history.
   The name gets " copy" added, then a number if needed.
5. Archive: the agent leaves the place list. Its history and workspace stay. The user can restore
   it from settings.
6. Delete: only from the archive. The app asks to confirm and says the workspace folder will be
   moved to the system trash. If this computer syncs (016), the text also says that the agent
   is deleted on the other computer. There, the workspace folder stays where it is.

## Rules

- Changing the model keeps the agent's history, memory and workspace.
- A working agent cannot be deleted; the user must stop it first.
- The face is the same everywhere: list, messages, activity panel, phone.

## Acceptance

- Create an agent, change its model, restart the app: the history is intact and the next reply
  uses the new model.
- Duplicate gives "Name copy", then "Name copy 2".
