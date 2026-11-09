# 013 Settings, themes and languages

## Purpose

The user sets the app up the way they like in one place.

## Sections

- **General**: language (English, Korean, or follow the system), start at login, the default
  workspace folder, the step limit of a task (a whole number from 20 to 2000; the default is 300;
  see 005), "While a reply is written, new messages" (see 003, "Messages during a turn"), and the
  silent limit: how long a turn may show no sign of life before the app stops it (see 005). The
  choices are 1, 5, 10 (default), 30 and 60 minutes, and Never. A text node can have its own
  silent limit in place of this one (010).
  - The default workspace folder is the folder in which a new workflow gets its own empty folder
    (007, 010). A change counts for new workflows only. A workflow that exists keeps its folder.
  - Two more settings are here. "Compact long chats automatically" is on or off; the default is on
    (see 003, "Automatic compact"). "Tasks at once" is a whole number from 1 to 8; the default is
    4 (see 005, "Queue"). Both belong to the open profile and are local to the computer, as the
    other settings.
  - More settings are here. "Keep going on open steps" is on or off; the default is on (see 005,
    "Keep going"). "Dictation language" and "Reading speed" are in 027. "Show in the menu bar" is
    on or off; the default is off (see 015, "Menu bar item").
- **Appearance**: theme (dark, light, system), text size (small, default, large), reduce motion
  (follow the system by default), and "Show tool steps" (on or off; the default is on). With it off,
  the chat folds each run of finished plain tool steps into one muted line with the count (see 003,
  "Folded tool steps").
- **Test devices**: the switch "Test devices", off by default. When it is on, the section shows the
  state of the download, of the server and of each tool that a test device needs, the version, the
  size, the source, "Download", "Delete", "Check for a new version" and "Update", and "Delete all
  measurements, screen maps and performance files", which asks first (see 032 to 034). One muted
  line says that the program is from another vendor, that it runs with the rights of the user, and
  what its panel does not do (032, "Rules"). One more line says that the analysis of a performance
  file needs a program that the user installs (034).
- **Providers**: see 006.
- **Decision model**: the fast model for decision nodes, computer use and permission checks. See
  "Decision model".
- **Token savings**: three switches that cut repeated work in long runs, off at first. See 026.
- **Permissions**: the rules that allow or deny steps, the action log (see 007), the overview of
  the secrets vaults of the workflows (see 020), and the switch "Allow saved secrets on this
  computer and the local network" (see 020).
- **Skills**: the saved instructions that the user calls with a slash, and that a node prompt can
  include. See 017.
- **Connections**: the outside tools that text nodes can use. See 018. A built-in connection has no
  row here; its feature holds its page and its switch.
- **Outside programs**: programs on this computer that may read and send work in ROBot. See 023.
- **Browser**: the browser profiles of this computer. See 007 and 028. Its content is open; see
  the rows on browser profiles in docs/spec-questions.md.
- **Teams**: the link to one Microsoft Teams chat, off at first. See 028.
- **Setup actions**: the workflows of this computer, the setup list of the picked workflow, and its
  allow. See 035. It shows on the computer only.
- **Devices**: this device's name, the "Let other devices connect" switch, pairing, the devices
  that can open this computer, with the switch "Can create and change workflows" for each, and the
  computers this computer can open, see 012. Each linked computer has a sync row, see 019.
- **Notifications**: see 015.
- **Profiles**: add, rename, change the face of and delete profiles, see 022.
- **Data**: open data folder, open logs folder, export, see 014.
- **About**: version, licenses of dependencies.

## What is not a setting

These choices belong to one workflow. They are in the workflow view and on the pages of the
workflow, not here:

- the folder and the permission level of the workflow, and the stricter level of a node (007, 010);
- the switch "Self-improvement" (002);
- "Memory saving", "Memory check" and the switch for memory (008);
- the trigger (010).

Settings has no default permission level. A new workflow gets "Ask for risky steps" (010). Only the
user changes these choices (007, 010). The responsible document and a manage tool (037) cannot
change a setting (002).

## Decision model

A decision model is a small model that answers fast, with a probability for each option. It makes
small choices for the app. It is off by default. When it is off, nothing is sent to it.

- **Who uses it**: a decision node (010), the fast path of computer use (007), and the permission
  checks (007, "Ask when unsure"). A decision node takes its model from this section, and it has no
  other model.
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
    unsure, so a decision node asks the user to pick an option (010), as with the choice off.
- Each service takes its request in the form of its public API document. The services are
  `api.typesafe.ai`, `openrouter.ai` and `api.cloudflare.com`. They keep requests under their own
  terms. The app does not store the answers.
- The settings text says that the words of the input of a decision node go to the service of the
  choice (010).
- Keys are in the secrets file (see 014). The settings page only learns whether a key is
  saved. A save names the keys it changes. A key that is not named stays, and the user can
  remove a key. A missing secrets key counts as no key (see 014). When Locked or Damaged,
  the page shows "Cannot read the vault." with Retry, and a save is refused. Removing a key
  follows 014.
- A choice that lacks its key, account or model asks nobody. The app acts as if the choice were
  off: a decision node asks the user to pick an option (010). When Locked or Damaged, the
  choice cannot run, so a decision node asks the user to pick an option (010) with "Cannot
  read the vault." on the card, and the permission check "Ask when unsure" asks the user in
  the same way.
- "Test" sends one real request with three made-up options to the saved choice. It shows which
  option was chosen and the time taken, or the reason: wrong key (an error code from the service),
  timeout, network error, unsure answer, or not set up.
- A switch for the fast path of computer use (see 007) is off by default. Its text says that
  the names of the controls of a window go to the service above. The same section shows from the
  computer use page, so the user can turn it on where the user gives the system permission.
- A switch "Permission checks" is off by default. With it on, a workflow or a node at the level
  "Ask when unsure" asks this model before a checked step (see 007, "Ask when unsure"). Its text
  says that the words of the user in a turn, and the command text, the host or the name of a tool,
  go to the service above. A choice that is not set up cannot turn the switch on.

## Logs

- The Data section has a row "Logs" that shows the path of the logs folder and opens it.

## Rules

- Every visible string comes from a translation catalogue with English and Korean. Korean uses
  polite informal speech. A text that holds a number, a name or a time, for example "Kept going
  (1 of 8)" or "Trying again (1 of 3)", is one text with parameters, so Korean can set the order of
  the words.
- Changes apply at once, without a restart.
- Settings belong to the open profile (022) and are local to the computer. The section Profiles
  and the settings "start at login" and "Show in the menu bar" are for the computer. A linked
  device never changes them. The section Teams is shown on the computer only (028).

## Out of scope

- A default permission level for new workflows (010).
- A page for archived workflows. See docs/spec-questions.md, rows for 013.

## Acceptance

- Switch to Korean: every screen shows Korean with no English left except names, code, and common acronyms (API,
  URL, VPN).
- Switch theme: all screens change, with text contrast of at least 4.5:1 in both themes.
- Choose "Local server" and type `http://example.com`: the app refuses the address. Type
  `http://127.0.0.1:8000`: the app accepts it.
- Save a key for the decision model, reload the settings page: the page shows "saved" and not
  the key.
- With the secrets key locked, the decision model page shows "Cannot read the vault." with
  Retry. A save of a key is refused with that reason.
- With the secrets key locked, start a run with a decision node. The node asks the user to pick
  an option, and the card says "Cannot read the vault."
- Delete the secrets key and keep the secrets file. Start the app. The decision model key shows
  its normal "no key" state. Start a run with a decision node. The node asks the user to pick
  an option, and no request goes to any service.
- Set the decision model to "Off" and start a run with a decision node: the node asks the user to
  pick an option, and no request goes to any service.
- Change the default workspace folder, then make a new workflow: its empty folder is in the new
  folder. A workflow that exists keeps its folder.
- Open Settings: no field for a default permission level, for "Self-improvement" or for memory
  shows. Each is on the workflow.
- Change the silent limit to 30 minutes: a turn that starts after the change fails after 30 minutes
  of silence and not after 10. Choose Never: a silent turn does not fail by itself.
- Turn off "Compact long chats automatically": a chat that is at 90 percent use, or at 400000
  tokens, starts its next turn with no compact. Turn it on: the next turn compacts first.
- Set "Tasks at once" to 1: tasks of two workflows run one after the other. Set it to 9 or 0: the
  field refuses the value and keeps the old one.
- The settings list shows Permissions, Skills and Connections. Each opens its own page.
- Turn off "Keep going on open steps": a stand-in runtime that ends with open steps ends its task.
  Turn it on: the same turn goes on.
- Turn on "Show in the menu bar": the icon shows. Turn it off: the icon goes.
- Turn off "Show tool steps": a chat with finished steps shows one folded line per run. Turn it
  on: the cards show again.
