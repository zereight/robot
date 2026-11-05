# 034 App data, screen map and performance files

## Purpose

The user sees what an app saved on a test device, sees the screens of an app project and the links
between them, and reads what an analysis of a performance file found. The panel of the test devices
connection shows all three (032). This spec says what an agent may read, which rules of the app
cover it, and where the data goes.

## Concepts

- **App data**: the data that one installed app saved on a test device. It is made of stores.
- **Store**: one place of app data: a database, a key-value store, or a set of files. The panel
  groups the stores of the app, the largest files of its data folder, and the stores of libraries
  that collect analytics or errors apart.
- **Store changes**: a list of the keys that were added, changed or removed while the user uses the
  app. The panel marks the part of a changed value.
- **Screen map**: the screens of a project and the links between them, read from the navigation code
  of the project. A screen is a box and a link is a line.
- **Screen walk**: a map that also opens the app on a simulator and photographs each screen it
  reaches. It runs the app.
- **Performance file**: a CPU profile, or a React DevTools profiling export, that the user chooses.
- **Finding**: a result of the analysis of a performance file. It names a measured task and the
  features that the task entered.
- **Analysis program**: a separate program on this Mac that analyses a performance file. It is the
  program that the user installs; the download of 032 does not hold it. The app starts it when the
  user asks for an analysis.

## Flows

1. **Open app data**: the user picks a test device and an installed app in the panel, and opens the
   app data part. The list of stores loads.
2. **Read a store**: a database shows its tables, and a table shows as a grid with pages. A file
   shows its content, with JSON, property lists and archives decoded. The user searches across every
   store of the app at once.
3. **Watch changes**: the changes part lists the keys that change while the user uses the app, and
   says whether a key was added, changed or removed.
4. **Clear one store**: the user presses "Clear" on a store, and confirms in the dialog of the panel.
   This is an erase step (032). The panel asks before an agent does it.
5. **Reset app data**: the user presses "Reset all data" for an app, and confirms. This is an erase
   step.
6. **Screen map**: the user opens the screen map part and picks a project folder. The panel reads the
   navigation code and draws the map. The panel keeps the map for that project, in a folder of the
   program inside the data folder of the profile (014).
7. **Screen walk**: the user picks the walk in the screen map part. The panel runs the start script of
   the project on a simulator and photographs each screen that it reaches. This is a change on a test
   device and it starts the app of the user, so it follows the rules of 032 for a risky change, and
   the card names the project folder.
8. **Analyse a performance file**: the user picks a file with "Analyse a file" in the panel, or
   attaches a file in the message box and asks an agent to analyse it. The app starts the analysis
   program on this Mac. Each finding is a card in the chat. "Explore" opens the call tree, the
   timeline and the flame graph inside the card. "Investigate" puts the finding with its measured
   numbers in the message box as the message of the user. No source change happens before the user
   presses "Investigate".
9. **An agent reads app data**: the agent lists the stores of an app, reads a table with a column
   filter, reads a file, or searches. Its result is the same filtered result as the panel's.
10. **An agent reads a screen map**: the agent reads the map of a project in its workspace.
11. **An agent analyses a file**: the agent starts the analysis of a file that the user chose and
    reads the findings. The card shows the file name and the numbers.

## States

- **No app chosen**: the panel says that the user picks a test device and an app.
- **Not supported**: the panel says that app data works on iOS simulators and on debuggable Android
  apps.
- **No stores**: the app has no stored data yet.
- **Locked**: an encrypted key-value store shows that the app holds the key.
- **Reading a map**: a line with the name of the folder.
- **Map done**: the number of screens and links.
- **Not a project**: the folder has no navigation that the program can read. The line names the two
  kinds that it reads.
- **Analysis program missing**: the analysis shows "Not installed", with one line that says what to
  install, and the button is off. The app installs nothing.
- **Analysing**: a line with the name of the file.
- **No findings**: the analysis found nothing to report in the file.
- **Failed**: the reason. A failed file is not kept.

## Rules

- **Sensitive read** (007): a read of app data is a sensitive read with the label "Test app data". A
  turn that reads app data holds the mark, and a later step that sends data out asks the user.
- **Redaction**: the panel removes a value that looks like a secret (014) before the value leaves the
  test device. The app shows "[REDACTED]" in the panel and in the chat, and gives the agent the same
  text. A binary value shows as "Binary value". The app does not decrypt a value: it shows that the
  store is locked.
- **Erase steps**: "Clear", "Reset all data" and a screen walk are steps of 032. "Clear" and "Reset"
  are erase steps. A screen walk is a risky change. Each follows the card rules of 032.
- **No writes**: the app does not edit a value in a store in this version, and it does not write to
  the project of the user. A screen walk only runs the start script of the project and reads the
  screen.
- **Platforms**: app data works on iOS simulators and on debuggable Android apps. It does not work on
  a connected phone in this version.
- **Screen map folder**: the panel reads the folder that the user picked. An agent reads the map only
  of a project in its workspace (007). A file step on another folder follows the rules of 007 for a
  read outside the workspace.
- **Screen walk needs a start script**: the walk runs the start script that the project already has.
  When the project has none, the part is off with the reason. The app does not write one.
- **Performance files**: the app reads the file on this Mac and keeps it, in the data folder of the
  profile (014), until the user deletes it or deletes the download. A file over 200 MB is refused,
  and the line shows its size.
- **The analysis program**: the app looks for it on the PATH of the computer and in the folder that
  the user's environment names, and it starts it on this computer only. The app does not install it,
  does not download it and does not update it. One line in the settings section (013) says that the
  analysis needs this program, and names it.
- **No upload**: no performance file, no profile and no finding leaves this Mac. The analysis runs on
  this computer. The panel gets its cards through the app, and the app gives the panel no address on
  the network (032, "The panel and the network").
- **A finding is not outside content** (007): the user chose the file, and the analysis names code of
  the project of the user. The screen map and its report are not outside content either: the user
  chose the folder. The names of the screens in a map, the values of app data and the log lines are
  outside content (032, 033).
- **Investigate**: the message that "Investigate" puts in the message box is the text of the user.
  The agent then works under its normal permission level (007).
- **The app keeps no copy of app data**: only the screen maps and the performance files stay, in the
  folder of the program. None of them syncs (019), and none is in an export (014).

## Surfaces

- **Ways in**: the app data part, the screen map part and the analysis part of the panel (032), and
  the tools of the test devices connection. The button "Analyse a file" in the panel. A performance
  file attached in the message box. The buttons "Explore" and "Investigate" of a finding card.
- **Devices**: this computer only (032). App data needs a simulator or an emulator.
- **Runtimes**: as 032. No agent on a vendor runtime gets these tools in this version.
- **Ways out**: close the part, "Clear" (confirms), "Reset all data" (confirms), delete a map,
  delete a performance file, stop an analysis, and "Delete the download" (032), which removes the
  maps and the files of the program.
- **Seeing the state**: the parts and the cards show their state (see "States"). After a restart, a
  running analysis shows "Stopped when the app closed." The findings that were made stay.
- **Data**: in the folder of the program, inside the data folder of the profile. Not synced, not in
  an export.
- **Words**: "app data", "store", "store changes", "screen map", "screen walk", "performance file"
  and "finding" (docs/glossary.md).

## Out of scope

- App data of a connected phone.
- Editing a value in a store, and decrypting a value.
- Building, starting or changing the project of the user.
- Sending a performance file, a profile or a finding to any service, and a button of the panel that
  would send data to a service of another vendor.
- Changes to app code that an analysis suggests.
- The drawing of the call tree, the timeline and the flame graph. The panel draws them.

## Acceptance

- The stores of a debuggable test app are listed in the panel. A key with a token-like value shows
  "[REDACTED]" in the panel and in what an agent reads.
- "Clear" asks first. Cancel changes nothing. Confirm clears only that store.
- An agent clears a store at "Full access": the card shows, and the step runs only after "Allow once".
- An agent that reads app data holds the sensitive read mark: a later fetch asks (007).
- The screen map of a sample project shows its screens and links, and the map is there after a
  restart.
- A screen walk of a project with no start script is off, with the reason.
- A performance file with nothing to report shows the line "The analysis found nothing to report in
  this file."
- With the analysis program not installed, the analysis shows "Not installed" and starts nothing.
- A performance file over 200 MB is refused, and its size shows.
- A test that logs the requests of the whole Mac while a performance file is analysed shows no
  request to any address that is not on this computer.
- "Investigate" puts the finding and its numbers in the message box of the open chat.
