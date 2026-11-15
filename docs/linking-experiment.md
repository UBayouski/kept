# Candidate-linking experiment

Question: given a note and a short list of existing commitments, does the device model attach the note to the right one? The verdict is which commitment it selects and what it would do to it, not whether the JSON is valid.

Page: `linking.html`. Cases, prompts, app rules and scoring: `src/linking-cases.js`. Design: `data-model.md`.

**Status (2026-11-15): the question has an answer for this model and these prompts, from one run each.** On the device, linking is not reliable and the model never says it is unsure. In the cloud, the same prompt was right or abstained on every note. The held-out notes have now been run and read, so they are no longer held out: any further tuning needs new ones.

## Full runs, with the held-out notes (runs 4 to 6)

Run by the user, 2026-11-15, Chrome 157 on Windows, through Firebase AI Logic. 29 notes with the candidate list in two orders: 58 calls per run, one run each, default sampling. 17 notes are the development set (34 calls); 12 are the held-out set (24 calls), about other people and other work, written before any model saw them. The device model reported itself as Gemma 4. No call failed and every answer parsed as JSON.

| Run | Development: pass / question / unsafe | Held-out: pass / question / unsafe |
|---|---|---|
| 4. Device, v2, as returned | 23 / 0 / 11 | 12 / 0 / 12 |
| 4. Device, v2, after the app rules | 22 / 2 / 10 | 10 / 2 / 12 |
| 5. Device, v1, as returned | 15 / 1 / 18 | 11 / 0 / 13 |
| 5. Device, v1, after the app rules | 16 / 11 / 7 | 12 / 6 / 6 |
| 6. Cloud (`gemini-3.5-flash-lite`), v2 | 32 / 0 / 2 | 22 / 0 / 2 |

"Question" means nothing wrong would be proposed and nothing is lost, and the user is asked a question that contains the right answer. "Unsafe" means a wrong change would be proposed or a change is lost.

### The cloud model abstains; the device model does not

| Ambiguous notes (6 development runs, 6 held-out) | Asked | Guessed |
|---|---|---|
| Device, v1 | 0 | 12 (8 by changing both candidates, 4 by picking one) |
| Device, v2 | 0 | 11, and one reported as something new |
| Cloud, v2 | 12 | 0 |

- **Cloud:** every ambiguous note came back as "unclear" with the right kind of change and the right date. No wrong commitment in 58 calls, and no answer changed with the order of the list. Calls took about 1 s.
- **The cloud's only failures are four over-cautious answers.** "The proposal and the contract both move to Tuesday" and "Priya moved both reviews to Thursday" came back as one "unclear" in both orders. The scorer counts that as unsafe, because a "which one?" question without an "all of them" option loses one of the two changes. If the app's question always offers "all of them", these four are needless questions and the cloud has no unsafe answer. That is a design decision made after seeing the result, so the table keeps the stricter count.
- **Device, v2, on held-out notes: half unsafe.** All six ambiguous runs were guesses. Small talk produced invented changes in both orders ("Omar was late again" became a change to the venue booking, "Priya brought cake" a new commitment), although the development small-talk note passed. Same wording with another recipient failed once in each set (the proposal for Dana went to Lee's; the budget for Omar went to Priya's). Two answers merged two statements into one item.
- **Device, v1 with the rules, is the safer device option on held-out notes:** 6 unsafe of 24, against 12 for v2. The rules turned 7 of v1's 13 unsafe held-out answers into a pass or a question. They did not help v2.
- **The rules are not a reliable ambiguity detector.** They work only when the model changes both candidates. v1 did that for 8 of 12 ambiguous runs and picked one for the other 4.
- **Order of the list, device:** the selection changed with the order in 6 of 17 development notes and 7 of 12 held-out notes with v2, and in 9 of 17 and 6 of 12 with v1.
- **Results per note are not stable between runs.** On the 15 original notes, v2 passed 21 of 30 in run 2 and 22 of 30 in run 4, but different notes failed: "cancelled" was wrong twice in run 2 and right twice in run 4, while two notes that passed in run 2 failed in run 4.
- **Malformed answers got through the schema.** One v1 answer repeated nine contradictory changes to one commitment, with broken field values and keys that are not in the schema. One v2 answer named a listed commitment with the change "new commitment". The app has to validate answers, not only parse them.
- Device calls took 1.2 to 9 s after a first call of 28 s.

The raw output of runs 4 to 6 exists only as pasted into the working session. Unlike runs 1 and 2 it is not in `test/fixtures/`.

## Earlier runs on the development notes (runs 1 to 3)

All runs: Chrome 157 on Windows, through Firebase AI Logic, 15 notes with the candidate list in two orders, so 30 calls. The device model reported itself as Gemma 4. Every answer was valid JSON in every run, so validity says nothing.

| Run | Passed | Not passed | Not run |
|---|---|---|---|
| 1. Device, prompt v1 | 12 | 18, of which 2 were only a needless question | 0 |
| 2. Device, prompt v2 | 21 | 9 | 0 |
| 3. Cloud (`gemini-3.5-flash-lite`), prompt v2 | 17 | 0 | 13 |

### Run 1: device, prompt v1

The model returns two lists: updates to listed commitments, and new commitments.

| Group | Runs | Passed | What went wrong |
|---|---|---|---|
| A clear change to one listed commitment (9 cases) | 18 | 12 | The right commitment was selected in all 18. Six failed for something added: the similar commitment changed as well (2), the same commitment also reported as new (3), "cancelled" read as "done" (1) |
| A new promise that is not in the list | 4 | 0 | All four attached it to an existing commitment as a new deadline |
| A note that changes nothing | 2 | 0 | Both returned an "unclear" entry for small talk |
| An ambiguous note | 6 | 0 | All six changed both candidates |

When the list was reversed, six of 15 cases changed their pass or fail verdict, and nine changed what the model selected. The first call took 96 s (the model loading), the rest 1.6 to 5.4 s. Two answers carried an extra top-level key, `required`, copied from the schema.

### Run 2: device, prompt v2

One list, one item per statement; each item is about a listed commitment, something new, or "unclear". Five worked examples on an unrelated list.

| Group | Runs | Passed | What went wrong |
|---|---|---|---|
| A clear change to one listed commitment | 18 | 15 | "Cancelled" read as "done" in both orders. Once, the contract's deadline was put on the pricing commitment: the first wrong commitment picked alone in either run |
| A new promise that is not in the list | 4 | 4 | |
| A note that changes nothing | 2 | 2 | |
| An ambiguous note | 6 | 0 | All six got one confident pick: the first fitting commitment in the list |

- **v2 fixed what it was aimed at:** new promises, small talk, and commitments reported twice.
- **The order of the list still matters a great deal.** Only one case changed its pass or fail verdict with the order, down from six, but that number hides the problem: a case that fails in both orders is not counted. Four of 15 cases selected a different commitment when the list was reversed: all three ambiguous notes, and the contract deadline that went to the pricing commitment.
- **v2 did not fix ambiguity, and hid it.** With v1 the model changed both candidates, which the app can see. With v2 it picks one, and which one depends on the order of the list: K7 when K7 is listed first, R2 when R2 is. Nothing in the answer shows that it was a guess. The app rules changed no verdict in this run, because they had nothing to catch.
- v2's schema allows several items with the same quote. It asks for one decision per statement; it does not enforce it. In this run every answer complied.
- The first call took 289 s.

### Run 3: cloud, prompt v2

17 calls answered and all 17 passed, including the three that the device got wrong in run 2 (both "cancelled" runs and the contract's deadline). The other 13 failed with `429`: the free tier allows 15 requests a minute for this model. The 13 include every ambiguous case, so **whether the cloud model abstains is still unknown**, and that is the question the cloud run was for.

The first cloud attempt, before run 2, failed entirely on App Check (the debug token of this browser was not registered). The page now spaces cloud calls 4.5 s apart and retries after a quota refusal.

## App rules

Many wrong answers in run 1 look inconsistent, and the app can see that without knowing the right answer. Three rules, applied to a reading before anything is proposed. None picks an answer and none discards a change. Each produces a question for the user that keeps the change and its date.

1. A new commitment with the wording and recipient of a listed commitment the same reading updates becomes a question: new, or the same thing said twice? The update itself stands.
2. The same words attached to several commitments as the same change become one question: which of these, or all of them?
3. The same words given both as a change to a listed commitment and as a new commitment become one question: that commitment, new, or both?

Shared words are a reason to ask, not proof of a contradiction. "The proposal and the contract both move to Tuesday" is a correct answer that rule 2 also catches, so its question offers "all of them". "I sent Dana the contract; I promised her another contract Friday" is a correct answer that rule 1 also catches, so its question keeps the new commitment as one of the answers. The cost of the rules is that such notes are asked about when they need not be.

Replayed over the 30 answers of run 1 (transcribed in `test/fixtures/linking-device-run-1.mjs`; the transcription reproduces the summary the page reported):

| | Pass | Safe, with a question | Unsafe |
|---|---|---|---|
| Run 1 as returned | 12 | 2 | 16 |
| Run 1 after the rules | 17 | 10 | 3 |
| Run 2 as returned, and after the rules | 21 | 0 | 9 |

"Safe, with a question" means nothing wrong would be proposed and nothing is lost, and the user is asked a question that contains the right answer: the right commitment, the right kind of change and the right date. "Unsafe" means a wrong change would be proposed or a change is lost.

- Run 1's three unsafe answers after the rules: "cancelled" read as "done"; a room booking attached to the proposal with nothing reported as new; and an ambiguous note turned into a question that had lost the date the note gave.
- **The rules were written after seeing run 1's answers, and only help against the errors v1 makes.** They did nothing for run 2. Treat the 17/10/3 as a description of run 1, not as a measure of the rules.

### Scorer corrections

An earlier version of this page reported 20 pass, 8 question, 2 unsafe for run 1 after the rules, and said that no rule discards a change. Two reviews found the scorer too generous in three ways, one rule that did discard, and one metric that measured the wrong thing. All fixed:

- An empty answer to an ambiguous note counted as a pass. It loses the change, and is now "dropped": not a pass and not safe.
- A question counted as safe if it offered the right commitment, whatever it would do to it. It now has to be complete: commitment, kind of change, and date.
- Rule 2 turned a correct pair of updates into "which one?", and that was scored safe. The question now offers "all of them", and one question covers two expected changes only if it does.
- Rule 1 dropped a new commitment that had the wording of an updated one, which loses a real new commitment. It now asks, and two answers of run 1 that it used to pass are questions instead.
- "Order-sensitive" compared pass and fail only, so a case that guessed differently in each order and failed both was not counted. The page now reports two numbers: cases whose verdict changed, and cases whose selection changed.

## Decision: routing (2026-11-15)

Adopted after review. The experiment stops here and the work moves to capture, review and correction.

| Where | Linking runs | Prompt | Shown as |
|---|---|---|---|
| Demo workspace | In the cloud | v2 | Proposals to confirm |
| Private workspace | On the device | v1, with the app rules | Provisional proposals to confirm, with the alternatives visible |
| Private workspace, cloud assistance | In the cloud, only after an explicit opt-in that shows the note and the candidate commitments being sent | v2 | Proposals to confirm |

On both routes a model's answer becomes validated proposals, and a proposal changes accepted state only when the user confirms it. The cloud model asking when it is unsure does not justify accepting anything automatically.

What the evidence supports, and what it does not:

- Supported: in 58 cloud calls no wrong commitment was selected, and all 12 ambiguous calls came back as a request for clarification. One run.
- The cloud result stands at 54 passed and 4 unsafe under the question behaviour that was tested, in which a "which one?" question does not offer "all of them".
- Not established: that cloud linking is safe.

## Runtime validation

`src/reading.js`, with tests in `test/reading.test.mjs`. It sits between a model's answer and anything that writes. It is not yet called by the app.

`validateReading` refuses an entry, or the whole answer, when:

| Check | Example a model returned |
|---|---|
| The answer or an entry does not have the fields of the schema, or has others | Entries with `commitment_id` and `change_description`, and a date of `},{` |
| A commitment named is not one the model was given | Not seen: the schema's enum has held so far. Checked anyway |
| The kind of change does not fit what it is about | A listed commitment with the change "new commitment" |
| A new deadline has no date, or a new commitment does not say what it is | "Pushed back to next week" returned with an empty date |
| The quote is not in the note | A new commitment with an empty quote |
| One commitment is given two different changes | One commitment as new deadline, done and cancelled from one sentence |
| There are more than twelve entries for one note | Not seen at this size. The largest answer had nine entries for a seven-word note, and the conflict and field checks catch that one |

- An unknown key at the top of the answer is ignored and logged (the schema's own `required` leaked into five answers across the runs).
- The same entry twice is one entry, and only when every field is the same: two new commitments that differ in the owner alone ("Lee and Sam will each send the report") are two. A date on "done" or "cancelled" is dropped.
- **Whatever is refused goes to manual selection**: the user is shown the words, or the whole note when there are no usable words, with the reason, and links it by hand. A conflict is shown with the changes the answer gave.

`readNote` runs validation, then the three app rules, and returns proposals, new commitments, questions and manual statements. Every proposal carries the other listed commitments as alternatives, whatever the model returned. Every option of a question is a complete answer: a commitment option carries the change, date and quote, and a "new" option carries the whole new commitment as it was read (what, owner, recipient, date, quote), so choosing it needs no second reading.

**Completeness crosses the write boundary.** `toExtraction` returns the proposals as assertions together with `complete`, which is false whenever something from the reading is not among them: an entry was refused, a question is waiting, or a new commitment still needs its people matched. `recordExtraction` takes that flag and withdraws an earlier proposal only for a complete reading. Without it, a malformed re-reading produced an empty list of assertions and the earlier, valid proposal was withdrawn. A question the model asks itself offers every listed commitment, "none of these, it is new" and "all of them"; that last option is the app's behaviour from here on and is not what the cloud run was scored against.

Tested: each check above, the three points just described, and one path through to the store on the Node binding, where a validated answer becomes one proposal in the review queue, the refused and conflicting entries become manual statements, and the accepted commitments are unchanged.

Not done: matching the owner and recipient names of a new commitment to people, resolving dates, choosing the candidates from a larger store, and the review screen itself.

## Raw reports

Runs 1 and 2 are transcribed in `test/fixtures/`. The raw reports of runs 4 to 6 were not saved and are not to be reconstructed from the summaries above; that limits how far those runs can be audited. The page now has "Save as file", and every later run should be saved to `test/fixtures/`.

## Next

1. Capture, review and correction, per the schedule in `decisions.md`, built on `readNote` and the rules in `model.js`.
2. Still open before private-data use (from `data-model.md`): the model tests against the browser build, and an atomic or recoverable rejection path.
3. If the experiment is taken up again: repeat the cloud run, and write new held-out notes before changing any prompt or rule.

Not established by any of this: more than four candidates, how the candidates are chosen from a larger store, date resolution, whether Nano 3 behaves the same, and how much any of these numbers moves between runs.
