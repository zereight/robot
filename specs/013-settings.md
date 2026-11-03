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
- **Appearance**: theme (dark, light, system), text size (small, default, large), compact place
  list on/off, reduce motion (follow the system by default).
- **Providers**: see 006.
- **Decision model**: the fast model for channel picks, computer use and permission checks. See
  "Decision model".
- **Token savings**: three switches that cut repeated work in long runs, off at first. See 026.
- **Handbook**: one text that every agent reads. See 002, "Handbook".
- **Roles**: the role lines of all agents. See "Roles".
- **Permissions**: the rules that allow or deny steps, the action log (see 007), the saved
  secrets, and the switch "Allow saved secrets on this computer and the local network" (see
  020).
- **Skills**: the saved instructions that the user calls with a slash. See 017.
- **Connections**: the outside tools that agents can use. See 018.
- **Outside programs**: programs on this computer that may read and send work in ROBot. See 023.
- **Devices**: this device's name, the "Let other devices connect" switch, pairing, the devices
  that can open this computer, with the switch "Can create and change agents" for each, and the
  computers this computer can open, see 012. Each linked computer has a sync row, see 019.
- **Notifications**: see 015.
- **Archive**: archived agents and channels with restore and delete.
- **Profiles**: add, rename, change the face of and delete profiles, see 022.
- **Data**: open data folder, open logs folder, export, see 014.
- **About**: version, licenses of dependencies.

## Decision model

A decision model is a small model that answers fast, with a probability for each option. It makes
small choices for the app. It is off by default. When it is off, nothing is sent to it.

- The user picks one of five choices: "Lead's model" (off, the default), Jev from TypeSafe,
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
    unsure, so the lead decides then.
- Each service takes its request in the form of its public API document. The services are
  `api.typesafe.ai`, `openrouter.ai` and `api.cloudflare.com`. They keep requests under their own
  terms. The app does not store the answers.
- Keys are stored in the system keychain (see 014). The settings page only learns whether a
  key is saved. A save names the keys it changes: a key that is not named stays, and the user can
  remove a key. A key that this computer cannot read counts as no key.
- A choice that lacks its key, account or model asks nobody. The lead's model decides, as if the
  choice were off.
- "Test" sends one real request with three made-up members to the saved choice. It shows who was
  chosen and the time taken, or the reason: wrong key (an error code from the service), timeout,
  network error, unsure answer, or not set up.
- A switch for the fast path of computer use (see 007) is off by default. Its text says that
  the names of the controls of a window go to the service above. The same section shows from the
  computer use page, so the user can turn it on where the user gives the system permission.
- Channel picks use this model (see 004, "Fast pick").
- A switch "Permission checks" is off by default. With it on, agents at the level "Ask when
  unsure" ask this model before a checked step (see 007, "Ask when unsure"). Its text says that the
  words of the user in a turn, and the command text, the host or the name of a tool, go to the
  service above. A choice that is not set up cannot turn the switch on.

## Roles

- The page lists each role line that an agent has, with the faces and names of the agents that
  have it. Lines that differ only in case are one role. The first spelling found is shown. The
  list is in alphabetical order.
- The user can rename a role. The new name goes to every agent of that role. If the new name is
  the name of another role, the two roles join into one.
- The user can remove a role after a confirm. Its agents keep their names, chats and files, and
  have an empty role line.
- A role exists while an agent has it. The user makes a new role in the profile of an agent
  (see 002).

## Archive

- The page lists archived agents and archived channels, each with "Restore" and "Delete". The
  text says "archived" for both.

## Logs

- The Data section has a row "Logs" that shows the path of the logs folder and opens it.

## Rules

- Every visible string comes from a translation catalogue with English and Korean. Korean uses
  polite informal speech.
- Changes apply at once, without a restart.
- Settings belong to the open profile (022) and are local to the computer. The section Profiles
  and the setting "start at login" are for the computer. A linked device never changes them.

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
- Turn off "Compact long chats automatically": a chat that is at 90 percent use, or at 400000
  tokens, starts its next turn with no compact. Turn it on: the next turn compacts first.
- Set "Agents working at once" to 1: tasks of two agents run one after the other. Set it to 9 or 0:
  the field refuses the value and keeps the old one.
- Two agents have the role lines "Designer" and "designer": the Roles page shows one role with
  two agents. Rename it to the role line of a third agent: all three agents have one role.
- Remove a role: its agents have an empty role line and keep their chats.
- The settings list shows Permissions, Skills and Connections. Each opens its own page.
