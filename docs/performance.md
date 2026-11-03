# Performance measurement

This is a test plan, not a behaviour spec. It says what to measure in the desktop app, how to keep
the numbers fair, and which numbers can stop a pull request. Choose your own tools and names.

## Setup

- Measure a packaged build of the app, not the development server.
- Use a new data folder for each run, made for the test. It holds one model account of a fake
  provider, 3 agents, and one direct chat of 100 messages with Markdown, code blocks and tables.
- The fake provider runs on this computer. It sends nothing to the network. No real account,
  key or user data is used.
- Keep the computer, the system, and the build mode the same between two reports that you
  compare.

## What to measure

| Measure | Start | End |
| --- | --- | --- |
| Cold launch | Start of the app, with the caches of the window engine cleared | The place list and the chat of 100 messages are drawn and accept input |
| Warm launch | Start of the app after a full quit, with the caches kept | Same as cold launch |
| Settings | Click on Settings | The section content is drawn, and then the end of its motion |
| Typing | A key press in the message box, with the chat of 100 messages open | The next drawn frame |
| Idle | 12 seconds with the app open and no work, one sample each second | CPU use and memory of all processes of the app |
| Streaming | The fake provider sends one part every 50 ms for 10 seconds | The time of each frame while the reply grows, and parts that were drawn late |
| Time to first reply | A message sent to the fake provider, which waits 500 ms | The first reply part on the screen |

- Take 5 samples of each launch and report the median and the worst sample.
- "Cold" means that the caches of the window engine are cleared. It does not mean that the
  system file cache is empty. Say this in the report.
- Report the sizes of the built files of the window and of the main process.

## Report

- Write one report as JSON and one as Markdown, with a label that the user gives, for example
  "before" and "after". Put them in a folder that git ignores.
- A compare command reads two reports and shows each measure, the two values and the change in
  percent.

## What can fail a pull request

- Only the sizes of the built files are stable enough. CI fails when a size grows by more than
  10 percent over the baseline in the repository. A pull request that grows a size on purpose
  updates the baseline and says why.
- The times, the CPU use and the memory are for information. They do not fail CI, because shared
  CI computers are not stable.

## Phone app

The phone app (spec 011) has its own plan. It uses the same rules for fair numbers: a release
build, the same device or simulator, the same system version, and a data folder made for the test
on the paired computer.

### Setup

- One computer runs ROBot with the fake provider of the setup above, 3 agents, and one direct
  chat of 500 messages with Markdown, code blocks and tables. The phone pairs with it on the local
  network.
- Measure on an iOS simulator and on an Android emulator. Measure on a real phone before a release
  of the phone app, and say in the report which one gave each number.

### What to measure

| Measure | Start | End |
| --- | --- | --- |
| Cold launch | Start of the phone app after a full quit | The list of places is drawn with its unread counts and accepts a tap |
| Open a chat | Tap on the chat of 500 messages | The newest messages are drawn and the message box accepts input |
| Scroll | A fling from the newest message to the oldest and back | The time of each frame, and the frames that were late |
| Streaming | The fake provider sends one part every 50 ms for 10 seconds | The time of each frame while the reply grows, and the parts that were drawn late |
| Reconnect | The computer goes off the network for 10 seconds and comes back | The phone shows the server as connected and the newest message |
| Idle | 30 seconds with a chat open and no work | CPU use and memory of the phone app |

- Take 5 samples of each launch and of each open, and report the median and the worst sample.
- Record a trace of the phone app for each measure with frames. The trace is part of the report.

### Fix loop

1. Record the trace and the report with the label "before".
2. Mark the frames or the time span that is slow, and say which measure it changes.
3. Change the code.
4. Record again with the label "after", under the same setup.
5. The compare command shows each measure, the two values and the change in percent, as for the
   desktop app. Attach both reports to the pull request.

- The numbers of the phone app do not fail CI, for the reason given for the desktop app.

## Times of tasks

The app stores the times of each task (spec 005): wait, first reply and total. The report reads
the time to first reply from the task, and checks that it matches the time on the screen within
100 ms.

## Tool choice checks with a real model

These checks are not part of CI, because they need a real model account and their results vary.
Run them by hand before a release that changes the tools of an agent.

- A list of cases. Each case has an optional earlier chat, a message, and the tools that the
  agent must call, must not call, and the most calls allowed.
- Two groups of cases:
  - **Guard**: the user asks for a change, for example "switch to a faster model" or "rename
    yourself to Ada". The agent must call the settings tool (spec 002).
  - **Control**: ordinary work or a question, for example "which model are you?" or "you are
    slow". The agent must not change a setting.
- Run each case 3 times and report the rate of passes per case.
- Cases are made up for the test. Never put text from real chats into the cases.
