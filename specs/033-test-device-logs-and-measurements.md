# 033 Logs and measurements of test devices

## Purpose

The user and the text nodes of a workflow read the logs that an app writes on a test device, and
they measure the CPU and the memory that the app uses. The panel of the test devices connection
shows both (032). This spec says what a text node may read, and which rules of the app cover it.

## Concepts

- **Log session**: one reading of the log of an app, or of the whole test device, until it closes.
  The panel keeps the session; the app keeps no copy.
- **Log source**: the system log of an iOS simulator, the Android log of an emulator or a phone, and
  the console lines of the development server of the app. The panel reads all three in one list.
- **Measurement**: a timed reading of the CPU and the memory of one app, with samples. On a
  connected phone it can also hold the Display FPS and the frame timing of the whole phone.
- **Chart**: the drawn view of a measurement in the panel. The user moves along it and selects a
  range. The panel draws it.
- **Range**: a part of a measurement that the user selects.

## What the panel has

- a list of the lines of a log session, with a search, a level filter and "Follow the app in front";
- "Send to chat" on a line, which puts the line, its stack trace and the name of the test device in
  the message box as the message of the user;
- "Save", which writes the lines of the view to a file that the user picks;
- "Measure", with a length from 5 to 300 seconds, and "Stop";
- a chart of a measurement, a comparison of two measurements, and a range with its numbers;
- "Ask in the chat about this range", which puts the numbers of the range in the message box. The
  words of both buttons are the words of the panel (032).

## Flows

1. **Read a log**: the user opens the log part of the panel and picks an app or "Whole device".
   Closing the part or the panel ends the session.
2. **A node reads a log**: the text node opens a session, reads the newest lines, and closes it. A
   session that a node opened ends when the node closes it or when its task ends. Its result goes
   to the node as outside content (032, "Rules").
3. **Measure**: the user starts a measurement in the panel. The panel shows the time left and keeps
   the samples when the user stops it early. The result is a chart and a card in the panel.
   A measurement that a node starts shows its tool card in the chat of the workflow (032).
4. **A node measures**: the text node starts a measurement under the same limits, reads its result,
   and quotes the numbers.
5. **Ask about a range**: the user selects a range and presses "Ask in the chat about this range".
   The numbers of the range go into the message box of the chat of the workflow that the panel is
   beside, as the message of the user. When no workflow chat is open (the page "Test devices"),
   the button is off with the reason "Open a workflow first".
6. **Send a line**: the user presses "Send to chat" on a line. The user presses Send. With no
   workflow chat open, the function is off with the reason "Open a workflow first" (032, "Ways to
   the chat").
7. **Display FPS**: on a connected phone, a measurement can hold the Display FPS and the frame
   timing of the whole phone. A simulator and an emulator give none, and the panel says so.

## States

- **No app chosen**: the panel says that the user picks an app or "Whole device".
- **Waiting**: the session is open, and no line came yet.
- **No match**: the filter hides every line.
- **Log stopped**: the test device went away or the app closed. The lines stay.
- **Measurement running**: the time left and "Stop".
- **Measurement done**: the chart and the numbers.
- **Stopped early**: the panel says the samples so far are kept.
- **Failed**: the app closed during the measurement. The samples so far are kept.
- **Not supported**: the Display FPS line of flow 7.

## Rules

- **Only while open**: the panel reads a log only while a session or the log part is open. The app
  keeps no line and no sample after the panel closes.
- **Reads**: a log session, a measurement and its numbers are reads (032, "Rules"). They run at every
  level, including "Read only".
- **Limits for a node**: a text node reads at most 500 lines, the newest first. It cannot start a
  measurement longer than 300 seconds, and it cannot start a second measurement of the same app
  while one runs.
- **Redaction**: a line or a value that looks like a secret shows as "[REDACTED]" in the panel, in the
  chat, in a saved file and in what a node reads (014).
- **Outside content** (007): a log line and the name of an app are outside content. A card of "Send to
  chat" is the message of the user, so it is not outside content by itself: the line that it quotes
  is. The numbers of a measurement are not outside content: the user started the measurement, and the
  numbers describe the app of the user.
- **Numbers only**: a measurement reports what it measured. The app adds no label such as good or
  bad, and sets no threshold. The panel of the program may word its own parts; the app adds no
  threshold and no score of its own, and the guide for nodes (032) tells the model to quote numbers
  only.
- **Storage**: the app stores no log line, no measurement and no chart. A file that the user saves
  ("Save") is the file of the user. A measurement that the panel keeps stays in a folder of the
  program, inside the data folder of the profile (014), and "Delete the download" removes it (032).
- **Sync and export**: no line and no measurement syncs (019), and none is in an export (014).
- **The app does not read a log of a connected iPhone**: the download holds a reader for it (032),
  and the notes in docs/mobile-devices-review.md name its licences.
- **The redaction runs before the value leaves the test device**: the panel removes a value that looks
  like a secret, and the app removes one more time before it gives the text to a node or puts it in
  the chat (014). A line that the panel saved to a file of the user is the file of the user; the panel
  redacts it before it writes (014).

## Surfaces

- **Ways in**: the log part and the performance part of the panel (032). The tools of the test
  devices connection. "Send to chat" and "Ask in the chat about this range".
- **Devices**: this computer only. A linked computer shows "Open this on <server name>." The phone
  shows no part of the panel.
- **Ways out**: "Stop" (a measurement stops and keeps its samples), closing the part or the panel,
  and "Delete the download".
- **Seeing the state**: the panel shows a mark on its log part and on its performance part while a
  session or a measurement runs. A measurement card in the panel shows its state. After a restart, the
  card shows "Stopped when the app closed."
- **Words**: "log session", "measurement", "chart", "range" and "Display FPS" (docs/glossary.md).

## Out of scope

- Thresholds, scores and advice based on the numbers.
- Display FPS on a simulator or an emulator.
- A log of a test device that is not connected to this Mac.
- A measurement of the Mac itself or of a web page.
- The drawing of a chart. The panel draws it.

## Acceptance

- A log session of a debuggable test app shows its lines in the panel, and a filter hides the others.
  Closing the part stops the reading.
- A line with token-like text shows "[REDACTED]" in the panel, in the chat and in a saved file.
- A text node that reads a log after a line holds outside content: its next fetch asks (007).
- A text node that asks for a 301-second measurement is refused, with the reason in its card.
- Asking for Display FPS on a simulator shows the panel's line and starts no session.
- A measurement stopped early keeps its samples and keeps its state.
- Beside a workflow view, "Ask in the chat about this range" puts the numbers in the message box of
  the chat of that workflow.
- On the page "Test devices", "Ask in the chat about this range" and "Send to chat" are off with the
  reason "Open a workflow first".
- The action log has one entry for each measurement that a node started, and no line of the log.
