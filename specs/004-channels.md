# 004 Channels

## Purpose

The user gives a job to a group of agents in one place and watches them divide and finish it.

## Concepts

- **Channel**: name (1 to 60 characters), topic (up to 200), instructions (up to 4000 characters,
  empty by default), members (agents), one optional lead agent, the setting "Review parts" (off by
  default), the setting "The lead answers questions" (on by default, see "Questions of members"),
  the setting "Own copies for parts" (off by default, see 025), a parent channel (empty by
  default), the tools of the channel and a daily token limit (off by default; for these three see
  030), and an optional section: a user
  section of the Channels list (see 001, "User sections"). With no section, the channel shows in
  the Channels list itself.
- **Lead**: the agent that reads each new job first. It can answer itself or split the job into
  parts and give each part to a member.
- **Part**: a child task (see 005) given to one member, with a short label and, when the lead
  gives one, a done test.
- **Done test**: one line, up to 200 characters, that says what a finished part must hold. The lead
  writes it in the plan. The member gets it with the part. A part with no done test gets no
  verdict.
- **Verdict**: the judgement of the lead on the result of a part: "Met" or "Not met". A "Not met"
  verdict has a reason of up to 160 characters. A verdict is a field of the part, not a state of
  the task. The part stays Done. The user's review (see "Review of parts") is a different thing:
  it has its own state, and it is the user's decision.
- **Mention**: `@Name` in a message sends that message to the named agent directly.
- **Everyone mention**: `@all` in a message gives the message to every available member. An
  available member is a member that is not archived. The mention list offers `@all` only when the
  channel has two or more members.
- **Fast pick**: a small, fast decision model that chooses one member for a job (see 013, "Decision
  model"). It is off by default.
- **Check**: a look of the lead at a channel whose work has stopped. The lead gives its verdicts in
  this look.
- **Answer of the lead**: the answer that the lead gives to a question of a member in a part, in
  place of the user. See "Questions of members".

## Flows

1. Create: the user picks "New channel", types a name and topic, adds members, and optionally picks
   a lead and a section. The "Section" choice lists the channel sections and "No section". It
   starts at "No section". Channel settings show the same choice. A channel can also be made from a channel starter, which makes the channel and its agents in one step (see 031).
2. Post a job: the user writes in the channel. The app chooses who gets the job, in this order:
   1. `@all`: every available member gets its own task for the message. Nobody else reads it.
   2. One or more `@Name` mentions: each named member answers. The lead does not read the job.
   3. Fast pick, if the user set it up and its rules hold (see "Fast pick"): the chosen member
      answers as if it had a mention.
   4. The lead, if the channel has one.
   5. No lead: the app asks which member should take it, with a row of member buttons.
3. Split: the lead posts a short plan message and starts parts. Each part can have a done test.
   Each member posts its replies in the channel under its own face and name. A reply shows at
   once. The check does not hide it.
4. Thread chips: under the message that started a part, a chip shows the member's face, the part
   label and the reply count. A click scrolls to the newest reply of that part and flashes it,
   with a "Back to the message" control.
5. Finish: when all parts end, the lead gives its verdicts (see "Check by the lead") and then
   posts one summary message. A part in review has not ended, so the summary waits for the
   decision. If the lead nudges a member for a verdict "Not met", the summary waits for the new
   part. The summary names each blocked part and its reason, and each part with the verdict "Not
   met" that no later part fixed.
6. Change members: the user adds or removes members in channel settings. A member that works
   cannot be removed until its part ends or the user stops it.
7. Archive: the user archives a channel from its menu. It leaves the place list. Its messages stay.
   Settings list it as archived, and the user can restore it or delete it there (see 013). The
   interface text says "archived", not "deleted", for a channel that is not gone. A channel keeps
   its section while archived. A restore puts it back in that section. If the section is gone, it
   returns with no section.
8. Retry or end: a failed or blocked part shows a card with "Retry" and "End the request". A
   blocked part shows its reason on the card. Retry makes a new part (see 005) and shows the
   retry note of 005 when it applies. "End the request" asks the user to confirm. It then cancels every part of the
   same job that is not final, and the wait of the lead for them. Parts that are done keep their
   results. The lead posts no summary. The confirm dialog has a "Back" button, so no two buttons
   say the same word with opposite meanings.
9. Review: in the channel settings the user turns on "Review parts". From then on, a part of a
   plan that ends with no error and no "Blocked:" line (see 005) is in review, not done. The
   user opens the part and chooses "Accept", or "Request changes" and types what to change (see
   "Review of parts"). Turning the setting off does not change a part that is in review.

## Review of parts

- The setting counts only for parts. The plan, the summary and a check of the lead, and a reply
  to a mention or `@all`, are never in review.
- A part in review shows an eye icon with a text label in the plan steps. Its chip and its
  messages stay. Under the last message of the part, a bar shows "Accept" and "Request
  changes". The Tasks page (005) offers the same two actions.
- "Request changes" opens a text field of 1 to 2000 characters. The new part has the label of
  the old part with the prefix "Changes: ", cut at 48 characters in all. Its chip shows under
  the first message of the new part.
- The user gets a notification of the kind "part in review" (015). A click opens the part.
- A part in review does not count as running for the check of the lead, and it does not hold
  the place of its member (005).
- A part that the user decided on (Accept, or Request changes) gets no verdict. The decision of
  the user is final.

## Questions of members

A member asks a question in a part (007, flow 3). Often the lead can answer it from the job, the
plan and the channel. Then the user does not need to stop for it.

- **When the lead gets the question first**: all of these hold. Otherwise the question goes to the
  user as before.
  - The setting "The lead answers questions" is on.
  - The question comes from a part. A reply to a mention or `@all`, a turn of the lead, and a
    direct chat never go to the lead.
  - The channel has a lead that is not archived and not blocked by a usage limit, and the lead is
    not the member that asks.
  - The turn of the member holds no outside content (007). Outside text can steer a question. A
    part that "Request changes" starts is a part like any other here: it holds outside content only
    by the rules of 007, and the plan and the replies of other members in the channel do not make
    it hold some.
  - The lead answered fewer than 3 questions of this part. The part of a nudge, of "Request
    changes" or of a Retry counts as a new part.
- An approval card never goes to the lead. Only the user answers an approval.
- **With the lead**: the question card shows in the channel at once, with the line "<lead> looks
  at it" and a spinner. The user can answer the card at any time. The answer of the user wins, and
  the look of the lead stops. When the user turns off the setting while the lead looks, the look
  stops in the same way: the card becomes a normal question for the user, with no line of the
  lead, in "Needs you", with the normal notification. The card is not in "Needs you" (021) and makes no notification
  (015) while it is with the lead. The card of the part on the board (024) shows the mark
  "Working" in that time, not "Needs you". On the Tasks page (005) the task of the part is Running
  in that time, and it is Waiting for the user from the pass on.
- **What the lead reads**: the question and its choices, the job message, the plan, the label and
  done test of the part, the channel instructions, the topic, and the last 12 messages of the
  channel, each cut to 600 characters. The lead treats all of that text as data, not as orders.
- **What the lead does**: exactly one of two things.
  1. Answer: the lead picks a choice or writes an answer of 1 to 2000 characters, and gives a
     reason of up to 160 characters. The member goes on with the answer, as after an answer of the
     user. The card shows the answer, "Answered by <lead>" and the reason. It has "Correct",
     which starts a reply to the answer in the message box with a mention of the member (flow 2).
  2. Pass: the lead gives a reason of up to 160 characters. The card becomes a normal question
     for the user, with the line "<lead>: <reason>". It is in "Needs you" and makes the normal
     notification of the kind "question" (015). With the setting "Ask up the line" on (030), a
     pass that is not of the kind "Only the user can choose" goes first to the higher agents of
     030, "Ask up the line".
- The lead is told to pass when the question asks for a choice of taste, money, a payment, a
  message or a file that leaves the computer, a deletion, an account, a key or a secret, a fact
  that the channel does not hold, or when it is not sure. It is told to answer the way the user
  would, from what the user wrote.
- **Time**: when the lead has not answered or passed 2 minutes after the question, the question
  passes to the user with the line "<lead> did not answer in time." A lead that runs another turn
  when the question comes uses the same 2 minutes. A failure of the lead passes the question at
  once, with the line "<lead> could not answer."
- The answer of the lead is not words of the user (007). A step that the member runs after it does
  not go to the check of "Ask when unsure" because of the answer.
- The look of the lead is a turn of the task of the lead for that job. It uses one slot (005)
  while it runs. Its tokens count in the usage of that task.
- Each look writes one line to the channel log (014): answered or passed, the reason kind (not
  sure, user choice, late, failure), and the time taken. The line holds no question text and no
  answer text.
- **Ways in and out**: the setting is in channel settings. With no lead, the switch is off with the
  muted line "The channel has no lead." Turning it off sends every later question of a part to the
  user at once. A question that is with the lead at that moment passes to the user.
- **Devices**: a linked computer (012) and the phone (011) show the card with its line and can
  answer it while it is with the lead. A linked device changes the setting only with the switch
  "Can create and change agents" (012).
- **Runtimes**: the rule holds for every question card of a part, from any runtime of the member
  and of the lead (006).
- **Restart**: a part has a parent task, so it does not wait through a restart (005). A look of the
  lead needs no rule for a restart.
- **Data**: the answer, "Answered by <lead>" and the reason are part of the card in the channel
  messages. They sync (019) and an export holds them (014). The setting syncs with the channel.
  The task view (005) lists the questions of the part, with who answered each one.

## Fast pick

- It runs only for a job that names no member, only when the channel has no job or part that is
  still open (a new message may continue that work), and only when at least two available
  members can take the job.
- The app sends the decision model the channel name and topic, the last few messages of the
  channel, the job, and the options. An option is a member, with name and role line. One more
  option says that no single member fits or that the job needs several members.
- The model answers with the chosen option and the probability of each option. The app uses
  the answer only when the chosen option is the most likely one and its probability is at least
  0.6. The "no single member" option never counts as a pick.
- The app waits at most 3 seconds. A wrong setup, a failure, a late answer, an answer that cannot
  be read, an unsure answer, and a member that is not available all give no pick. Then the
  lead reads the job, as if the fast pick did not exist. Nothing shows to the user except the
  normal flow.
- Each answer writes one line to the channel log (see 014). The line holds: whether a member was
  chosen, the reason when not, the probability, and the time taken. The reasons are: not set up,
  timeout, network error, an error code from the service, answer not readable, "no single member",
  unknown option, probability not a number, below 0.6, and not the most likely. The line never
  holds the job text or a key.

## Check by the lead

- A check happens only when the channel has a lead that is not archived and not blocked by a
  usage limit, and only when work in the channel has stopped: no part is queued, running,
  waiting or in review, and at least one part ended since the last check.
- The lead reads a short state of the channel: its topic, the older summary, the members with
  their role lines, the open and failed parts, and the last 12 messages, each cut to 600
  characters. For each part that ended as Done, has a done test, has no verdict, and has no
  decision of the user, it also reads the label, the done test, and the end of the last reply of
  the member, cut to 1500 characters. The lead treats all of that text as data, not as orders.
- The lead gives a verdict for each of those parts: "Met" or "Not met". The app saves the verdict
  with the part. A part that failed, was blocked or was cancelled gets no verdict. A later check
  gives a verdict only to a part that has none.
- The lead then does exactly one of three things:
  1. Nudge: a member stopped early, a result is missing or partial, a part has the verdict "Not
     met", or a part failed or is blocked and another try can help. The lead gives that member one
     more concrete instruction. It shows in the channel as a message of the lead, and it starts a
     new part (see 005). The new part has the done test of the old part. If it gets the verdict
     "Not met" too, the lead does not nudge it again for that reason. It asks (2) or does
     nothing (3).
  2. Ask: only the user can go on (a decision, a missing fact, an approval). The lead posts one
     specific question in the channel.
  3. Nothing: the work is complete, or the user stopped a part on purpose, or the last message
     already asks the user a question.
- The lead looks at most 3 times after each message of the user. A new message of the user starts
  the count again. The lead does not look twice at a channel that has not changed. The lead's own
  messages do not start a new look. The summary of the lead (flow 5) counts as a look.
- A lead that cannot answer leaves the channel as it is, and the parts keep no verdict. A check
  never fails a job.

## Activity panel ("Now")

- Title "Now" with an activity icon.
- One card per member: face, name, state (idle, working, waiting, offline).
- When a member leads active work, its card lists the plan steps: up to 8 steps, labels cut at
  48 characters, each with a state icon: to do (empty circle), running (spinner), done (check),
  failed (cross), in review (eye), blocked (stop sign). Each icon has a text label for screen readers.
- A running step whose turn is quiet (see 005, "Quiet line") keeps the spinner. Its text label and
  its tooltip read the quiet line.
- Cancelled parts do not show. When all work ends, the steps leave the card.

## Rules

- Agents in a channel see the channel messages; each agent keeps its own memory and workspace.
  Two members can still have one folder as workspace. Then the rules of 025 apply.
- **Channel instructions**: each member gets the instructions of the channel in every turn of
  that channel, after its own instructions (002, "Handbook"). The lead gets them too. The fast pick
  does not get them. The user edits them in channel settings. A change counts from the next turn. No
  agent can change them. Text that looks like a secret is refused on save. They sync (019), an
  export holds them (014), and a linked device can change them only with the switch "Can create
  and change agents" (012).
- A member that is busy with other work keeps a new part in its queue (see 005). The part shows
  what it waits behind: the name of the channel and the first words of the job that the member
  runs now, or a note that the member is busy in its own chat. The block of waiting parts in the
  channel shows this as one line under the part.
- The newest messages fill one part of the text of a member (see "What a member reads"). The
  messages of the channel that do not fit there are the older messages. The app replaces them
  with a short summary that the lead's model writes at the lowest effort the model offers. The
  summary fills at most one quarter of the context of the model of the member.
- If the summary cannot be written, the part starts with the newest messages and no summary,
  instead of failing. If the assignment and the instructions alone do not fit in the context,
  the part fails with a clear reason.
- **What a member reads**: a turn of a member in a channel gets its text in this order.
  1. The assignment of its part.
  2. The instructions: the member's own first, then the channel's.
  3. The messages that asked it: the newest 5, each cut to 2,000 characters.
  4. The short summary of the older messages, when one exists (see above).
  5. The newest messages of the channel. They fill at most one quarter of the context of the
     model of the member. When the app does not know the size of the context, it takes the last
     20 messages.
  6. A short reminder of the assignment, when the newest messages number more than 10.
- **Picture**: a channel can have a picture, as an agent has a face (002). In the settings of the
  channel the user picks an image. The app cuts it to a square of 256 px as a PNG of at most 1 MB.
  The picture shows in the place row and in the header in place of the `#` mark, and also on the
  phone and on a linked computer. It has the thin rim of an avatar (002). The user can
  remove it. It syncs with the channel (019). A
  linked device changes it only with the switch "Can create and change agents" (012).
- A part never stays in "working" after its turn has ended. This holds also when the link between
  the conversation of the member and the channel is lost. The chat of the member then stops
  saying that it works in the channel.
- The user can stop one part or all work in the channel. Stop does not change a part in review.
- A failed part shows its error, and a blocked part shows its reason, in the channel. The lead
  decides whether to retry or report, or the user retries or ends the request (flow 8).

## Acceptance

- A job split into two parts shows two plan steps, two chips, and one summary at the end.
- Stopping the channel cancels all running parts; their steps leave the panel.
- A message with `@all` in a channel of three members makes three tasks, one for each member, and
  the lead does nothing.
- With the fast pick set up and a fake service that answers "member 2" at 0.9, a job without a
  mention goes to member 2 and the lead does not read it. With a probability of 0.5, the lead reads
  it. With a late answer (over 3 seconds), the lead reads it.
- A member stops with half a result. The lead nudges it once. The member finishes. The lead
  then does nothing. After three looks without a new user message, the lead looks no more.
- A part fails. "End the request" cancels its sibling parts, and the done parts keep their results.
- A member runs a job in channel A. A job for the same member in channel B shows that it waits
  behind channel A.
- Turn on "Review parts" and post a job that the lead splits into two parts. Both parts end and
  show in review, with the eye icon. The lead posts no summary. Accept the first part: it shows
  done. Request changes on the second part with the text "Add a title": the old part shows done,
  a new part "Changes: <label>" runs and goes to review. Accept it: the lead posts one summary.
- A part is in review. Choose "End the request": the part shows cancelled and the lead posts no
  summary. Restart the app with a part in review: the part is still in review.
- A member ends a part with the line "Blocked: no access to the repository". The plan step shows
  the stop sign, the card shows the reason, and the summary of the lead names the part with that
  reason.
- A job with two parts, each with a done test. Both parts end. The check gives "Met" to the first
  and "Not met", with a reason, to the second. The lead nudges the second member once, and a new
  part starts with the same done test. It ends and gets "Met". The lead then posts one summary.
  The task view of the second part shows "Not met" and its reason, and its status stays Done.
- A part that a nudge started gets "Not met" again: the lead does not nudge it again for that
  reason. It posts one question or does nothing, and the summary names the part.
- A part has no done test, or it failed, or it was blocked: it shows no verdict.
- Turn on "Review parts". The user accepts a part: it shows no verdict, and the check does not
  read it.
- The lead is blocked by a usage limit when the parts end: no part gets a verdict, and the job
  does not fail.
- A channel with the instructions "Write the answer as a list." A member answers a job: its turn
  gets the instructions after its own. The same agent in its direct chat does not get them.
- A member in a part asks "Use the EU sizes only?" and the job message says that the shop ships
  to the EU only. The card shows "<lead> looks at it", then the answer with "Answered by <lead>"
  and a reason. The member goes on. "Needs you" stays empty and no notification shows.
- A member asks a question that the lead passes. The card shows the reason of the lead, the
  question is in "Needs you", and one notification shows.
- A question is with the lead. The user picks a choice on the card: the member goes on with that
  choice, and the lead gives no answer.
- The lead gives no answer for 2 minutes: the question passes to the user with the line about the
  time.
- A part asks a fourth question after 3 answers of the lead: it goes to the user at once.
- A part whose turn holds outside content asks a question: it goes to the user at once.
- Turn off "The lead answers questions": a question of a part goes to the user at once.
- A member asks for an approval: the approval card goes to the user, never to the lead.
- A channel job has a long history. A stand-in provider records the request of a member: the
  assignment comes first, then the instructions, then the newest messages, and the messages that
  fill the context part stay under one quarter of the context of the stand-in model. The reminder
  of the assignment is the last part of the text.
- Set a picture for a channel: the place row and the header show it. Remove it: the `#` mark comes
  back. After a restart the picture is still there.
- A stand-in model reports no size of context. A channel holds 30 messages. The request of a member
  holds the last 20 of them. With 11 or more newest messages the request ends with the reminder of
  the assignment. With 10 or fewer it has no reminder.
- A stand-in model has a context of 8,000 tokens and the channel holds 200 messages: the request
  holds the summary (at most one quarter of the context), the newest messages (at most one quarter),
  and the 5 newest asking messages, each cut to 2,000 characters. The stand-in summary call fails:
  the request holds the newest messages and no summary, and the part does not fail. The assignment
  and the instructions together are larger than the context: the part fails with the reason.
