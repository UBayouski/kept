# Capture evaluation

How reliably a pasted note becomes the right proposals, measured end to end:
the same code path as the review screen (`src/pipeline.js`), the real cloud
model, a real Relate store. The linking experiment
([linking-experiment.md](linking-experiment.md)) measured one model call in
isolation; this measures what the user would actually be shown.

## Method

- **Notes.** 40 notes in seven groups, in `src/evaluation.js`: a new deadline
  on one commitment (8), done or cancelled (6), something new (8), nothing to
  do (4), ambiguous (4), several things in one note (4), dependencies (6).
  They were written on 2026-11-15 before any model saw them and are not used
  to tune anything. A change made because of a result here needs new notes to
  measure it.
- **Workspace.** Each note is read into a freshly built store holding six
  confirmed commitments, with two pairs that are easy to confuse: "Send the
  proposal" and "Send the contract", both owed to Dana; and "Send the
  proposal" owed to Dana and to Lee. All six are offered to the model.
- **Time.** Every note is from Wednesday 2026-11-25, so "Friday" has to become
  2026-11-27.
- **Path.** Linking call (prompt v2), validation and the app rules, the
  dependency call when the note has a dependency word, the store rules. The
  cards a note leaves for the user are part of the output.
- **Running it.** `npm run eval` drives `eval.html` in headless Chromium
  through Playwright with an App Check debug token from `.env.local`, and
  saves the raw report in `eval/results/`. Calls are spaced 4.5 s apart for
  the free tier's 15 requests a minute.

## Verdicts

- **pass:** exactly what the note means. Every change on the right commitment
  with the right date; every new commitment found, its card filled in with the
  right owner, recipient and date; every dependency; the question an
  ambiguous note needs; nothing else.
- **safe:** nothing wrong is proposed. Something may be missed, asked about
  needlessly, or left on a card that needs correcting, but accepting every
  proposal would not be a mistake.
- **unsafe:** something wrong is proposed: the wrong commitment, kind or date,
  a guess where the note is ambiguous, or a dependency the note does not state.

A card is not a proposal: the user fills it in before anything is proposed, so
a card filled in wrong is counted separately (`cardErrors`), not as unsafe.
The wording of a new commitment is compared loosely (most of the expected
words present); owner, recipient and date exactly.

## Results

Cloud model `gemini-3.5-flash-lite`, linking prompt v2. Raw reports in
`eval/results/`. Linking calls took 0.9 s at the median, 1.8 s at most.

| Run | Pass | Safe | Unsafe | Errors |
|---|---|---|---|---|
| 1, 2026-11-15 (clean) | 33 | 4 | 3 | 0 |
| 2, 2026-11-15, after the fixes below (not clean) | 35 | 2 | 3 | 0 |

Run 1 is the measurement. Run 2 came after fixes made because of run 1, so
for those notes it is no longer an independent measure; it is reported to
show nothing else changed.

### Run 1, every note that did not pass

| Note | Verdict | What happened | Whose error |
|---|---|---|---|
| c4 "Dana asked me to draft the press release by Tuesday." | safe | The card said Dana owes it to me | The app's guess at the people |
| c7 "Sam will review my draft by Thursday." | safe | The card had no recipient | The app's guess |
| g5 "Once Omar books the venue, I'll send out the invitations by Monday." | safe | The card said the invitations go to Omar | The app's guess |
| f1 "Dana wants both the proposal and the contract by Tuesday." | safe | A question with "All of them" instead of two proposals; one click gives the right answer | Model ("unclear") |
| e2 "Sent Dana the document." | unsafe | Marked "Send the proposal" done; the note could mean the contract | Model guessed |
| g3 "I'll send Sam the slides Friday, after Priya approves the budget." | unsafe | The slides were made to wait for "Review the budget", which is the user's own review, not Priya's approval | Model, dependency call |
| g4 "The venue can't be booked until Dana confirms the date." | unsafe | Proposed "Book the venue" as cancelled; the dependency itself was read right | Model, linking call |

### Fixed after run 1

The three card errors were the app's own guessing, not the model's:
"X asked me to ..." now means the user owes it to X; "my" with one other
person named means it comes back to the user; and a note that starts with the
dependency ("Once Omar books the venue, I'll ...") is read from its main
clause. Each fix has tests on new sentences, not these. In run 2 all eight
new-commitment notes passed and no card was filled in wrong.

### Run 2

The same three notes were unsafe, for the same reasons; in e2 the model
guessed the other commitment this time ("Send the contract"), so the guess
is not even stable. f1 and f2 got a question where two proposals were right;
both questions contain the right answer.

## What this says

- **Clear notes work.** Every clear deadline, done, cancelled, new and
  nothing note passed in both runs (26 of 26 in run 2), including the two
  pairs of easy-to-confuse commitments.
- **Unsafe is 3 of 40, and all three are the model's.** Each is a proposal
  the user still has to accept, shown with the quote it rests on. Nothing is
  applied without that, which is why the review step stays mandatory.
- **Ambiguity mostly works:** 3 of 4 ambiguous notes got the question in both
  runs. "Sent Dana the document" did not.
- **Dependencies are the weakest part** (4 of 6). The dependency prompt picks
  a listed commitment when one shares a word ("the budget"), and the linking
  prompt can read "can't be booked until" as cancelled.

## Open

- A second, clean set of notes to measure the fixes and any prompt change
  made because of these results.
- The private workspace route (device model, prompt v1 with the app rules) has
  not been run through this evaluation.
