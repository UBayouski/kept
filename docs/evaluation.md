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

## Device model: an empty deadline beside a new commitment

**The rule (15ab92c, both routes):** the device model often adds a "new
deadline" with no date beside a right new commitment ("I promised Priya the
slides."). That entry was refused and sent to "link by hand", so the note could
not pass. When the same reading has a valid new commitment, the empty deadline
is now dropped and only recorded in the log.

**Runs after it** (device, 2026-11-16; not clean, the notes it came from):

- Round 6: 4 pass, 8 safe, 0 unsafe. "Sam promised me the logo files." passes.
- Round 5: 3 pass, 9 safe, 0 unsafe. "I promised Priya the slides." passes.
- An empty deadline with no new commitment beside it ("Dana liked the venue
  photos.") is still refused and linked by hand, as before.
- Most of what still does not pass is a needless question beside the right
  answer (6 in round 5 this run), and it varies from run to run.

## Fewer needless questions: three app rules (39e07f8)

- **Rule 2, one named:** the same change from the same words on several
  commitments ("Omar sorted out the venue" as done on the venue and on
  pricing) is that one change when the words name exactly one of them.
- **A guess asks among the same person:** a change whose words do not name its
  commitment was a question "that one, or new". It now also offers the other
  commitments owed to the same person (not "me"): "Sent Dana the file" asks
  about the proposal or the contract, the question the note needs.
- **"It" looks back:** "Dana has the contract; I sent it" checks "it" against
  the clause before.
- The replayed first device run: 17 to 19 pass, unsafe still 3.

**Device runs after it** (2026-11-16, after a Chrome restart; not clean):

| Set | Pass | Safe | Unsafe | Needless questions |
|---|---|---|---|---|
| Round 6 | 5 | 7 | 0 | 2 |
| Round 5 | 5 | 7 | 0 | 4 |

The ambiguous note passed in both: "Sent Dana the file this morning." and
"Dana wants it on Thursday instead." were asked about correctly; before, they
were asked properly once in seven runs. All 4 new commitments in round 5 passed.

**Cloud, round 6** (2026-11-16): stopped by the daily free quota (500).
Of the notes that ran across two attempts, all 6 passed, including "Dana liked
the venue photos." as nothing; 3 failed on the quota and 3 did not run.

## Device model, round 7 (clean, three runs)

Written and committed (0c647df) after every rule above and the cleanup of
the "what" (636023d: other fields cut out of it; done/cancelled words looked
for across a semicolon), before any model saw it. Device, 2026-11-16:

| Run | Pass | Safe | Unsafe | Error |
|---|---|---|---|---|
| 1 | 6 | 6 | 0 | 0 |
| 2 | 6 | 4 | 1 | 1 (45 s timeout) |
| 3 | 5 | 7 | 0 | 0 |

- **Steady passes:** "I finished it last night" across a semicolon, "called
  off", a new deadline, both new commitments in most runs, and the ambiguous
  "Dana got it yesterday." asked about the proposal or the contract (2 of 3).
- **The unsafe answer:** "Dana mentioned the contract template looks dated."
  read as done on the contract; "dated" passed as a past tense.
- **A needless question in 2 of 3 runs:** "Lee would like the proposal by
  Friday." gave the deadline to both proposals, and rule 2 asked which.
- **Fix after it (not measured yet):** an "-ed" word after "looks", "seems",
  "sounds", "feels" or "appears" describes, it does not say anything was done;
  and when the words name two commitments of the same wording, the person they
  name decides ("Lee" picks the proposal for Lee).

## A stuck device model (745a66d)

Three times on 2026-11-16 the device model stopped answering altogether, also
to a bare "Say OK." in a new tab, until Chrome was restarted; stopping the
call at 45 s did not free it. After a timeout the app now makes one short
check (15 s). If that does not answer either, the read fails with "Chrome's
on-device model is stuck ... Restart Chrome", and every later device read
fails at once with the same message instead of waiting 45 s. Seen live on
round 8: the first note took 60 s, the other 11 failed at once.

## Device model, round 8 (clean, three runs)

Written and committed (345d659) after b90c010, before any model saw it.
Device, 2026-11-16, after a Chrome restart:

| Run | Pass | Safe | Unsafe |
|---|---|---|---|
| 1 | 6 | 5 | 1 |
| 2 | 3 | 9 | 0 |
| 3 | 6 | 5 | 1 |

- **b90c010 held:** "seems overpriced" and "sounded stressed" were held back
  in every run; the ambiguous "Dana pushed it back to Monday." was asked
  properly in all three.
- **Unsafe 1:** "Priya dropped the budget review." read as done ("dropped" is
  a past tense).
- **Unsafe 2:** "Lee will share the contract draft with me tomorrow." read as
  a deadline on "Send the contract" (to Dana).
- **Needless question, 2 of 3 runs:** "Dana would like her proposal on
  Monday." gave the deadline and also a new "Send the proposal for Dana".
- **Fixes after it (d335cea, not measured):** a "done" whose words say it is
  off is not proposed; a change whose words name people, none of them the
  commitment's, is asked about (this also turns the old "twin" test case from
  unsafe to a question); on the device, a new commitment with the wording and
  person of a commitment the same words update is dropped.

## Device dependencies: diagnosis and fix

Round 2 (12 dependency notes) on the device, with every raw answer read:
0 pass, 9 safe, 3 unsafe, 9 dependencies missed, 3 wrong.

- The dependency call ran for every note: the trigger is not the problem.
- **All 3 wrong ones came from the linking call:** the device model gives a
  listed commitment again as new ("budget review" for "Review the budget";
  "Book the venue"; "Send the proposal"), and the dependency was put on the
  copy. Once it also chose Dana's proposal for "The proposal for Lee waits".
- **Most misses:** the dependency answer used wrong labels and the existing
  checks refused it, which is safe.

**Fix (80bf35c and the next commit):** a dependency on a new commitment that is a
listed one in the same words (any order; one word more only when it names the
same person) is on the listed one; and when the words about what waits name
people, none of them the waiting commitment's, the one of the same wording
that has that person waits instead, or the dependency is refused.

**Round 2 again** (not clean): 4 pass, 5 safe, 2 unsafe, 1 timeout; 7 of 12
dependencies right, 1 wrong (was 0/9/3, about 2 right). The remaining wrong
one ("Send the budget review", one word more) is what the next commit covers.

## Device model, round 9 (clean, three runs)

Written and committed (9ab0663) after d335cea and the dependency fixes, before
any model saw it; a third of it dependencies. Device, 2026-11-16:

| Run | Pass | Safe | Unsafe | Dependencies missed / wrong |
|---|---|---|---|---|
| 1 | 5 | 7 | 0 | 2 / 0 |
| 2 | 6 | 6 | 0 | 2 / 0 |
| 3 | 5 | 6 | 1 | 1 / 0 |

- **Steady passes:** deadlines (both proposals told apart by "his"), "wrapped
  up" as done, the ambiguous "Sent it to Dana an hour ago." asked properly in
  all three; "I can't send Dana the proposal until Lee confirms pricing." found
  its dependency in all three. No wrong dependency in any run.
- **The unsafe answer:** "Sam will send me the budget template on Friday." as
  a deadline on "Review the budget". The person rule knew only the people of
  listed commitments, and none has Sam.
- **Missed in all three:** "Priya's budget review has to wait until Omar books
  the venue." The model's dependency was right, but a check took "Priya's" for
  the one who does the review and refused it.
- **Fixes after it (not measured):** every person in the store counts for
  the person rule, not only those on listed commitments; and a possessive
  ("Priya's ...") at the start is not who does what waits.

## Cloud model, round 7

Cloud route (gemini-3.5-flash-lite), 2026-11-16, at 8dd2ae8: **12 pass, 0 safe,
0 unsafe**, no needless questions, about 24 requests. Every rule added today
for the device route applies on this route too, and none of them cost a pass.
Not fully clean: two rules (b90c010) came from the device runs of these notes.

## Device model, round 10 (clean, three runs)

Written and committed (21c1f53) after 8dd2ae8, before any model saw it;
weighted to people on no listed commitment and to possessives. Device,
2026-11-16, after a Chrome restart:

| Run | Pass | Safe | Unsafe | Dependencies missed / wrong |
|---|---|---|---|---|
| 1 | 3 | 8 | 1 | 1 / 1 |
| 2 | 4 | 8 | 0 | 1 / 0 |
| 3 | 5 | 7 | 0 | 0 / 0 |

- **8dd2ae8 held:** "Dana's contract has to wait until Lee confirms pricing."
  and "Omar's venue booking waits until I send the deposit." found their
  dependency in all three runs; the Sam notes were never proposed on a listed
  commitment.
- **Needless question in all three:** "Sam will email me the venue options
  on Monday." (and "the pricing sheet"): the model gave a deadline on the
  venue and Sam's new commitment; the app asked between them.
- **The unsafe answer:** "I'll review Priya's budget once Lee confirms
  pricing." with a new "Review Priya's budget": the copy was not matched to
  "Review the budget" because of the name, and the dependency went on it.
- **Fixes after it (not measured):** a change whose words name only someone
  not on that commitment gives way to that person's new commitment from the
  same sentence; and a person's name and "'s" are left out when a new
  commitment is compared with the listed ones for a dependency.

## Device model, round 11 (clean, three runs)

Written and committed (0280cbc) after d19c279, before any model saw it;
weighted to someone else's new commitment and to dependencies with a person's
name in them. Device, 2026-11-16:

| Run | Pass | Safe | Unsafe | Dependencies missed / wrong |
|---|---|---|---|---|
| 1 | 6 | 6 | 0 | 0 / 0 |
| 2 | 6 | 6 | 0 | 0 / 0 |
| 3 | 6 | 6 | 0 | 1 / 0 |

- **d19c279 held:** "I'll send Dana's contract once Lee confirms pricing." and
  "I'll send Lee's proposal after Omar books the venue." put the dependency on
  the listed commitment in 5 of 6 readings, never on a copy. "Sam will send
  me the budget numbers by Monday." passed in all three.
- **Steady passes:** the deadline, "Priya got my budget review", the ambiguous
  "Dana said it can wait until Tuesday." (asked properly in all three), the
  new commitment with a date.
- **Left over:** "Lee no longer needs to confirm pricing." read as done in all
  three, held back (safe) but not offered as cancelled; the copy of a listed
  commitment still shows as its own card ("Send Lee's proposal") beside the
  right dependency; "Sam will call me about the venue" was asked about in 2 of 3.

**Today on the device, clean rounds only:** unsafe answers per run went from
2 (round 5) to 0 in all three runs of round 11; passes from about 4 to 6 of 12.

## Cancelled in one click, no card for a copy (c9f6f4c, 04e02f8)

- A "done" whose words say it is off ("no longer", "dropped", "called off")
  is proposed as cancelled, through the same checks as any cancelled reading.
- A new commitment that is a listed one said again, beside a dependency on
  the listed one, no longer shows as its own card, nor as a "new or the same"
  question.

**Round 11 again** (not clean, it showed both): 6 pass, 6 safe, 0 unsafe, no
extra card, dependencies 0 missed and 0 wrong. "Lee no longer needs to
confirm pricing." and "I'll send Lee's proposal after Omar books the venue."
now pass.

## Device model, round 12 (clean, three runs)

Written and committed (a612baf) after c9f6f4c and 04e02f8, before any model
saw it; weighted to cancelled notes and dependencies on listed commitments.
Device, 2026-11-16:

| Run | Pass | Safe | Unsafe | Dependencies missed / wrong |
|---|---|---|---|---|
| 1 | 5 | 7 | 0 | 1 / 0 |
| 2 | 8 | 3 | 1 | 0 / 0 |
| 3 | 8 | 3 | 1 | 0 / 0 |

- **c9f6f4c held:** "no longer has to", "dropped", "called off" passed as
  cancelled in 8 of 9 readings (the other was asked about).
- **Dependencies:** both passed in runs 2 and 3, none wrong in any run; no
  copy card left beside them.
- **The unsafe answer, twice:** "I'll call Priya about the budget tomorrow."
  as a deadline on "Review the budget". A note written to test exactly this.
- **Fix after it (not measured):** a commitment the words name only after
  "about" or "regarding" is asked about (that one, or new), not changed.

## Device model, round 13 (clean for runs 1 and 2)

Written and committed (c47a7cc) after 659c252, before any model saw it;
weighted to listed commitments named only as what something is about.
Device, 2026-11-16:

| Run | Pass | Safe | Unsafe | Error |
|---|---|---|---|---|
| 1 | 4 | 7 | 0 | 1 (45 s timeout) |
| 2 | 4 | 7 | 1 | 0 |
| 3 (with d440b4f) | 5 | 7 | 0 | 0 |

- **659c252 held:** "I'll email Lee about the proposal", "Omar will ring me
  about the venue", "I'll ask Priya about the budget" were never proposed as
  a change to the proposal, venue or budget; they were asked about. They do
  not pass: the device model gives a change, not the new commitment, so the
  question's "new" has to be filled in by hand.
- **The unsafe answer (run 2):** "Sent Dana the contract after lunch."
  "After" started the dependency call, which made up a new "Send the proposal"
  for the contract to wait for.
- **Fix (d440b4f, run 3 had it):** something new to wait for has to be named
  in the words of the dependency ("after lunch" names no proposal); "it" and
  "them" still count.
- **Not asked:** "Dana asked for it on Tuesday." gave a vague new commitment
  ("Send something", "Send item") for Dana instead of a question.

## Device model, round 14 (clean, three runs)

Written and committed (09e8b37) after d440b4f and 9ce2c22, before any model
saw it; with time words that are not dependencies and "it". Device,
2026-11-16:

| Run | Pass | Safe | Unsafe | Dependencies missed / wrong |
|---|---|---|---|---|
| 1 | 9 | 2 | 1 | 0 / 0 |
| 2 | 9 | 3 | 0 | 1 / 0 |
| 3 | 8 | 4 | 0 | 1 / 0 |

- **The best device round so far.** "Sent Lee the proposal before lunch." and
  "Omar booked the venue after the call." passed in all three; both "it"
  notes ("Dana wants it by Thursday now.", "Gave it to Dana this morning.")
  were asked properly in all three.
- **The unsafe answer:** "Dana and I discussed the proposal over coffee." as
  done: "over" was a "finished" word.
- **Fix (not measured):** "over" and "out" say it is finished only after
  "is", "was", "went" and the like ("it went out", "the meeting is over").
- **Missed in 2 of 3:** "I can only book the caterer after Omar books the
  venue." The new commitment was not given, so there was nothing to wait.

## Device model, round 15 (clean, three runs)

Written and committed (8599c74) after the "over"/"out" fix, before any model
saw it. Device, 2026-11-16: **7/4/1 in all three runs.**

- **Unsafe, 2 of 3:** "Lee and I went over the pricing on the phone." as done
  on pricing: "went over" passed the new "went ... over" words. Written to test
  that weak spot.
- **Unsafe, 1 of 3:** "I sent the contract to Dana, and Lee wants his proposal
  by Friday." put the deadline on Dana's proposal: the sentence names Dana too,
  so the person rule did not fire.
- **Steady:** "The contract went out to Dana yesterday.", "Omar has until
  Thursday", "won't need ... after all", "received my budget review"; the
  dependency on pricing in all three.
- **Fixes (not measured):** "over" says it is finished only after "is", "was"
  and the like, not "went"; and the person rule reads the quoted words first,
  and when they name the person of the one other commitment of the same
  wording, that one is meant (this also turns the old twin test into a pass).

## Device model, round 16 (clean, three runs)

Written and committed (6d43758) after 4987ddd, before any model saw it.
Device, 2026-11-16: **6/5/1, 6/5/1, 7/4/1.**

- **The unsafe answer, every run:** "Lee's proposal can wait until Monday."
  "Until" started the dependency call, which made up a new "Wait until
  Monday" for the proposal to wait for. d440b4f did not stop it: "until" and
  "Monday" are in the words.
- **4987ddd held:** "Dana wants the contract by Monday, and Lee wants his
  proposal by Tuesday." passed in all three; "Omar went over the seating plan
  with me." was never done.
- **Word lists:** "Lee's pricing came through this morning." was held back
  in all three ("came through" is not on the list): safe, missed.
- **Fixes (not measured):** something to wait for that is only a time
  ("wait until Monday", "lunch") is refused; a new commitment whose "what" is
  "None" says nothing.

## Device model, round 17 (clean, three runs)

Written and committed (ab7649a) after 252724d, before any model saw it.
Device, 2026-11-16: **6/5/1, 5/7/0, 5/7/0.**

- **252724d held:** "Dana's contract can wait until Tuesday." passed as a
  deadline in 2 of 3, with no made-up dependency in any run.
- **The unsafe answer (run 1):** "Lee came back with the pricing today." as a
  deadline of today on pricing.
- **Noise:** "Dana is on holiday until Monday." once came back with every
  listed commitment again as new.
- **Fixes (not measured):** a deadline of today, this morning or yesterday,
  from words with nothing ahead in them, is not proposed; on the device, a
  new commitment with a listed one's wording, from words that do not mention
  it, is dropped.

## Open

- "About" notes: the right answer is a new commitment, which the device
  model rarely gives; the question then has an empty "new".
- A vague new commitment ("Send something") for a note that says "it": fixed
  in 9ce2c22 (it becomes the question among that person's commitments, with
  the change the words give). Round 13 again (not clean): 6 pass, 6 safe,
  0 unsafe; the model gave a change that run, so the older same-person rule
  asked the question, and the new rule was not exercised live.
- "Sam will call me about the venue tomorrow." is still asked about.
- "Omar scrapped the venue booking." read as done is now held back (safe),
  but not offered as cancelled.
- Round 6 on the cloud route: 6 of 12 ran (all pass) before the quota ran out.
- Needless questions left on the device route: a change on an unrelated
  commitment beside a right deadline (rounds 5 and 6, one each), and a
  "done" on small talk ("Coffee with Sam") asked about everything.
- The model sometimes writes the card's fields into "what" ("Send the case
  study. owner: me. to: Lee"); the scorer counts it as the right thing.
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
