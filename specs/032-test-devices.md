# 032 Test devices

## Purpose

The user builds an app and needs to see it run. The user shows an iPhone simulator, an Android
emulator or a connected phone beside the chat, acts on it, and lets an agent do the same.

ROBot does not draw this surface itself. The user downloads a program of another vendor, and ROBot
starts it. The program holds the device control, the live picture, the logs, the measurements, the
app data and the analysis of a performance file. The app shows its panel in the window, gives its
tools to the agents, and holds the rules and the cards.

## Concepts

- **Test device**: an iOS simulator, an Android emulator, an iPhone, an iPad, an Android phone or an
  Android tablet that the program finds on this Mac. A simulator or an emulator runs on this Mac. A
  connected phone belongs to the person who holds it.
- **Test devices connection**: one built-in connection (018) that the app makes by itself. It has
  no command, no address and no secret. It is not in the Connections list; its page is in settings
  (013). It is off at first.
- **Download**: one file from the public release page of the vendor of the program, for macOS on
  Apple silicon. It holds the server, the programs that show and control devices, the panel, and a
  guide for agents. Each version has a fixed checksum. The user downloads it once, and the user does
  not install it by hand.
- **Panel**: the surface that the downloaded program draws. It shows in the panel column beside a
  conversation (001), or across the page "Test devices".
- **Device step**: one call of a tool of the test devices connection by an agent.
- **Erase step**: a device step that deletes or replaces data on a test device: uninstall an app,
  replace the clipboard of the test device, clear the data of an app, reset the data of an app,
  reset a test device, and erase a test device.

## What the panel has

The panel belongs to the program. Its design, its buttons and its words are not ROBot's. These are
its parts, so that this spec says what the rules cover:

- the test devices of this Mac, with start and shut down;
- a live picture of one test device, or of two side by side; a click taps, a drag scrolls or drags,
  and typing goes to the test device; the hardware keys of the kind of test device;
- the settings of a test device: appearance, text size, rotation, location, status bar, network
  condition, and "Back to normal";
- the apps of a test device: install a built app file, launch, stop, open a link, a permission, the
  language of one app, and a test push on an iOS simulator;
- the logs of a test device and of the development server of the app (033);
- the CPU, the memory and the Display FPS of an app, with charts and a comparison (033);
- the app data of an app, the screen map of a project, and the analysis of a performance file (034);
- a note on an element or a region of the picture, and "Send to chat".

## Flows

1. **Turn on**: the user turns on "Test devices" in settings (013). A card shows the size, the
   version and the source of the download, and the button "Download". Nothing downloads before the
   user presses it.
2. **Download**: the app downloads the file, checks its checksum and unpacks it in the data folder of
   the profile (014). A progress line and "Cancel" show while it runs.
3. **Check the tools**: the app checks what a test device needs on this Mac: Xcode for iOS, the
   Android platform tools for Android, and Node.js 22.19 or later for the server. Each one has a
   state (see "States"). The app installs no tool.
4. **Open the panel**: the user presses the button "Device" in the header of a conversation, or the
   page button "Test devices" (001). The app starts the server, and the panel shows in the panel
   column, or across the page. While the panel is open, the page "Test devices" shows the panel and
   not the conversation. The user goes back with the page buttons.
5. **Act on a test device**: the user picks a test device in the panel. A stopped simulator starts
   when the user picks it. The user acts on the picture and on the buttons of the panel.
6. **Work with an agent**: the user asks in a chat. An agent that may use the connection gets its
   tools (018, "Many tools"). When the agent calls one, a tool card shows in the chat with the tool
   name (see "Rules" for the card). The panel opens beside the chat with the test device that the
   step names, when the column has room. When the column is closed or too narrow for the panel
   (001), the button "Device" of the header shows a dot, and the panel waits for the user.
7. **Send a note to the chat**: the user selects an element or a region of the picture and writes a
   note. "Send to chat" puts the note and the details of the element in the message box of the open
   conversation, as the message of the user. A picture goes with it when the panel sends one. The
   user presses Send.
8. **Stop**: Stop in the chat ends the device step that runs. The test device stays on, and an app
   that runs stays on.
9. **Check for a new version**: the user presses "Check for a new version" in settings. The app
   reads the public release page of the vendor and shows the newest version, or the reason of the
   failure. The app never checks by itself.
10. **Update**: the user presses "Update". The app downloads the new version, checks its checksum,
    and unpacks it in place of the old one. The new version holds tools that the user has not
    accepted, so every tool waits for review (018, "Tool review") and the user sees them before an
    agent uses them.
11. **Delete the download**: the user presses "Delete", after a confirm. The file, the unpacked
    program and the folders that the program made for this profile leave the disk. The connection
    goes off, and the agents lose its tools.

## States

- **Off**: the section says that test devices are off. No download happens.
- **Download needed**: the card shows the size, the version, the source, and "Download".
- **Downloading**: a progress line and "Cancel".
- **Failed download**: the file is removed. The card shows the reason and "Try again": no network,
  a wrong checksum, no room on the disk, or a file that is not an archive.
- **Tool states**: Checking; Ready; Needs repair (the tool is there but too old or broken, and the
  line says what to fix); Not installed (the line says what to install).
- **State of the connection**: the state of the built-in connection follows the state of its
  download and of its server: Off, Download needed, Downloading, Checking, Ready, or Error with the
  reason. A tool of a version that the user has not accepted is held, as 018 says.
- **Server states**: Starting; Ready; Failed, with the reason (the program ended, or it gave no
  answer in 20 seconds). The server of a profile that no turn needs stops after 10 minutes; the
  next call starts it again, and the panel shows "Loading" in that time.
- **Panel states**: Loading; Live; Closed, when the user closes it, and the stream stops; Failed,
  with the reason and "Try again".
- **The frame fails**: a broken panel, or a panel that gives no frame in 20 seconds, shows one muted
  line in the panel column with the reason and "Try again". The test devices and the device steps are
  not affected.
- **No test device**: the panel shows its own empty state, and says how to start a simulator or to
  connect a phone.
- **Failed step**: the card shows the reason. If the app closed while the step ran, the card shows
  "Stopped when the app closed."

## Rules

- **Download**: the app knows one address per version, on the public release page of the vendor, and
  one checksum for the file. A file with a wrong checksum is removed. No other file downloads, and
  the app does not check for a new version by itself.
- **No reports**: the app starts the server with the switches of the program that turn off error
  reports and product analytics. The app sets them and the user cannot turn them on. The panel of the
  program sends nothing to any service, because the app gives the panel no address on the network
  (see "The panel and the network").
- **The panel and the network**: the panel reaches the test devices and the local analysis only
  through the app. The app refuses every other request of the panel. A link in the panel opens in the
  system browser only when it is https. A button of the panel that puts text in the message box, for
  example "Explain this recording.", works as the message of the user (003), because the text goes to
  the chat and later to the model provider of the agent. A button of the panel that would send data to
  a service of another vendor does nothing, because the app names one address for the frame, and that
  address is on this computer.
- **The server is a program of another vendor**: it runs on this Mac with the rights of the user, and
  the app cannot see what it does. The settings section says this, as 018 says it for a program that
  the user adds, and it names the folder that the program uses.
- **Guide for agents**: the download holds a short guide for agents. The app adds it to the turn of
  an agent that may use the connection, after the instructions of the app and before the words of the
  user. It is at most 20000 characters. It is text of the download and not outside content (007).
- **One call at a time**: one call of the test devices connection runs at a time. A second call
  waits, and its card says "Waits for another call of Test devices." The approval card of the second
  call shows when it is its turn. This keeps two agents away from one test device.
- **Many tools**: the download offers more than 20 tools, so an agent that may use it gets the step
  "Search tools" and not the tools (018). The words of the tool names and descriptions are the
  program's, and the app searches them as 018 says.
- **User and agent together**: the user can act in the panel while a device step runs. A step and a
  change of the user can meet on the test device, and the app does not stop either. An action of the
  user in the panel is not a device step: it makes no card and no entry in the action log (018,
  "Built-in connections"), and no permission level holds it.
- **Device steps by permission level** (007). The app holds a fixed list that puts each tool of the
  downloaded version in one class. The user cannot change it. A tool that the list does not name is
  a risky change.
  - **Reads** run at every level, including "Read only". Reads list the test devices and their
    states, list the apps, read a snapshot of the screen, take a screenshot, read a log (033), read a
    measurement (033), read app data and read a screen map (034), and read what the tools of this Mac
    report.
  - **Changes** are: start, shut down, tap, type, press a key, scroll, drag, launch an app, stop an
    app, and change a setting of the test device or its network condition. "Read only" refuses each
    of them. "Ask for everything" asks for each of them.
  - **Risky changes** are: install an app, replace an app, change a permission, change the language of
    an app, open a link or a deep link, send a test push, send an app event, record a session, take a
    trace, and a batch that runs other steps. On a connected phone, every change is a risky change.
    "Ask for risky steps" asks for each of them. "Ask when unsure" asks and never goes to the check
    (007): the check reads the words of the user and the kind of the step, and never the arguments of
    a tool of a connection, so it cannot see which test device or which app the step would change.
    A change of the language of an app is a risky change, because it can change what a store holds.
  - **Erase steps** ask at every level except "Read only", also at "Full access". The user confirms in
    the card. An erase step never goes to the check.
  - A card offers "Allow once" and "Deny". It does not offer "Always allow for this agent", and no
    Allow rule covers a device step. A Deny rule still refuses it.
  - Each card names the tool and the test device when the arguments name one. It shows the arguments
    of the step.
- **Outside content** (007): a screen snapshot, a picture of a screen, a log line, a value of app
  data and the name of an app that the program read are outside content. A turn that holds such text
  holds outside content from that step on. The screen map and the analysis of a performance file are
  not outside content: the user chose the folder and the file, and they hold the code of the user
  (034).
- **Not outside content, and still a read**: the numbers of a measurement (033) describe the app of
  the user, and the user started the measurement. So a measurement is not outside content. It is not
  a sensitive read either.
- **Sensitive read** (007): a read of app data is a sensitive read, with the label "Test app data".
- **Pictures for the model**: a screenshot gives a picture. An agent gets the picture only when its
  model takes pictures; otherwise the step says that the picture is not available, and the agent gets
  the snapshot as text. The app keeps the picture in the data folder of the profile (014) and gives
  the agent no file path for it.
- **Time limit**: a call may run for 120 seconds. At the limit the step fails with "timed out",
  because some commands of the program need more than 60 seconds (018). A result longer than 100000
  characters is cut, and the agent is told that it was cut.
- **Action log**: each device step has one entry (007). It holds the agent, the tool name, and who
  decided. It holds no argument and no picture.
- **Profiles** (022): each profile has its own download, switch, server and folders. A server starts
  when a turn of that profile first needs its tools, or when the panel of that profile opens. It
  stops when the switch goes off, when the app quits, or after 10 minutes with no call and no open
  panel. An open panel is not an idle time: the stream is a live connection, and it ends with the
  server.
- **Sync, export and the phone**: test devices are not synced (019). Only the switch is in an export
  (014). The panel shows on this computer only. An agent of a linked computer (012) uses the test
  devices of that computer. The phone (011) has no panel and no page, and it shows a device step as a
  chat line and answers its card.
- **Runtimes**: only an agent whose model comes from an API provider (006) gets the tools of the test
  devices connection, as for every connection (018). An agent on a vendor runtime gets none in this
  version, and its profile line says so.
- **Words**: the interface says "test device" for a simulator, an emulator or a connected phone. The
  word "device" alone means a linked computer or phone (012).

## Surfaces

- **Ways in**: the page button "Test devices", after the org chart (001). The button "Device" in the
  header of a conversation. The settings section "Test devices" (013). The search field (Cmd+K) lists
  test devices by name; a press on a name opens the panel.
- **Devices**: this computer shows and controls its own test devices. A linked computer (012) shows
  the page with the line "Open this on <server name>."
- **Ways out**: close the panel (the stream stops, and the test devices stay on). Stop (the step
  stops, and the test device stays on). Turn "Test devices" off in settings: the panel closes, the
  server ends, the stream stops, the agents lose the tools, and a running step fails with "Test
  devices are off." Delete the download.
- **Seeing the state**: the settings section shows the state of the download, of the server and of
  each tool. The page shows the panel. The button "Device" of a conversation shows a dot while a
  device step runs. Each device step shows as a chat line.
- **Data**: the download and the folders of the program stay in the data folder of the profile. They
  are not synced (019) and not in an export (014). The export holds the switch only.
- **Words**: "test device", "panel", "device step" and "erase step" (docs/glossary.md).

## Out of scope

- Test devices on Windows, on Linux or on an Intel Mac (000).
- The design, the buttons and the words of the panel. The app does not change them, and it does not
  draw them again.
- The window of the program itself, which a user builds from its source. ROBot shows only the panel.
- A button of the panel that sends data to a service of another vendor, and any other request that
  leaves this Mac from the panel.
- A test device that a gateway leases to ROBot. That proposal stays open in docs/spec-questions.md
  (013, 007, 018).
- Test device tools for an agent on a vendor runtime (006) and for the phone app (011).
- "Always allow" for a device step.

## Acceptance

- With "Test devices" off, no file downloads and no server starts.
- Press "Download" with the network blocked: the card shows the reason and "Try again", and no file
  stays on the disk.
- Serve a file with a wrong checksum: the app removes it, and the panel does not open.
- With Xcode missing, the iOS tool shows "Not installed". The app installs nothing.
- With the download ready, press "Device" in a chat: the panel shows in the right column, and it
  shows the test devices of this Mac.
- At a window width of 760 px, the panel closes, as 001 says.
- A click in the picture changes the snapshot of the screen that the next read gives.
- An agent on "Read only" reads a snapshot, and gets "Refused: read only" for a tap.
- An agent on "Ask for everything" gets a card for a tap. The card has no "Always allow".
- An agent uninstalls an app at "Full access": the card shows, and the step runs only after "Allow
  once".
- A tap on a connected phone at "Ask for risky steps" asks; a tap on a simulator runs with no card.
- Stop in the chat leaves the simulator on and its app running.
- A second agent that calls a tool of the connection waits, and its card says "Waits for another call
  of Test devices."
- Turn off "Test devices": the panel closes, the server ends, and the tools leave the agents.
- A test with the network blocked shows that the panel made no request, and that the server sent
  nothing to an error or analytics service.
- A test that logs the requests of the whole Mac while a performance file is analysed shows requests
  to this computer only (034).
- With an agent on an API provider and one on a vendor runtime, only the first gets the tools.
- Annotate an element and press "Send to chat": the note is in the message box of the open chat, and
  Send puts it in the chat as the message of the user.
- Check for a new version, then update: the section shows a review of the tools of the new version,
  and no agent gets one before the user accepts it.
- Delete the download: the folders of the program leave the disk, the connection is off, and the
  panel does not open.
- Export, then import into an empty app: the switch comes back, the download does not, and the
  section shows the card again.
