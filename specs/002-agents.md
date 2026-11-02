# 002 Agents

## Purpose

The user makes agents, gives each one a clear identity and job, and changes them later without
losing their history.

## Concepts

An agent has:

- **Name**: 1 to 40 characters, unique on its server.
- **Face**: a generated round character with a hue and a shape. The user can pick another
  shape and one of ten hues, or upload an image.
- **Role line**: up to 120 characters, shown under the name in profiles. It is the job title of
  the agent. Settings list all role lines (see 013).
- **Instructions**: free text that the agent always follows.
- **Model**: the provider and model it uses (see 006), and an effort level when the model has one.
- **Workspace**: a folder on the computer that belongs to this agent (see 007).
- **Section**: the user section of the Agents list that it shows in, or none. With none, the agent
  shows in the Agents list itself (see 001, "User sections").
- **Main agent**: a switch. At most one agent on a server is the main agent.
- **State**: idle, working, waiting for the user, or offline (its provider is not connected).

## Flows

1. Create: the user clicks "New agent", types a name, optionally a role and instructions, and
   picks a model. A "Section" choice lists the agent sections and "No section". It starts at
   "No section". The app creates the workspace folder and opens the direct chat.
2. Random name: the name box of a new agent starts with a random English first name. A button
   next to the box picks another name. The same button is in the agent profile. The list holds at
   least 80 first names. A pick skips names that agents on the server already use, ignoring case.
   When every name is used, a number follows the name. The names stay English in every
   interface language.
3. Create from a template: the user picks one of a few starter agents (for example a general
   assistant, a code reviewer, a researcher). The fields are filled in and can be changed.
4. Edit: the user opens the agent profile and changes any field, also the section. Changes apply to
   the next turn. A change of section applies at once.
5. Choose a role line: the role box of the profile shows a list of the role lines that other
   agents use. The user picks one or types a new one.
6. Duplicate: makes a new agent with the same fields and a new, empty workspace and history.
   The copy gets a random name (flow 2). It keeps the saved browser session of the original (see
   007), so the sign-ins carry over. It joins the same section as the original.
7. Main agent: the user turns on "Main agent" in the profile. The previous main agent loses the
   flag in the same step. The main agent splits a request and gives the parts to the other
   agents (see 007, "Working with other agents").
8. Archive: the agent leaves the place list. Its history, workspace and section stay. The user can
   restore it from settings. It returns to its section. If the section is gone, it returns with
   no section.
9. Delete: only from the archive. The app asks to confirm and says the workspace folder will be
   moved to the system trash.
10. Export agents: from the menu of the Agents section header, the user picks agents and a file
    name. The app writes one file. Import agents: the user picks such a file. The app lists what
    it will make, asks for one model for all of them (see 006), and asks to confirm.

## Agent file

- The file holds, for each agent: name, role line, instructions, face, and routines (see 009).
  It holds no section, because sections belong to one server. An imported agent has no section.
  It holds no model, no workspace folder, no permission level, no key, no secret, no history and
  no memory. So an import cannot give an agent more rights than the user gave it by hand.
- The file holds at most 40 agents and is at most 10 MB. A file with two agents of one name
  is refused.
- Text in the file that looks like a secret is hidden, as in an export (see 014).
- Import makes new agents only. It never changes an agent that exists. A name that is taken gets
  a number, ignoring case, inside the length limit. Every imported routine starts paused.
- If an import fails, the agents made so far stay. The error says why it stopped.

## Rules

- Changing the model keeps the agent's history, memory and workspace.
- A working agent cannot be deleted; the user must stop it first.
- The face is the same everywhere: list, messages, activity panel, phone.
- Agents made by other ways than the form (an import, a tool of another agent, a template) keep
  the name they were given.

## Acceptance

- Create an agent, change its model, restart the app: the history is intact and the next reply
  uses the new model.
- The new agent form opens with a first name. Press the name button: the name changes.
- Duplicate an agent: the copy has a different random name and the same browser sign-ins.
- Turn on "Main agent" for agent B while agent A has it: only B has it.
- Put an agent in the section "Research" in its profile, then duplicate it: the copy shows in
  "Research" too. Archive and restore the original: it returns to "Research".
- Export two agents, import the file in an empty app: two agents exist, with the model the user
  picked in the dialog and with paused routines.
