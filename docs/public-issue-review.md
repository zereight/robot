# Review of public issues

Date: 2026-11-04.

This page turns the failures that users of a public project reported into checks for ROBot. The
project is milind-soni/OpenMausBot (Apache-2.0, an app of the same kind).

What was read: the titles and labels of its public issues (838 issues, 26 open with the label
"bug"), and the names of its release files. No source code, no README and no issue text beyond
the titles. Every line below is written anew, from the title only, so a report may be read
wider or narrower than its author meant. No text or code was copied.

A report is a hint for a test, not a fact about ROBot. The column "ROBot today" says what was
checked and how.

| State | Meaning |
| --- | --- |
| Held | Checked in the code or by a test. ROBot does not have the fault |
| Open | A gap was found by reading. No test or fix yet |
| Not built | The part of ROBot that the report is about is not built. Use the report as a test when it is |
| Not applicable | The cause does not exist in ROBot (platform or design) |
| Not checked | Not looked at yet. The "Test to write" column says what to try |

## Held

| Report | Fault in the other app | ROBot today |
| --- | --- | --- |
| #12 | A vendor program is not found when the app starts from the Dock or Finder, because the app has a short PATH | The app reads the PATH of the login shell of the user, with a time limit, and puts it first (`runtimes/login-path.ts`, with tests) |
| #15 | Quit hangs when a service never finishes closing | The close waits at most `CLOSE_MS` (5 seconds), then the app exits (`main/index.ts`) |
| #559 | A used port stops the start | The link server takes a free port when the wanted one is used (`services/Devices.ts`) |
| #289 | A fixed time cap on a turn, also while it waits for the user's answer | The silent limit holds its clock while the turn waits for the user (`services/silence.ts`, with tests) |
| #4129 | A custom model address of an odd kind ends the app | Text that is not an address, an address with no scheme, a scheme that the app does not speak, and an address that answers with a web page all give `provider_unreachable` and save no account. Pinned by four tests in `services/Providers.test.ts` (new in this change) |
| #312 | On the phone, "Always allow" on a card sent "deny" | A linked device has no "Always allow" (spec 012; the phone card has Allow and Deny only) |
| #2837 | Deleting a routine leaves the marks of its unseen failed runs lit | The Today page reads only routines that exist, so a deleted routine leaves no failed row, no done row and no count on the badge. Pinned by a test in `services/Today.test.ts` (new) |
| #3305 (retry part) | A reply shows twice | A retry checks and removes the failed reply in one step with no pause, so two asks at once make one new reply and the second is refused. Pinned by a test in `services/Chat.test.ts` (new). A stop and a restart in the middle of a reply are not covered |
| #2704 | An export opens a temporary file after it was cleaned up | Each export has its own temporary folder and removes it at the end. Two exports at once finish and leave nothing. Pinned by a test in `services/Data.test.ts` (new); it fails when the clean-up is taken out |

## Fixed in this change

| Report | Fault | Fix |
| --- | --- | --- |
| #313, #3305 (kind) | Found while checking #313 on the phone. When a message has no files, the box did not count itself as busy while the message went out: the button stayed on, so two taps (or a tap on a slow link and a second one) sent the message twice, and no message id lets the computer drop the second. Also, the box was cleared when the send ended, so text typed during the send was lost | `apps/mobile/src/chat/sending.ts`: one send at a time, kept in a flag that does not wait for a render; the button is off while sending; at the end, only the text and files that went out leave the box. Fourteen tests. The screen of #313 itself (old text after a switch of chat) is not the same fault: each chat is its own screen on the phone, so it holds |

The same pattern is in the message box of the computer (`renderer/chat/Composer.tsx`, `channels/ChannelView.tsx`). It is not changed: the answer of the call comes in milliseconds there, so two sends or a lost letter need a key repeat faster than that. Change it if a report shows it.

## Open

| Report | Fault in the other app | ROBot today | Next |
| --- | --- | --- | --- |
| #3728 | A page of the agent browser that does not answer is shown as the fault of the agent, and does not recover | Found by reading, not yet by a run: opening a page and running a script in the page have no time limit; a running tool holds the silent clock (`services/silence.ts`), so the turn waits until the user presses Stop; nothing handles a page process that ended. Spec 007 asks Stop to close the page work within 2 seconds; that was not run here | Spec question added (007). Test: a local page that never answers, then Stop |

## Not built

Test these when the part is built.

| Report | Fault in the other app | Part of ROBot |
| --- | --- | --- |
| #1048 | No way to disconnect a connected account | Connections (018, slice S32) |
| #2984 | A remote tool server fails with a generic text; the real status and the granted rights are hidden | Connections (018) |
| #2467 | A hint in a tool answer is read as a sign-in error | Connections (018) |
| #2665 | The pasted address of a sign-in redirect is refused | Connections (018) |
| #450 | Connecting to an app fails with "invalid JSON body" | Connections (018) |
| #481 | Tools are connected but not given to some programs | Connections (018) and the programs of spec 006 |
| #2388 | A web hook request with a wrong secret rewrites the store and pushes real calls out of the history | Web hook (009, 010) |

## Not applicable

| Report | Why |
| --- | --- |
| #1383, #3194, #2666 | These come from a browser that the user installed. ROBot has its own page view inside the app (spec 007) |
| #3883, #3472 | These come from a tunnel and a web origin between the devices. ROBot links devices directly, with the user's VPN and no relay (spec 012) |
| Reports for Windows and Linux only (for example #2916, #3416, #2770, #2117, #266, #2425) | The desktop app is for Macs with Apple silicon only (spec 000) |

## Not checked

The first row is the one that can do the most harm: it sends text to the wrong place.

| Report | Fault in the other app | Test to write |
| --- | --- | --- |
| #3200 | Runs of a schedule open separate chats and do not show in the place list | A routine run shows where the spec says, on the computer and on the phone |
| #1346 | A changed instruction does not reach a program that already runs | Change the instruction of an agent on each runtime; the next turn follows the new text |
| #961 | The provider cannot be changed while the highest permission is on | Change the model account of an agent at each permission level |
| #980 | A message of one agent that mentions another agent in a channel starts nothing | Spec 004 has the mention of the user only ("`@Name` in a message sends that message to the named agent"). A mention by an agent has no rule. Ask the spec author if it should |
| #2632 | Two threads at once in one group chat are not possible | Two threads of one channel work at once (spec 004, 003) |
| #932, #1055, #3238 | A dialog cannot be closed, or a new dialog opens behind another | Every dialog closes with Escape and its button; a dialog from inside another is on top |
| #3030 | A form keeps old values and its Save stays off until a restart | Change the permissions of an agent from the chat, then open the form: it shows the new values and Save works |
| #2625, #1871, #443, #3413 | Wrong cursor over buttons, controls that cover a name in a narrow column, overflowing fields, a menu with a bad edge | Screenshots at the smallest window width on each page |
| #2750 | The picture of an agent differs between the computer and the phone | Change a picture; the phone shows it after sync (spec 019) |
| #2064 | The update of a vendor program leaves a program that cannot start | After a download, run the program for its version before the old one is replaced (spec 006) |
| #2601 | A spoken message is written twice on one kind of phone | Speak one message; one text (spec 027) |
