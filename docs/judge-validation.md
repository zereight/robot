# Verdict validation

This is a test plan, not a behaviour spec. It says how to measure whether the verdicts of the
lead are right, and which numbers decide whether the check needs a change. Choose your own tools
and names.

The method comes from the public Apache-2.0 repository `ai-evals-course/evals-skills` (what to
measure and in which order). No text or code of it is copied.

## Why

- After a check, the lead gives each finished part that has a done test the verdict "Met" or
  "Not met" (004, 005). Nothing in the project measures whether these verdicts are right.
- The end-to-end tests use a fake provider that sends fixed answers. They test the flow of the
  check, not the quality of its verdicts.
- A wrong "Met" hides a bad result, and the summary then looks fine. A wrong "Not met" costs one
  more nudge turn.

## What to measure

Measure two rates for one lead model at a time. A person marks each part Pass or Fail first.

- **Pass** means the result holds everything that the done test says. **Fail** means it does not.
- **Met rate** (true positive rate): of the parts that a person marks Pass, the share that get
  "Met".
- **Catch rate** (true negative rate): of the parts that a person marks Fail, the share that get
  "Not met".

Do not report plain accuracy. Most parts pass, so a lead that always says "Met" would look good.

| Rate | Target | Lowest accepted |
| --- | --- | --- |
| Met rate | 90% | 80% |
| Catch rate | 90% | 80% |

- The number that counts is the low end of the 95% interval, not the point value.
- The catch rate matters more. A wrong "Met" hides a failure. A wrong "Not met" only costs a turn.

## Data

1. Count first. On a copy of the data folder, count the finished parts of channel jobs that have a
   done test, grouped by verdict and by decision of the user. Do nothing else with the data in
   this step.
2. Collect about 50 Pass and 50 Fail items. Use every real part that exists. A data folder can
   hold no real part. The work can still start. Add synthetic items for the rest, mostly Fail.
3. Tag each item "real" or "synthetic". Report the two groups apart. If no item is real, say in
   the report that the rates hold for made cases and not for real use.
4. Make synthetic items as jobs, and run them in the app. Write each job along three axes:
   - Job type: research, writing, review, organizing.
   - Done test kind: a count, a form, a content rule.
   - Length of the reply that the job asks for: short, or longer than 1500 characters.

   Give each job to a channel with real members and a real lead model. The members write the
   replies. Do not write replies by hand or with one model call. Such replies are too easy to
   judge.
5. Real members mostly pass. Get Fail items in two ways:
   - Write a done test that asks for more than the job text asks for.
   - Change a real reply in a known way: cut a part, change a count, add an invented fact, or put
     the problem in the first part of a reply that is longer than 1500 characters.

   Write one line on each item that says how it was made.
6. A person labels every synthetic item too. A flaw that was put in is not a label. The person
   decides.

### Private data

- Real items hold conversations of the user. Keep them outside the repository.
- Put only synthetic items, this plan and the numbers in the repository.
- A coding agent that reads real items sends them to its model provider. Leave private chats out.

## Labels

- A person who knows what each done test means makes the labels.
- Write the Pass and Fail rule on three lines before the first label. Label the first 10 items
  together and check that the rule holds.
- Show the whole reply, not the last 1500 characters. A cut reply would hide the errors that the
  cut causes.
- Hide the verdict of the lead and the decision of the user from the person.
- Allow "Skip" for an unclear item. Leave skipped items out of every count.
- Write one line of reason for each Fail. These lines show the kinds of failure.
- Do not use the decision of the user (Accept, Request changes) as a label. A user can ask for
  changes for a reason that the done test does not hold. Use the decision only to find Fail items.

## Replay

A replay sends an item to the model again and reads the verdict.

- The input must equal a real check: the same instruction text, the same state text and the same
  cut lengths (004). Build both from one source that the app and the replay share, so they cannot
  drift apart.
- The state of a channel at the time of a check is not saved. Rebuild the last 12 messages from
  the messages before the time of the verdict. Say in the report that this is close and not
  equal.
- The replay runs outside the app and calls the model with a key. The app never reads the
  sign-in tokens of a vendor program, so a lead that works through such a program is not tested
  by the same route. Name the model in the report and say this.
- A real check judges all parts of a job in one call and also chooses an action. For the baseline,
  replay the real groups of parts.
- Run each item 3 times. Report the share of items whose verdict changes between runs.

## Runs

Split the labeled items into train (15%), dev (45%) and test (40%). Keep the share of Pass and
Fail the same in each set. Take example items for a prompt only from train.

| Version | What changes |
| --- | --- |
| V1 | Nothing. This is the check as it is. |
| V2 | The lead writes its reason before the verdict, for both verdicts. The app still saves and shows a reason for "Not met" only. |
| V3 | One part for each call. The verdict does not share a call with the choice of an action. |
| V4 | The lead reads the start and the end of a long reply. This changes a number in spec 004. |

- Compare the versions on dev. Change one thing at a time.
- Run test once, at the end. Do not change a version after you see the test result.
- Find the 95% interval by resampling. With 20 Fail items the interval at 90% is about 13 points
  wide on each side. With 50 items it is about 8.
- Two versions whose intervals overlap are equal.

## Decision

| Result on test | Action |
| --- | --- |
| The low end of both rates is 80% or more | No change in the app. Keep the replay and the numbers as a regression check. |
| The low end of the catch rate is below 80%, or verdicts change often between runs | Choose the best version if its interval is clear of V1. A change that the user can see, or a number in a spec, starts with a spec change. |
| No version passes | Better words do not fix it. This needs a product decision, for example a stronger model for the check, or no nudge when the lead is unsure. |

## Report

Write a short report in `docs/` for each run. It holds:

- The date and the name of the lead model.
- The count of items by tag and by label.
- Both rates with their intervals, for each version.
- The share of items whose verdict changes between runs.
- The kinds of failure from the reason lines.

The report holds no text of real items.

## Run again when

- The lead model changes.
- The text that the lead gets for a check changes.
- Spec 004 changes what the lead reads or how it judges.
