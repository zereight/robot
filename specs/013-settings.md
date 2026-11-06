# 013 Settings, themes and languages

## Purpose

The user sets the app up the way they like in one place.

## Sections

- **General**: language (English, Korean, or follow the system), start at login, default folder
  for agent workspaces, the step limit of a task (a whole number from 20 to 2000; the default is
  300; see 005), "While an agent works, new messages" (see 003, "Messages during a turn"), and the
  silent limit: how long a turn may show no sign of life before the app stops it (see 005). The
  choices are 1, 5, 10 (default), 30 and 60 minutes, and Never.
  Two more settings are here. "Compact long chats automatically" is on or off; the default is on
  (see 003, "Automatic compact"). "Agents working at once" is a whole number from 1 to 8; the
  default is 4 (see 005, "Queue"). Both belong to the open profile and are local to the computer,
  as the other settings.
  More settings are here. "Keep going on open steps" is on or off; the default is on (see 005,
  "Keep going"). "Dictation language" and "Reading speed" are in 027. "Show in the menu bar" is
  on or off; the default is off (see 015, "Menu bar item").
- **Appearance**: theme (dark, light, system), text size (small, default, large), compact place
  list on/off, reduce motion (follow the system by default), "Show tool steps" (on or off;
  the default is on), which folds each run of finished plain tool steps into one muted line with
  the count when off (see 003, "Folded tool steps").
- **Test devices**: the switch "Test devices", off by default. When it is on, the section shows the
  state of the download, of the server and of each tool that a test device needs, the version, the
  size, the source, "Download", "Delete", "Check for a new version" and "Update", and "Delete all
  measurements, screen maps and performance files", which asks first (see 032 to 034). One muted
  line says that the program is from another vendor, that it runs with the rights of the user, and
  what its panel does not do (032, "Rules").
- **Providers**: see 006.
- **Decision model**: the fast model for computer use and permission checks. See "Decision
  model".
- **Token savings**: three switches that cut repeated work in long runs, off at first. See 026.
- **Handbook**: one text that every agent reads. See 002, "Handbook".
- **Roles**: the role lines of all agents. See "Roles".
- **Permissions**: the rules that allow or deny steps, the action log (see 007), the saved
  secrets, and the switch "Allow saved secrets on this computer and the local network" (see
  020).
- **Skills**: the saved instructions that the user calls with a slash. See 017.
- **Connections**: the outside tools that agents can use. See 018. A built-in connection has no row
  here; its feature holds its page and its switch.
- **Outside programs**: programs on this computer that may read and send work in ROBot. See 023.
- **Chase interval**: how long work that an agent gave may stay quiet before the giver asks for its
  state: Off, 5, 10, 15, 30 or 60 minutes. The first value is 15 minutes. It applies to "send
  message" (007). It is local to this computer, as the silent limit is (019).
- **Teams**: the link to one Microsoft Teams chat, off at first. See 028.
- **Setup actions**: the agents of this computer, the setup list of the picked agent, and its
  allow. See 035. It shows on the computer only.
- **Devices**: this device's name, the "Let other devices connect" switch, pairing, the devices
  that can open this computer, with the switch "Can create and change agents" for each, and the
  computers this computer can open, see 012. Each linked computer has a sync row, see 019.
- **Notifications**: see 015.
- **Archive**: archived agents with restore and delete.
- **Profiles**: add, rename, change the face of and delete profiles, see 022.
- **Data**: open data folder, open logs folder, export, see 014.
- **About**: version, licenses of dependencies.

## Decision model

A decision model is a small model that answers fast, with a probability for each option. It makes
small choices for the app. It is off by default. When it is off, nothing is sent to it.

- The user picks one of five choices: "Off" (the default), Jev from TypeSafe,
  Jev through OpenRouter, Clef on Cloudflare Workers AI, and "Local server".
- What each choice asks for:
  - Jev from TypeSafe: an API key.
  - Jev through OpenRouter: an API key and a model name. The model name starts with a default.
  - Clef on Cloudflare Workers AI: the account ID (32 characters from 0 to 9 and a to f), an API
    token, and a model, "Clef" or "Clef Flash". The default is "Clef Flash".
  - Local server: an address and a model name. An access key is optional. The default address is
    `http://127.0.0.1:8000`. The app accepts only an address on this computer: the protocol
    must be http, the host must be `127.0.0.1`, `localhost` or `::1`, and the address has no
    sign-in part, path or query. Any other address is refused with a message that says only
    an address on this computer works. The settings text tells how to install and start such a
    server. The text says the choice is experimental, and that a small free model is often
    unsure, so a step that needs a decision asks the user, as with the choice off.
- Each service takes its request in the form of its public API document. The services are
  `api.typesafe.ai`, `openrouter.ai` and `api.cloudflare.com`. They keep requests under their own
  terms. The app does not store the answers.
- Keys are stored in the system keychain (see 014). The settings page only learns whether a
  key is saved. A save names the keys it changes: a key that is not named stays, and the user can
  remove a key. A key that this computer cannot read counts as no key.
- A choice that lacks its key, account or model asks nobody. The app acts as if the choice were
  off.
- "Test" sends one real request with three made-up options to the saved choice. It shows which
  option was chosen and the time taken, or the reason: wrong key (an error code from the service),
  timeout, network error, unsure answer, or not set up.
- A switch for the fast path of computer use (see 007) is off by default. Its text says that
  the names of the controls of a window go to the service above. The same section shows from the
  computer use page, so the user can turn it on where the user gives the system permission.
- A switch "Permission checks" is off by default. With it on, agents at the level "Ask when
  unsure" ask this model before a checked step (see 007, "Ask when unsure"). Its text says that the
  words of the user in a turn, and the command text, the host or the name of a tool, go to the
  service above. A choice that is not set up cannot turn the switch on.

## Roles

- The page lists each role line that an agent has, with the faces and names of the agents that
  have it. Lines that differ only in case are one role. The first spelling found is shown. The
  list is in alphabetical order.
- Each role has a box "Role instructions" of up to 5000 characters (002, "Role instructions"). It
  is empty at first. A save refuses text that looks like a secret, with the reason. The page says
  that the text goes to the model provider of each agent of that role.
- The user can rename a role. The new name goes to every agent of that role, and the role keeps its
  text. If the new name is the name of another role, the two roles join into one. The text of the
  role that keeps the name stays first, then a blank line, then the other text. When the joined
  text is longer than 5000 characters, the rename is refused with the reason.
- The user can remove a role after a confirm. The confirm says that its role instructions are
  deleted. Its agents keep their names, chats and files, and have an empty role line.
- A role exists while an agent that is not archived has it. The user makes a new role in the
  profile of an agent (see 002, "Role label"). The list of that field shows the roles of this page.
- Archived agents are not in the list, and a rename or a remove does not change them. An archived
  agent keeps its role line, and a restore brings it back.

## Archive

- The page lists archived agents, each with "Restore" and "Delete". The text says "archived".

## Logs

- The Data section has a row "Logs" that shows the path of the logs folder and opens it.

## Rules

- Every visible string comes from a translation catalogue with English and Korean. Korean uses
  polite informal speech. A text that holds a number, a name or a time, for example "Kept going
  (1 of 8)", "Trying again (1 of 3)" or "Backup until <time>", is one text with parameters, so
  Korean can set the order of the words.
- Changes apply at once, without a restart.
- Settings belong to the open profile (022) and are local to the computer. The section Profiles
  and the settings "start at login" and "Show in the menu bar" are for the computer. A linked device never changes them.
  The section Teams is shown on the computer only (028).

## Acceptance

- Switch to Korean: every screen shows Korean with no English left except names, code, and common acronyms (API,
  URL, VPN).
- Switch theme: all screens change, with text contrast of at least 4.5:1 in both themes.
- Choose "Local server" and type `http://example.com`: the app refuses the address. Type
  `http://127.0.0.1:8000`: the app accepts it.
- Save a key for the decision model, reload the settings page: the page shows "saved" and not
  the key.
- Change the silent limit to 30 minutes: a turn that starts after the change fails after 30 minutes
  of silence and not after 10. Choose Never: a silent turn does not fail by itself.
- Set "Chase interval" to Off: a quiet send gets no message. Set it to 5 minutes:
  the next quiet one gets its message after 5 minutes.
- Turn off "Compact long chats automatically": a chat that is at 90 percent use, or at 400000
  tokens, starts its next turn with no compact. Turn it on: the next turn compacts first.
- Set "Agents working at once" to 1: tasks of two agents run one after the other. Set it to 9 or 0:
  the field refuses the value and keeps the old one.
- Two agents have the role lines "Designer" and "designer": the Roles page shows one role with
  two agents. Rename it to the role line of a third agent: all three agents have one role.
- Remove a role: its agents have an empty role line and keep their chats.
- Open the role list in the profile of an agent: it lists the same roles as the Roles page. Rename a
  role on the page, then open the list again: it shows the new name. Archive the only agent of a
  role: the role leaves both lists.
- The settings list shows Permissions, Skills and Connections. Each opens its own page.
- Turn off "Keep going on open steps": a stand-in runtime that ends with open steps ends its task.
  Turn it on: the same turn goes on.
- Turn on "Show in the menu bar": the icon shows. Turn it off: the icon goes.
- Turn off "Show tool steps": a chat with finished steps shows one folded line per run. Turn it
  on: the cards show again.
