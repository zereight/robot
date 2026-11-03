# Memory evaluation

This is a test plan, not a behaviour spec. It says how to measure whether memory items, the memory
check, and the tools "search chats" and "read chat" (007, 008) help an agent answer from the past.
Choose your own tools and names.

## Why

A paper of October 2026 (arXiv 2610.30755) tested memory systems on long-conversation tasks. A
plain search over the raw history, with search by meaning and re-ranking, gave the best result in 6
of 7 settings. The paper says that it tests conversation tasks. It does not say that it tests
agent work with tool steps, or Korean text. And ROBot searches by words, not by meaning. So the
paper does not say what is true for ROBot. This plan measures ROBot.

## Setup

- Use one model account made for the test. Use the same model and effort in every run. Say which
  in the report. The answers need a real model, so this plan cannot use the fake provider.
- Use a new data folder for each run, made for the test. It holds one agent. No real user data is
  used.
- The history is made up and written once, by hand. It has 40 chats of one made-up user with the
  agent, over 30 made-up days. Half of the chats and questions are in Korean. The history is
  kept in the test files and replayed turn by turn before each run, so the text is the same
  every time. Some chats hold tool steps, and some of these steps fail.
- During the replay, memory saving is "Save at once", so that the agent makes its own items, as it
  does in use. The memory check is on only in the arm "Both, with check".

## Arms

| Arm | Memory items | "search chats" and "read chat" | Memory check |
| --- | --- | --- | --- |
| Nothing | Hidden | Off | Off |
| Memory only | Visible | Off | Off |
| Search, old rule | Hidden | "search chats" with the rule of message search (001): every word, newest first. No "read chat". | Off |
| Search | Hidden | On, as 007 says | Off |
| Both | Visible | On, as 007 says | Off |
| Both, with check | Visible | On, as 007 says | On |

- "Hidden" means that the agent gets no item and has no tool to save one. "Hidden" and "Off" are
  switches for the test only. The app gets no new setting and no new behaviour for them.
- The arm "Search, old rule" tests the change of 007 itself. If the old rule is not kept in the
  code, skip this arm and say so in the report.
- The arm "Nothing" shows how much a model answers without any past. A question that this arm
  answers well is a weak question. Replace it.

## Questions

Ask 60 questions, 10 in each group. Ask each one in a new chat, in one turn, with no other
context. Write the answer key before the first run.

| Group | What the question needs |
| --- | --- |
| Told once | A preference or a name that the user said one time |
| Latest value | A fact that changed 2 or 3 times. The question asks for the value now |
| Reason | Why a choice was made. The reason is in another message than the choice |
| Failed attempt | What the agent tried that failed, and why. A tool step failed in that chat |
| Two facts | An answer that needs two facts from two different chats |
| Unknown | A fact that nobody said. The right answer is that the agent does not know |

## Scoring

- An answer scores 1 when it holds the key fact and no wrong fact. Otherwise it scores 0. In the
  group "Unknown", an answer scores 1 only when the agent says that it does not know.
- A model may mark the answers. A person reads at least 20 answers of each arm, and the report
  gives how many marks the person changed.

## Runs

- Run each arm 3 times. A run is a new data folder, the replay, and the 60 questions.
- A run is void when more than 3 of the 60 turns fail for a reason that is not the answer, such
  as a network error. Run it again.
- Scale step: run the arm "Search" once more with the history padded with 50,000 messages of
  made-up filler. This shows whether answers get worse when the history is large (001 sets the
  time limit for the same size).

## What to report

| Measure | Per |
| --- | --- |
| Mean score and the range of the 3 runs | Arm and group, with English and Korean apart |
| Input and output tokens per question | Arm |
| Calls of "search chats" and "read chat" per question | Arm |
| Time to the last word of the answer, median and worst | Arm |
| Tokens of the turns of the memory check during the replay | The arm "Both, with check" |
| Number of memory items, and their size in characters, after the replay | Arms with items |

Put the report in the pull request. Keep the answer keys and the made-up history in the test
files, and do not put the account or its key there.

## Choices that the numbers can make

These are proposals. The owner of the specs decides.

- "Both, with check" beats "Both" by less than 3 points in total: the memory check has no clear
  gain in this test. Open a spec change to remove it (008).
- "Both" beats "Search" by less than 3 points in total: memory items have no clear gain over
  search for these questions. Review the purpose of memory (008) before more work on it.
- "Search" beats "Search, old rule" by less than 3 points in total: the loose rule and "read
  chat" have no clear gain. Open a spec change to go back to the strict rule.
- "Reason" or "Two facts" scores lower in "Search" than in "Memory only": the limits of "read
  chat" (007) can be too small. Open a spec change for the limits.
- "Unknown" scores under 80 percent in any arm: the agent answers from weak hits. Open a spec
  change for the rule of "search chats".
- "Search" at 50,000 filler messages scores 5 points or more under "Search": open a spec change
  for the ranking of hits.

## What this plan does not claim

- One made-up history of one user is small. A result that is close to a limit above is not a
  result.
- It does not test agents on a vendor runtime (006), tool output, or web pages.
- It does not test search by meaning (016 puts it out of scope). If the group "Two facts" or
  "Reason" scores low, add that arm in a later plan.
