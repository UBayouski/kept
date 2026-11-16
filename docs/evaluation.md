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

## Dependencies, rounds 2 and 3

Each round was written after the previous one's results and before the fixes
it measures were run; `SET=round2 npm run eval` runs one.

**After round 1** the dependency prompt was told that sharing a word is not the
same action (with an example that is not one of the notes), the app refuses a
listed commitment as what is waited for when the words name someone else as
doing it, and "can't ... until" is never proposed as done or cancelled.

**Round 2** (12 new dependency notes, clean): 5 pass, 5 safe, 2 unsafe. The
dependency reading was right in 9 of 12. Most of what was left came from the
linking call: four times it also gave the dependency as a "new deadline" with
no date (a needless card to link by hand), twice it put the dependency into
the date ("after Dana signs off on it"), and once the waiting commitment was
mine where the words made Dana wait.

**After round 2:** a date that is a dependency keeps only its date part
("tomorrow after lunch" is tomorrow), a deadline with no date left in a note
that states a dependency is left to the dependency reading, and a listed
commitment is not what waits when the main clause's subject is someone else.

**Round 3** (10 new notes, clean): 6 pass, 2 safe, 2 unsafe. Both unsafe were
the linking call reading a dependency as done or cancelled ("Lee will confirm
pricing once ...", "The contract waits for ..."), which the "can't ... until"
rule was too narrow to catch.

**After round 3, not measured yet:** the rule now covers the future ("will",
"I'll") and "waits", "waiting", "blocked" as well.

**Variance.** Running round 2 again after its fixes gave 2 pass, 9 safe,
1 unsafe: the same model and notes give different answers from run to run (in
that run it often returned nothing for "can't ... until" notes). One run of
10 or 12 notes is a rough measure; differences of one or two notes between
runs are noise.

**After a live test on the hosted site** ("I'll send Dana the contract on
Monday, once Lee confirms pricing" made "Send the proposal" wait): a listed
commitment is what waits only if the note's main clause mentions it, and is
what is waited for only if the dependency's words do; and words right after
"until", "once" or "after" are a condition, never news that something is done.
Rounds 2 and 3 run again after the mention check (not clean): round 2 had 6 pass,
5 safe, 1 unsafe (that "until Lee confirms pricing" read as done, which the
condition rule now holds back); round 3 had 8 pass, 2 safe, 0 unsafe. The check
refused one wrong link and no right one.

**A second live finding:** with only "Send the proposal" and "Confirm pricing"
listed, "I'll send Dana the contract on Monday" was proposed as the proposal's
new deadline: when the right commitment is not in the list, the model picks
the nearest one. Now a change whose sentence does not mention the commitment
(a word of it other than the verb) is not proposed; it becomes a question:
that commitment, or something new. Round 1 run again after this (not clean):
36 pass, 4 safe, **0 unsafe**. "Sent Dana the document", unsafe in every
earlier run, is now asked about instead of guessed.

**Re-runs of round 1** after the fixes (not clean, for regressions): 35 pass,
4 safe, 1 unsafe; the one unsafe is still "Sent Dana the document".

## Device model, round 2

The private workspace's route: Chrome's built-in model (it says Gemma 4),
prompt v1 plus the app rules, run from `eval.html?route=device&set=round2` in
a real Chrome on 2026-11-16. Not clean: round 2 was used to tune the cloud
route, and the app rules apply to both. About 5 s a note, no cloud calls.

**12 notes: 2 pass, 6 safe, 4 unsafe** (cloud on the same notes, also not
clean: 6 pass, 5 safe, 1 unsafe).

- **Unsafe:** a new deadline on the contract from "After Priya reviews the
  budget, I'll send Dana the contract"; deadline words put on the budget from
  "blocked until Priya sends the numbers"; and twice a commitment made to wait
  on a new copy of itself ("I'll send Dana the proposal tomorrow, before
  lunch"; "The proposal for Lee waits until ...").
- **Mostly missed, not wrong:** 7 of 12 dependencies missed and 4 new
  commitments missed ("I can't book flights ...", "Sam will send me the
  mockups ..."). Five notes left something to link by hand.

The device route is usable for plain commitments (the live capture "I'll send
Dana the proposal by Friday" gave the right card in 6 s) but not yet for
dependencies. Its proposals are already marked provisional.

**Fixed after this:** the model's own "unclear" over the same words as a new
commitment it also gave was shown as two cards (seen live with an empty
store). It is now one question, or just the new commitment when nothing is
listed (rule 4).

## Device model, round 4 (clean)

12 new notes of every kind (`round4` in `src/evaluation.js`), committed in
`a4f5ce1` before any model saw them, after rules 4 and 5 and the "no waiting
on a copy of itself" check. Device route, run on 2026-11-16 in a real Chrome.

**3 pass, 9 safe, 0 unsafe**, no errors. Nothing wrong was proposed. What it
falls short on is asking instead of answering: 5 needless questions and 3
things to link by hand. It missed 3 new commitments (they came back as "which
one?" questions instead) and 3 of 4 dependencies.

One thing was fixed after this, and it is not measured yet: "Lee asked for the
proposal by Monday" got the right new deadline, and the same proposal again as
a refused "new commitment" with a one-click card. A refused new commitment
with the wording and recipient of a commitment that the same reading updates
is now dropped.

The first two attempts at this run failed on the evaluation's own store
(`opfs://kept-eval`): a run abandoned mid-note left it unable to write ("WAL
commit timestamp 1 must advance past 1"). Deleting the store fixed it. The
reset the evaluation does before each note does not recover from that state.

## Device model: fewer needless questions

**Diagnosis on round 1** (device, 2026-11-16): 12 pass, 27 safe, 1 unsafe,
23 needless questions. None of the 8 "something new" notes and none of the
4 "nothing to do" notes passed. The device model nearly always adds a change to some
listed commitment beside the right new commitment ("I'll send Sam the slides":
"unclear", or a deadline on "Review the budget"), and the rules turned each
pair into a question.

**Fix (device route only):** a change whose sentence mentions none of the
commitments it could be about, over the same words as a new commitment of the
same reading, is that new commitment said twice. The change is dropped.

**Round 1 again** (not clean, it was the diagnosis set): 20 pass, 16 safe,
4 unsafe, 9 needless questions. The rule only drops changes, so it cannot make
a wrong proposal. The 4 unsafe are the model's own errors ("called off" as
done; the deadline on the other proposal; a guessed "which proposal"; a wrong
dependency) and vary from run to run.

**Round 4 again** (not clean any more: the r4-1 fix came from it, but this
rule did not): 5 pass, 5 safe, 1 unsafe, 1 error (was 3, 9, 0). Needless
questions fell from 5 to 3. The unsafe answer: the model put the deadline "not
set" on "Book the venue". Placeholders like "not set" or "none" are now no
date, so the dependency rule holds that answer back. Not measured yet.

**Runaway answers.** The device model sometimes generates for minutes without
ending, and it answers one call at a time, so every later call waits. That was the
"hang" seen all day. A device call is now aborted after 45 s, which frees the
model (r4-5 timed out and the run went on).

## Device model, round 5 (clean)

Written and committed (2087f5f) after the fixes above, before any model saw
it. Device, 2026-11-16: **6 pass, 4 safe, 2 unsafe**, no errors, 4 needless
questions. Results: `eval/results/capture-round5-device-2026-11-16.json`.

- **New commitments:** 4 of 4 pass, cards filled in right, no question. In
  round 1 before the drop rule, none of 8 passed.
- **Deadline, cancelled:** pass.
- **Unsafe 1, a "nothing to do" note:** "Omar thinks the venue is too small."
  became "done" on Book the venue. The quote names the venue, so no rule holds
  it back. "Coffee with Sam" also got a "done" on the venue, asked about.
- **Unsafe 2, two things in one sentence:** "Lee confirmed pricing, so I'll
  send Sam the quote tomorrow." became a deadline on Confirm pricing; the new
  commitment and the "done" were missed.
- **Ambiguous:** "Dana wants it on Thursday instead." asked about the
  proposal only, not the contract. Safe, but not the question it needs.
- **Dependency:** the new "Send the guest list" was found, Dana's "Sign the
  contract" and the dependency were not.

**Timeouts.** The first attempt was stopped: its first two notes timed out
at 45 s each, and a bare "Say OK." then still waited 30 s. A minute later the
model loaded in 15 s and answered, and the second attempt ran with no timeout.
Whether the abort frees the model at once, or it was still loading cold, is
not settled.

## Device model: "done" and "cancelled" need words for them

**The rule (both routes, d4b1523 and c23dcf8):** a "done" is proposed or asked
about only when the sentence says something happened (a past tense, "done",
"out", "sorted"); a "cancelled" only when it says it is off ("called off",
"no longer", "anymore", "after all", "off"). Otherwise the reading goes to
"link by hand" with the reason. It answers round 5's two unsafe answers: "Omar
thinks the venue is too small." read as done, and in another run as cancelled.

**Runs after it** (device, 2026-11-16; neither set is clean for this rule):

| Run | Pass | Safe | Unsafe | Needless questions |
|---|---|---|---|---|
| Round 5, before the rule (clean) | 6 | 4 | 2 | 4 |
| Round 5, "done" rule only | 3 | 7 | 2 | 5 |
| Round 5, both rules | 2 | 10 | 0 | 3 |
| Round 1, before the rule | 20 | 16 | 4 | 9 |
| Round 1, both rules | 16 | 24 | 0 | 13 |

- In round 1 the rule held back 4 readings, all wrong: "no longer needs the
  contract" read as done, "Long day. Dana seemed tired." and "Lunch ... about
  football" read as done, and a "done" on a note that waits for pricing. No
  right "done" or "cancelled" was held back; status notes pass 5 of 6.
- The "done" rule alone missed "Lee won't need the proposal" because "need"
  ends in "ed"; "need" and similar words are no longer a past tense.
- Pass counts swing between runs of the same notes (round 5: 6, 3, 2) on new
  commitments the rule does not touch. The device model varies more than any
  rule changes; one run of a set is not a measurement of a small change.

## Device model, round 6 (clean, three runs)

Written and committed (fcb4551) after the "done"/"cancelled" rules, before
any model saw it; weighted to done, cancelled and nothing to do. Device,
2026-11-16:

| Run | Pass | Safe | Unsafe | Error |
|---|---|---|---|---|
| 1 | 5 | 5 | 2 | 0 |
| 2 | 5 | 4 | 2 | 1 (45 s timeout) |
| 3 | 4 | 8 | 0 | 0 |
| After the fix below (not clean) | 5 | 7 | 0 | 0 |

- **Unsafe, the same two notes each time:** "Dana liked the venue photos."
  and "Priya asked how the budget review is going." read as done, in 2 of 3
  runs. The "done" rule took any word ending in "ed" for something that
  happened; "liked" and "asked" passed it.
- **Fix (363d98d):** verbs of feeling, speaking and thinking ("liked",
  "asked", "mentioned", "worried" ...) do not say something was done. The run
  after it held both notes back.
- **Held back right:** "The contract for Dana is off" and "pricing is not
  needed any more" were read as done in two runs; the rule held them back
  (missed, safe) where before they would have been the wrong kind, unsafe.
- **Steady:** "done" with a real verb ("sorted out the venue"), the new
  deadline, the new commitment with a date: pass in every run.
- **Still missed:** a cancelled note the model reads as done is now linked by
  hand, not proposed as cancelled. The ambiguous "Sent Dana the file" was asked
  properly once in four runs.

## Open

- The word rules are a list of words: a "done" said in words not on it is
  held back (safe), and a feeling verb not on it can still pass as done.

- A clean round to measure the last rule (the future and waiting).
- Dependencies stay the least reliable part. The remaining errors are mostly
  the linking call answering about a dependency at all; a linking prompt that
  is told to leave dependencies alone is the next thing to try, measured on
  new notes.
- The device route: round 4 above is clean and has no unsafe answers; it
  needs fewer questions, and dependencies are still mostly missed. Since round 2, a commitment can no longer
  wait for one with its own wording (refused live on "I'll send Dana the
  proposal tomorrow, before lunch"), and a device read waits until its tab is
  shown and stops a call that takes over 45 s.
