# 031 Channel starters and the goal dialog

## Purpose

The user says what they want to do in a few words. The app shows the starters that fit those words.
A starter is either an agent starter (see 002) or a channel starter. A channel starter makes a
channel and its agents in one step.

The app does not write a role line, instructions or a channel from the words of the user. It picks
only from a fixed list. Nothing is made until the user presses Create.

## Concepts

- **Goal dialog**: a dialog with a text box, "What do you want to do?", and two lists: "Recommended"
  and "All starters". Each row shows the name, one line that says what the starter does, and a muted
  line. For an agent starter, the muted line says what else the starter makes (see 002). For a
  channel starter, it says how many agents the channel makes.
- **Goal text**: the words that the user types in the goal dialog. It holds up to 300 characters and
  stays on this computer (see "Rules").
- **Keyword**: a fixed word of one starter, in English or in Korean. The app compares keywords with
  the goal text (see "Matching").
- **Channel starter**: a ready channel with a name, a topic, a lead and members. Each member is a
  new agent. This version has three channel starters (see below).
- **Recommended**: up to three starters that fit the goal text, best fit first.

### Keywords

An English keyword is the start of a word: "writ" matches "write" and "writing". A Korean keyword is
a part of a text: "파일" matches "파일을", and "이름 바" matches "이름 바꾸기" and "이름 바꿔줘".

| Starter | Keywords in English | Keywords in Korean |
| --- | --- | --- |
| Assistant | question, answer, writ, draft, email, explain | 질문, 답변, 답장, 글쓰기, 작성, 메일, 설명 |
| Briefer | briefing, news, digest, summar, daily | 브리핑, 뉴스, 요약, 소식, 매일 |
| Researcher | research, fact, source, verif, compar, study | 조사, 리서치, 사실, 출처, 검증, 비교 |
| Reviewer | review, code, bug, diff, test | 리뷰, 코드, 버그, 풀 리퀘스트, 테스트 |
| Organizer | file, folder, organi, sort, renam, tidy | 파일, 폴더, 정리, 분류, 이름 바, 정돈 |
| Research | investigat, report, survey, literat | 보고서, 연구, 자료 |
| Code review | review, diff, commit | 리뷰, 풀 리퀘스트, 변경 검토 |
| Files | desktop, download, folder, tidy | 바탕화면, 다운로드, 폴더, 정리 |

The keywords are fixed. The user cannot change them.

### Channel starters

Each channel starter has a name and a topic, in English and in Korean. The Korean texts below are
proposals. The translation catalogue holds the final text (see 013).

- **Research** (Korean: "리서치"). Topic: "Finds facts and sources and writes a short report."
  (Korean: "사실과 출처를 찾아 짧은 보고서를 씀.") Lead: Researcher. Members: Briefer and Assistant.
- **Code review** (Korean: "코드 리뷰"). Topic: "Reviews code changes and writes a plain summary of
  the problems found." (Korean: "코드 변경을 검토하고 찾은 문제를 쉬운 말로 요약함.") Lead: Reviewer.
  Member: Assistant.
- **Files** (Korean: "파일 정리"). Topic: "Sorts the files of one folder and writes a short list of
  what moved." (Korean: "폴더 하나의 파일을 정리하고 옮긴 목록을 짧게 씀.") Lead: Organizer. Member:
  Assistant.

Each agent in a channel starter takes the name, the role line and the instructions of the agent
starter with the same job. The language follows the interface at the moment of the pick (see 002).

## Flows

1. Open: in the New agent form (see 002), the user opens "Start from" and picks "From a goal…". The
   goal dialog opens with an empty text box, and "All starters" lists the eight starters in the order
   given in "Matching". The form does not change.
2. Type: while the user types, "Recommended" shows the starters that fit. It updates at each change
   of the text. "All starters" does not change.
   It always lists all eight starters, the recommended ones too.
3. Pick an agent starter: the dialog closes. The New agent form fills in the name, the role line
   and the instructions of that starter, as in 002 (flow 3). The goal text is cleared.
4. Pick a channel starter: the dialog shows a preview of the channel. The preview has a field for
   the channel name, a field for the topic, and one row for each agent. Each row has a field for the
   name and, in muted text, the role line. The lead row has the mark "Lead". The buttons are "Create",
   "Back" and "Cancel".
5. Edit: before Create, the user can change the channel name, the topic and each agent name. The
   role lines cannot change in the preview. The lead is fixed in this version. The user can change
   the lead later in the channel settings (see 004).
6. Create: the app makes the channel and its agents (see "Channel starters" under "Rules"). The new
   channel opens, the dialog closes, and the goal text is cleared.
7. Back: the preview closes, and the lists come back with the goal text as it was.
8. Cancel or Escape: the dialog closes, nothing is made, and the goal text is cleared.

## States

- **Empty goal text**: "Recommended" is not shown. "All starters" shows the eight starters.
- **No fitting starter**: "Recommended" shows the line "No starter fits this goal." "All starters"
  stays as it is.
- **Preview**: the fields hold the values of the starter, or what the user typed. "Create" is off
  while a name is empty or has only spaces. The line under the empty field says "Type a name."
- **Creating**: "Create" is off until every part is made, so one press makes one channel.
- **Failed**: nothing is made. The preview stays open with the names that the user typed. One line
  gives the reason and the words "Nothing was made."

## Rules

### Goal text

- The text box takes up to 300 characters. It takes no more. A paste over the limit is cut at 300.
- The app sends the goal text to no model, no service and no other device. No request leaves the
  computer while the user types or picks.
- The app keeps no goal text. It is in no history, memory, export, sync, log or file.
- Closing the dialog clears the goal text.

### Matching

- An English keyword matches when a word of the goal text starts with it, ignoring case. "code" does
  not match "encode".
- A Korean keyword matches when it appears anywhere in the goal text.
- A keyword counts once, however often it appears.
- Keywords of both languages match in both interface languages.
- The score of a starter is the number of its keywords that match. A starter with a score of 1 or
  more fits.
- "Recommended" shows up to three fitting starters, highest score first. Starters with equal scores
  keep the order of "All starters".
- The order of "All starters" is: Assistant, Briefer, Researcher, Reviewer, Organizer, Research,
  Code review, Files.
- With an empty goal text, "Recommended" is not shown. A goal text with only spaces is empty.

### Agent starters from the dialog

- The pick works as in 002 (flow 3). The user can change the fields before Create. At Create, the
  routine and the skills of the starter are made, with the limits and the note of 002.

### Channel starters

- Create makes the channel and all its agents in one step. If one part cannot be made, the app makes
  no channel and no agent.
- The channel takes the name and the topic from the starter, or from what the user typed in the
  preview.
- The channel has no instructions. Its settings are the defaults of 004: "Review parts" off, "The
  lead answers questions" on, and "Own copies for parts" off. It has no section ("No section").
- The lead is the first agent named in each channel starter above. It has the mark "Lead".
- Each member is a new agent with three fields only: name, role line and instructions. It gets no
  routine and no skill. The starter sets no model, no permission level and no workspace, so each
  agent starts with the defaults (see 006 and 007).
- The main agent does not change.
- A name that is taken, ignoring case, gets a number after the name, as in an import (see 002). This
  applies to the channel name too.
- The channel name has 1 to 60 characters (see 004). An agent name has 1 to 40 characters (see 002).
  A text box takes no more characters than its limit. A paste over the limit is cut at the limit.

### Keyboard

- The text box has the focus when the dialog opens.
- Tab moves the focus in the order on screen. In the list, Enter picks the row, as a click does.
- Escape closes the dialog (see "Flows", step 8).
- In the preview, Enter does not press Create. Create is pressed by a click, or by Tab to its button and Enter.

### Limits

- This version has three channel starters. Each makes two or three agents, with one lead.
- "Recommended" shows at most three starters.

## Surfaces

### Ways in

- The choice "From a goal…" is the first choice of "Start from" in the New agent form (see 002). It
  is the only way in this version.
- No place-list menu item, no key and no search entry opens the goal dialog. The search (Cmd+K) does
  not find it.
- The New channel form (see 004) has no such choice. A channel starter is reached only through the
  goal dialog.

### Devices

- **Computer**: as in "Flows".
- **Linked computer** (see 012): the choice does not show. Its New agent form lists the five agent
  starters, as in 002.
- **Phone** (see 011): the phone makes no agent in this version (see 002), so it has no goal dialog.

### Runtimes

- Nothing changes for the runtime. The starter sets no model, so each agent uses the model settings
  of any new agent (see 006).

### Ways out

- The goal dialog closes with "Cancel" or Escape. "Back" only leaves the preview. Nothing is made
  before Create, so nothing needs an undo.
- After Create, the user can archive the channel as any channel (see 004) and each agent as any
  agent (see 002).

### Seeing the state

- After Create, the new channel shows in the Channels list at once. The org chart (see 029) shows it
  within 1 second, with the mark "Lead" on the lead.
- The agents show their state as any new agent does (see 002).
- After a restart, the same channel and agents show.

### Data

- Sync (see 019): the channel and its agents sync as any channel and agents. Nothing new syncs.
- Export (see 014) and agent files (see 002): the channel and its agents go out as any channel and
  agents. The goal text is in no export.
- The phone cache (see 011): nothing new.

### Words

- The glossary holds two new words: "Channel starter" and "Goal text". The word "Starter" also covers
  channel starters.
- The feature does not use the words "hire", "employee", "team" or "manager" for an agent or a
  channel.

## Out of scope

- Starters that the user makes or edits.
- Matching by a model, or by any service outside the computer.
- A reason for each fit, and a saved list or history of goals.
- More than three channel starters, and channel starters with other settings, instructions, or a
  lead that the user picks.
- Routines and skills for the agents of a channel starter.
- A role line, instructions or a channel written from the words of the user.
- The goal dialog on the phone and on a linked computer.
- A hosted catalogue of starters or agents.
- Recommended workflow starters (see 010).

## Acceptance

1. In a new profile with no agent, the "Start from" list of the New agent form shows "From a goal…"
   first. Pick it: the goal dialog opens with an empty text box, "Recommended" is not shown, and "All
   starters" lists the eight starters in the order given in "Matching".
2. Type "compare sources for my report": "Researcher" is the first recommended starter (2 keywords),
   and "Research" is second (1 keyword).
3. Type "review my code changes": "Reviewer" is first (2 keywords), and "Code review" is second (1
   keyword).
4. Type "폴더 정리해줘": "Organizer" is first, and "Files" is second. Both have 2 keywords, so the
   order in "Matching" decides.
5. Type "다운로드 폴더 정리": "Files" is first (3 keywords), and "Organizer" is second (2 keywords).
6. Type "encode a video": "Recommended" shows "No starter fits this goal." "All starters" still
   shows the eight starters.
7. Type 300 characters, then one more: the text box does not take the last character.
8. Pick "Briefer": the dialog closes, the form fills in with the Briefer starter, and reopening the
   dialog shows an empty text box. Create makes the paused routine and the skill, as in 002.
9. In a profile with no agent, pick "Files", keep the default names, and press Create: the channel "Files"
   opens, with "Organizer" marked "Lead" and "Assistant" as a member. Both agents have no routine and
   no skill. The channel has "Review parts" off, "The lead answers questions" on, "Own copies for
   parts" off, no instructions, and "No section".
10. Repeat 9 in a profile with an agent named "Assistant": the new member gets a number after its
    name, and the channel gets one too if "Files" is taken.
11. Pick "Research" and clear the channel name: "Create" is off, and the line "Type a name." shows
    under the field. Type only spaces instead: the same result.
12. Make one part fail, for example with a test stand-in that refuses the second agent: no channel
    and no agent is made, and the preview shows the reason and the words "Nothing was made."
13. Pick "Research" and press Back: the lists show the same goal text as before. Press Cancel:
    nothing is made, and the dialog opens empty the next time.
14. Type a goal and close the dialog. Restart the app, open the dialog again, and export the
    profile: the dialog is empty, and the export holds no goal text.
15. Type a goal with network monitoring on: no request is made.
16. Create "Research" and open the org chart: the channel node shows the mark "Lead" on Researcher,
    and a solid line runs from Researcher to Briefer and to Assistant (see 029).
17. On a linked computer, the New agent form has no "From a goal…" choice, and "Start from" lists the
    five agent starters, as in 002.
18. In the Korean interface, the choice, the dialog, and the channel names and topics are in Korean.
    With the Korean interface, "review my code" still ranks "Reviewer" first.
19. Export a profile with a channel made from "Files", then import the file into an empty profile:
    the channel and its agents come in as an ordinary channel and ordinary agents (see 002 and 004).
20. Type "review code file folder compare sources": "Recommended" shows three starters, Researcher, Reviewer and Organizer, in that order, with 2 keywords each. Code review and Files, with 1 keyword each, are not shown there. "All starters" still shows all eight starters.
21. With the goal text empty, open the goal dialog with the keyboard: the text box has the focus. Press Tab: the focus moves to the first row, Assistant. Press Enter: the Assistant starter is picked, as with a click. Open the dialog again, type a goal, and press Escape: the dialog closes, and the goal text is cleared.
22. Paste 320 characters into the goal text: it keeps the first 300. Type only spaces: "Recommended" is not shown, and "All starters" lists the eight starters. Paste 70 characters into a channel name: the field keeps the first 60.
23. Pick "Files" and press Enter in the preview: nothing is made. Press Tab until Create has the focus, then press Enter: the channel is made, as in item 9.

### Keyword check

The rows below apply the rules in "Matching" and the keyword table to example goal texts. The examples are not user data.
Each row is one check. The "Recommended" column lists the starters in that order, with their scores.
Each keyword counts once.

| Goal text | Recommended, best fit first | What it checks |
| --- | --- | --- |
| compare three laptops and write a short report | Assistant (1), Researcher (1), Research (1) | Three starters tie at one keyword. The fixed order decides. |
| clean up my downloads folder | Files (2), Organizer (1) | A plural matches "download". The channel starter has two matches, the agent starter one. |
| review the changes in my last commit for bugs | Reviewer (2), Code review (2) | Two starters tie at two keywords. The fixed order decides. |
| write a reply to this email from my landlord | Assistant (2) | Two keywords match in one starter. |
| daily news briefing about AI | Briefer (3) | Three keywords match in one starter. |
| find sources for my thesis on sleep | Researcher (1) | A plural matches "source". |
| plan a trip to Japan | No starter fits | No keyword matches. Travel planning is not covered. |
| organize my photos by date | Organizer (1) | The stem "organi" matches "organize". |
| study the facts about vaccines and check the sources | Researcher (3) | Three different keywords match in one starter. |
| summarize the news and write a short summary | Briefer (2), Assistant (1) | "summar" counts once, although two words match it. |
| 노트북 몇 개 비교해서 보고서 써줘 | Researcher (1), Research (1) | One Korean keyword for each of two starters. |
| 다운로드 폴더 정리해줘 | Files (3), Organizer (2) | Three keywords beat two. |
| 오늘 뉴스 요약해서 매일 아침 알려줘 | Briefer (3) | Three Korean keywords match in one starter. |
| 이 코드 리뷰해서 버그 찾아줘 | Reviewer (3), Code review (1) | Three keywords beat one. |
| 자료 찾아서 출처 정리해줘 | Researcher (1), Organizer (1), Research (1) | Four starters tie at one keyword. The fixed order decides, so three show. |
| 사진 이름 바꿔줘 | Organizer (1) | "이름 바" matches the verb in another ending. |
| 메일 답장 써줘 | Assistant (2) | "메일" (email) and "답장" (reply) match. |
| 여행 계획 짜줘 | No starter fits | No keyword matches. Travel planning is not covered. |
| 번역해줘 | No starter fits | No keyword matches. Translation is not covered. |

