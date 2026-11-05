# Test devices: sources, licences and decisions

Written on 2026-11-04 by the spec author, with specs 032, 033 and 034. This file is for the reviewer.
It is not a spec. It holds no behaviour that an implementer must build.

## The change of direction

The first draft of 032 to 034 made ROBot build the surface itself: a page, a live picture, taps,
logs, charts, app data views. That plan was thrown away. ROBot now downloads one program of another
vendor and shows its panel. The specs say what the app adds around it: the connection, the cards, the
classes of the steps, the outside content, the network rules and the data rules.

Why:

| | Building it in ROBot | Downloading the program (now) |
| --- | --- | --- |
| Work | About 8 slices | 3 slices (S113 to S115) |
| A new device tool of the vendor | ROBot writes it again | The user updates the download |
| The design of the panel | ROBot tokens and words | The program's own design; ROBot does not change it |
| The licence duty | Every part must be checked for the whole app | The parts stay in the download, apart from the app |
| The risk | ROBot must keep up with Xcode, adb and every device kind | The vendor keeps up |

## Source

- Repository: `callstackincubator/codex-mobile-dev-plugin`, MIT License, by Callstack. It is not a
  fork. The repository was renamed from `mobile-dev`; the old name redirects to the new one.
- The release that was opened for this file: `v0.1.176`, published 2026-11-04. Its four files are
  for macOS on Apple silicon only:
  `mobile-dev-0.1.176-darwin-arm64.zip` (27 985 936 bytes), a Claude plugin archive, a Claude Desktop
  bundle, and a panel runtime archive.
- Files that were read: `README.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, `PRIVACY.md`, `TERMS.md`,
  `.codex-plugin/plugin.json`, `.mcp.json`, `scripts/launch-mcp.sh`, the file list of the zip,
  `dist/agent-device/tools.json` (the tool list with its marks), and the public documents
  `docs/architecture.md`, `docs/telemetry.md` and `docs/performance.md`. No source file of the
  repository was read, and no code was copied.

## What the download holds

Taken from the file list of `mobile-dev-0.1.176-darwin-arm64.zip`:

- `dist/server.mjs` (5.4 MB): the MCP server.
- `dist/app.html` (3.4 MB) and `dist/browser-panel.html` (0.7 MB): the panel. The server answers them
  as `ui://mobile-dev/simulator.html` and `ui://mobile-dev/workspace.html`, of the kind
  `text/html;profile=mcp-app`. That is the MCP Apps extension, an open standard, and the panel also
  opens as a page of a browser.
- `dist/agent-device/`: the device control runtime (`agent-device` 0.21.33, MIT), with `tools.json`,
  the list of 54 commands.
- `dist/baguette/`: the iOS streaming and mirroring server (Baguette 0.2.1, Apache-2.0), with a
  rebuilt binary.
- `dist/android-cpu/`, `dist/android-fps/`, `dist/ios-fps/`, `dist/ios-logs/`, `dist/ios-mirror-*`:
  the native helpers for CPU, memory, Display FPS and the logs of connected iPhones.
- `skills/`: three guides for agents (`mobile-dev`, `mobile-dev-setup`, `agent-device`).
- `dist/telemetry-environment.json`: one value, `"environment": "release"`.

The server starts with `/bin/sh scripts/launch-mcp.sh ./dist/server.mjs`. The script runs node from
`$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`, which is the node of
Codex. ROBot must start the server with its own node 22.19 or later, so the app runs `node
dist/server.mjs` in the folder of the program and does not use that script.

`TRACE_SIFT_*` does not appear anywhere in the download: the analysis of a performance file needs a
separate program that the user installs (034).

## The network, checked in the bundle

- `MOBILE_DEV_TELEMETRY`, `MOBILE_DEV_ANALYTICS`, `DO_NOT_TRACK` and `MOBILE_DEV_ENVIRONMENT` are
  read by the server. The public document `docs/telemetry.md` says `MOBILE_DEV_TELEMETRY=off` turns
  off errors (Sentry) and product analytics (Mixpanel, from 0.1.177), and that
  `MOBILE_DEV_ANALYTICS=off` or `DO_NOT_TRACK=1` turns off analytics only.
- The panel page sends its own telemetry to a Sentry address. `docs/architecture.md` says the page's
  security rule allows only that one address, and that the panel gets its data through MCP rather
  than its own network calls. ROBot does not run the page as the program serves it: the app puts the
  panel in a frame with its own list of addresses, which holds this computer only (032, 018).
- The server listens on `127.0.0.1` with port 0, so the system gives it a free local port.
- A tool result and the panel come through the MCP connection of the app, which is a pipe, not a
  socket.

The tests in 032 and 034 are the proof. The app must show, with the network of the whole Mac logged,
that the server and the panel reach no address other than this computer, and that the analysis of a
performance file does the same. Until a test shows it, this file records it as expected and not as
proved.

## Who may call a tool, checked in the bundle

The server marks each tool with who may call it: the model, the panel, or both. The strings
`visibility: ["app"]` and `visibility: ["app", "model"]` appear beside the tool definitions in
`dist/server.mjs`, and the public document `docs/architecture.md` says that a host hides a tool whose
mark is the panel only. Both marks are used a lot: the panel streams frames, sends input, keeps a log
session alive, holds the update check and picks a folder with panel-only tools, and it offers app
storage, recordings, the screen map and the analysis to the model as well.

This is why 018 gives a built-in connection three groups of tools: the program already declares which
tool is which, and the app must follow that declaration. The rule matters, because a tool that the
panel calls is the action of the user and needs no card, and a tool that an agent calls is a device
step with all the cards of 032.

## Marks of the tools

`dist/agent-device/tools.json` gives each of the 54 commands two marks: read only and destructive.

- 12 read only: `apps`, `appstate`, `capabilities`, `devices`, `events`, `get`, `is`, `network`,
  `screenshot`, `snapshot`, `wait`, `help`.
- 15 destructive: `action-button`, `batch`, `clipboard`, `debug`, `diff`, `install`, `record`,
  `reinstall`, `replay`, `session`, `telephony`, `test`, `trace`, `trigger-app-event`, `uninstall`.
- 27 with neither mark.

The marks are not enough for the cards of 007 and 032. `install`, `uninstall`, `reinstall` and
`clipboard` are destructive, but they are not erase steps of 032 in every case:
`clipboard` also reads. `shutdown`, `boot`, `open`, `press`, `type`, `fill`, `swipe` have no mark and
change the test device. The panel and the server also offer tools that are not in this list
(`mobile_*`: logs, measurements, app data, screen map, analysis), and `.mcp.json` shows that the set
of tools changes with the version and with the host.

So 032 says that the app holds a fixed list that puts each tool in one class, and that a tool the list
does not name is a risky change. The list is part of the app because the app must decide the card
before it calls the tool. It is not the read-only mark of 018: the mark is a hint of the connection,
and 032 does not use it.

## Licences of the parts that the download ships

The notice file of the release lists these parts. AGENTS.md requires MIT-compatible licences only
(MIT, ISC, BSD, Apache-2.0 and the like), with no PolyForm licence and no copyleft that would bind
the app. The allowed list is in `host/tests/licenses.rs` and in the `licenses` scripts of
`apps/desktop` and `apps/mobile`. None of these parts enters those lists, because none of them is a
dependency of ROBot: they stay in the download of the program.

| Part | Licence | Where it stays |
| --- | --- | --- |
| Plugin code (server, panel) | MIT | In the download. Not copied into ROBot. |
| agent-device 0.21.33 | MIT | In the download. |
| Baguette 0.2.1 | Apache-2.0 | In the download, with its licence. |
| serve-emu 0.0.6 and the scrcpy server 4.0 | Apache-2.0 | In the download. |
| BAM Flashlight adaptation (Android CPU and memory) | MIT | In the download. |
| Perfetto SDK 25.0 (Android Display FPS) | Apache-2.0 | In the download. |
| idevice (iOS capture and Display FPS) | MIT | In the download. |
| libimobiledevice 1.4.0, libusbmuxd 2.1.1, libimobiledevice-glue 1.3.2, libplist 2.8.0, libtatsu 1.0.5 | LGPL-2.1 or later | In the download. **Not linked into ROBot.** |
| OpenSSL 3.6.2 | Apache-2.0 | In the download. |
| Sentry SDKs and Sentry Native 0.17.1 | MIT | In the download. Turned off by ROBot. |
| React, Radix UI, shadcn/ui, Tailwind, Zod, ws | MIT | In the download. |
| Lucide icons | ISC | In the download. |
| Feather icons | MIT | In the download. |
| Inter | SIL OFL 1.1 | In the download. |

The last three are the reason why the panel's design is not changed: ROBot does not copy the icons or
the font, and does not add its own tokens to the panel. The panel is the program's, shown in a frame.

### Why the LGPL part is acceptable now

The first draft (033) left the logs of connected iPhones out because the reader uses LGPL libraries.
In this plan ROBot does not link that reader. The library stays in a folder that the user downloads,
with its licence and with the source archives of its dependencies, and ROBot passes no data through
it beyond the file and the pipe of the program. The user can replace the library in that folder. Two
duties remain for the implementer:

- The download is a separate work. ROBot must not link, bundle or change the library, and must not
  claim that ROBot ships it.
- The app shows the licence of the download in About (013), and the settings section of 013 says who
  makes the program.

A licence review must confirm this before S113. The reviewer decides.

## Decisions for the owner

The specs hold a default for each decision. Change the default in the spec, or tell the spec author.

1. **The panel is the program's.** ROBot does not redraw it, does not translate it and does not apply
   its tokens. The panel's words are therefore in the language of that program, and its design is not
   ROBot's. Default: accepted, because the work and the licence duty are much smaller (see the table
   above). The alternative is to build it in ROBot, which returns to the first draft. This conflicts
   with the style rules of AGENTS.md and with the two-language rule, so the reviewer must answer it
   before S113. It is also a question in `docs/spec-questions.md`.
2. **Buttons of the panel that send something to a model.** The panel has "Ask" and "Explain this
   recording." (found in `dist/app.html`), and the public `docs/performance.md` says that one of them
   puts the recording reference and the instructions into the message of the chat. That is the chat of
   the host, so in ROBot it is a message of the agent and it uses the model provider that the user set
   up (000, 014). It sends nothing to another vendor, and it needs no new exception.
   - **Correction:** the first draft of this file, and the earlier conversation that led to it, named
     "Explain with AI" and a service called "Apex" as a path that sends a card to a model of another
     vendor. The current README, the privacy policy and the bundle were checked again for this draft,
     and neither name appears in them. That claim is withdrawn. `docs/architecture.md` says the page
     of the panel has one allowed network address, which is the error service of the vendor; it names
     no model service.
   - Default: a button of the panel that puts text in the chat is a message of the user, and it follows
     003. A button that would send data to a service of another vendor is refused by the list of
     addresses, and 032 says so.
3. **The analysis of a performance file needs a separate program.** The download does not hold it
   (`TRACE_SIFT_*` appears nowhere in it). Default: the app looks for it on the PATH and in the folder
   that the environment names, and shows "Not installed" when it is absent. The app never installs
   or downloads it. The alternative is to leave the analysis out of this version.
4. **The analysis program sends profiles to a service.** The README of the program says "the TraceSift
   tool in the device panel uploads a profile". The privacy policy of the vendor says that profiles
   go to a TraceSift service *on the user's own computer*. The two sentences disagree. Default: 034
   says that no file leaves this Mac, and the acceptance test of 034 requires a log of the requests of
   the whole Mac with requests to this computer only. If the service turns out to be remote, the
   analysis comes out of this version.
5. **Node.** The server needs Node.js 22.19 or later. The download does not hold a node, and its
   start script uses the node of Codex, which ROBot has no right to use. Default: S113 decides
   whether ROBot bundles a node for this program or asks the user to install one, and the tool state
   "Not installed" covers the second case. This must be decided before S113.
6. **The window of the program itself.** The program can also be built as a Mac app of its own. ROBot
   does not use that. The alternative is to start that window and not embed a panel, which needs no
   frame and no list of addresses, but puts the panel outside the ROBot window.
7. **Download from where.** The app reads one fixed address per version on the public release page of
   the vendor, with one checksum, as 006 does for its vendor runtimes. The alternative is the npm
   registry, which is refused: the unscoped package `mobile-dev` on npm belongs to another repository
   (`NoBey/mobile-dev`) and must not be installed.
8. **Numbers.** Proposed, not sourced: download refresh never automatic; server start 20 seconds;
   call limit 120 seconds; result cut at 100000 characters; guide for agents at most 20000
   characters; panel column 320 to 720 px; two test devices side by side at 1200 px or wider.
9. **Logs on a connected phone and measurements.** They arrive with the download, so the first draft's
   S116 to S126 shrink to the rules only. What stays for ROBot: the classes of those tools, the
   outside content, the redaction, the limits for an agent, and the erase steps. A screen walk runs
   the start script of the project of the user, so 034 makes it a risky change.
10. **A frame is not a panel of ROBot.** The panel of the program is a page of another product, so it
    does not follow `global.css`, the two themes, the text sizes or the two languages.
    `style-rules.test.ts` covers the frame and not its content. Default: accepted for this version, as
    decision 1 says. The reviewer may refuse it; then the surface needs the first plan, which builds it
    in ROBot, and eight slices again.

## Gap found in the existing specs

- 018 said "Resources and prompts that a connection may offer. Only tools are used." A panel is such a
  resource, so the sentence now has an exception for a built-in connection. A panel is not a prompt
  and not a tool: the app shows it in a frame and names the addresses that the frame may reach.
- 014 named no exception for a download, and says that every request goes to a service the user set up
  or to a page an agent visits. 014 now has one exception for a download that the user starts (spec
  changes, "Test devices (M33)", row 014). The same exception covers the 006 download. This is a fix
  to an existing gap, not new behaviour.
- 007 said that every step of a connection is a risky step, and that a card offers "Always allow".
  A built-in connection of a device surface needs a class for each tool, and a card with no "Always
  allow" (032, "Rules").

## Conflict with an open proposal

`docs/spec-questions.md` (013, 007, 018) holds a proposal for test devices that a gateway leases to
ROBot, with an agent token in the keychain and the program `agent-device` that the user installs.
That proposal and this spec are different things:

- this spec: the devices of this Mac, one downloaded program, a panel in the window;
- the proposal: devices of a worker machine behind a gateway, no panel, no download.

Both need a switch named "Test devices", and both reach the same family of tools. The reviewer must
decide whether the proposal stays open or is closed. The spec author's wish: the proposal stays open
as a later change for a worker machine, and its row in `docs/spec-questions.md` names this spec so the
two are not built twice under one switch.

## Not verified

- Whether the release passes a check on each macOS version that ROBot supports.
- Whether the panel runs inside an Electron frame of ROBot. The panel is an MCP App, and ROBot is its
  own host: the app must serve the panel's connection to the server itself, which is an
  implementation question. The public documents describe the host side of the extension. Electron 45
  (the version of this repository) has a frame element and a way to name the origins it may reach;
  the implementer checks that the panel's own pages work inside it.
- That the server and the panel make no request to another address than this computer. A test must
  show it (032, 034).
- The exact list of classes for the 54 commands and for the `mobile_*` tools. The implementer writes
  it from the tool list of the version and the specs, and the reviewer checks it. It is not copied
  from a source file.
- Whether the panel needs Node.js at all on the side of the app. The server of the program needs it
  (decision 5). The panel is a page that the server serves, so the app may not need a second copy.

## Next steps

1. The reviewer checks 032 to 034 and the changes to 000, 001, 007, 013, 018 and 014 against
   AGENTS.md and the specs, and answers decisions 1, 2, 4, 5 and 10.
2. The owner answers the other decisions.
3. An implementer session starts from the specs only, and builds S113 first. Each slice is one pull
   request with an end-to-end test.
