# 022 Profiles

## Purpose

One computer can hold more than one separate space of ROBot, for example one for each person in a
family. Each space is a profile. A profile has its own workflows, chats, memory, accounts, settings
and linked devices. A phone that is paired with one profile sees that profile and nothing else.

## Concepts

- **Profile**: a separate space of ROBot on one computer. It has a name (1 to 40 characters,
  unique on this computer, ignoring case) and a face (a shape and a hue, no uploaded image). The
  face shows on the profile button, in the profile menu and in the profile list.
- **Open profile**: the profile that the window shows. A window shows one profile at a time.
- **Server**: one profile on one computer (see 000 and 012). Each profile is a server for its own
  workflows.
- **What a profile holds**: everything that 014 lists as local data: workflows (with their nodes,
  responsible documents, triggers, runs, chats and memory), tasks, proposals of self-improvement,
  knowledge, skills, connections, saved secrets, permission rules, the Teams link and its sign-in
  (028), the action log, usage numbers, settings, model accounts and their keys, browser data of
  workflows, the default workspace folder, linked devices and their keys, and the sync pair.
- **What the computer holds for all profiles**: the list of profiles, which one is open, the
  settings "start at login" and "Show in the menu bar", the programs that the app downloaded for
  vendor runtimes (006), and the permissions that the system gave to the app.

## Flows

### First start and update

1. On a new computer, the first start makes one profile. Its name is the name of the system user.
   The first start guide (000) runs in it.
2. A computer that has data of an earlier version of ROBot does not move that data (000, "Out of
   scope"). The first start works as step 1 says. See docs/spec-questions.md, rows for 022.

### Switch

1. When the computer has two or more profiles, the rail shows the profile button below help and
   settings (001). It shows the face of the open profile.
2. The user clicks it. A menu lists every profile with its face and name. The open profile has a
   check mark. A profile that has a task waiting for the user (005) has a dot.
   The menu ends with "Add profile" and "Manage profiles". The second opens Settings → Profiles.
3. The user picks a profile. The whole window changes at once: the rail, the workflow list, the
   view, the run strip, the pages, the settings and the panel column. The window opens the page
   and the workflow where the user left that profile. If a form has text that is not saved, the
   app asks before it switches.
4. At the next start the app opens the profile that was open when the user quit.

### Add

1. Settings → Profiles → "Add profile", or the same item in the menu of the profile button. A
   dialog asks for a name and a face.
2. Create makes an empty profile and opens it. The first start guide (000) runs in it. The
   language and the theme start from the system.
3. A name that is taken gives a plain error. At 5 profiles the dialog says: "This computer has 5
   profiles. Delete one to add another."

### Rename and change the face

Settings → Profiles lists the profiles. The user picks one and changes its name or its face. The
change shows in the menu at once. A new name does not change the device name (see "What is
apart").

### Delete

1. Settings → Profiles → pick a profile → "Delete profile". The last profile cannot be
   deleted.
2. The confirm says what goes: the workflows, chats, memory, accounts and keys, saved secrets, and
   the links of this profile. It says that every device linked to this profile loses access, that
   a sync of this profile ends and the other computer keeps its copy (019), that everything that
   runs in this profile stops, and that the folders of its workflows stay on the disk. The
   app does not remove or move them. The user types the name of the profile to confirm.
3. After the delete, each linked device is treated as if the user had chosen "Remove access" for
   it (012). Deleting a profile deletes its saved-secrets file and its key. If the open profile
   was deleted, the app opens another profile.

### Pair a phone or a computer

1. The user opens the profile, then Settings → Devices → "Pair a device" (012). The code, the QR
   code, the link and the addresses belong to this profile.
2. The device that joins sees one server: this profile. It sees no other profile.

## States

- **One profile**: the rail has no profile button. Settings → Profiles still lists it and offers
  "Add profile".
- **A profile that is not open**: it keeps working (see "Background work").
- **The app is not running**: no profile is reachable. Every linked device shows its server as
  Offline (012).

## Background work

- A profile that is not open still runs: its workflows finish their runs, their triggers start runs
  at their time (010), devices linked to it reach it, and its sync goes on.
- The computer makes no system notice, no sound and no status island card for a profile that is
  not open. The notices of the open profile follow 015.
- The entry of that profile in the profile menu shows a dot while something waits for the user in
  it. An approval or a question that waits stays waiting until someone answers it, in the window
  or on a linked device.
- A device linked to that profile gets its notices as 011 and 012 say.

## Rules

### What is apart

- No screen, search, tool or node of one profile reads or changes the data of another profile. The
  tools "list workflows", "search chats" and "read chat" (007, 010) see only the workflows and
  chats of their own profile.
- All settings belong to the profile, except the list of profiles, "start at login" and "Show in
  the menu bar", which belong to the computer. The menu bar item shows the open profile (015).
- A new profile has no model account. Each profile has its own saved-secrets file and its own
  key, apart from the others (014). A separate sign-in of a vendor runtime (006) belongs to the
  profile where the user made it.
- Each profile has its own default workspace folder (013), its own logs, and its own database.
  Export and import are for one profile (014).
- Each profile has its own device identity, its own device name, its own switch "Let other
  devices connect", its own pairing codes and its own list of linked devices (012). A device that
  is linked to one profile has no access to another profile.
- The default device name of the first profile is the name of the computer. For a profile that
  the user adds, it is "<computer name> (<profile name>)". The user can change it (012).
- A server tile on a linked device shows the device name. A client cannot learn the name or the
  number of the other profiles of the computer.
- A profile can be in one sync pair (019). Two profiles of the same computer cannot link to each
  other or sync: the dialog says "This is the same computer."
- A profile has at most 10 linked devices that open it, as 012 says for a server.

### What is shared

Profiles keep work apart. They do not lock anyone out. Settings → Profiles shows this as one
muted line: "Profiles keep work apart. They do not protect it from a person who uses this system
account. For that, use a separate user account of the system."

The profiles of one computer share these things:

- The files that the user of the system can reach. A text node can work in any folder, also in the
  folder of a workflow of another profile. The app does not stop this (007).
- The permission that the system gave to the app, and the screen. A text node with computer use
  (007) looks at windows of any app, also at the window of ROBot that shows another profile.
- The programs that the app downloaded (006), and the sign-in that a vendor's program keeps for
  the user of the system. A model account that uses that sign-in shows the muted line "Shared by
  all profiles on this computer."
- The network of the computer.

### Limits

- Up to 5 profiles on one computer.
- One window shows one profile. The app has one window for the profiles.
- Only the user at the computer adds, renames, changes or deletes a profile. A linked device
  cannot do this, and neither a node nor the responsible document has a tool for it.

## Out of scope

- A password, a PIN or a biometric lock for a profile, and encryption of one profile with its
  own key.
- Two profiles in two windows at the same time.
- Sharing workflows, chats or memory between profiles. To move a workflow, the user writes a
  workflow file in one profile and imports it in the other (010). To move all data, the user
  exports one profile and imports it in an empty profile (014).
- Different system permissions for each profile.
- Profiles on a phone. A phone has one list of servers (011).
- A profile on a computer that is not a Mac with Apple silicon (000).

## Acceptance

- Make the profile "Parents". It opens empty, and the first start guide runs. The workflows of the
  first profile are not in its list. A search in "Parents" for a word from a chat of the first
  profile finds nothing.
- Connect a model account in the first profile. "Parents" shows no account.
- Pair phone A with the first profile and phone B with "Parents". The Servers screen of phone A
  lists one server, and the Servers screen of phone B lists one server. Neither shows the other.
- Open the first profile. A workflow of "Parents" has a schedule trigger, and it runs at its time.
  The computer makes no notice. The profile menu shows a dot on "Parents" if the run waits for an
  approval, and phone B gets its notice.
- Delete "Parents" and type its name. Phone B shows "Pair again". The folders of its
  workflows stay where they were. The first profile and phone A are as they were.
- Point a workflow of "Parents" at an existing project folder, then delete "Parents". The project
  folder and its files are as they were. A folder that the user chose is never removed.
- Quit and start the app: both profiles run, and the profile that was open is open.
- Start the app on a computer that has data of an earlier version: the app makes the first profile
  as on a new computer, and nothing of the earlier data shows in it.
- Pair the first profile with "Parents" on the same computer: the dialog says "This is the same
  computer."
- Make 5 profiles. The dialog for a sixth says that the computer has 5 profiles.
- Delete the only profile: the app refuses.
- Set the system language to Korean, make a profile, and read the dialogs: all text is Korean.
