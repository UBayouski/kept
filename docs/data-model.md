# Commitment and evidence model (revision 6)

Written 2026-11-15 and revised five times the same day after five reviews. The write rules now exist as code in `src/model.js`, with tests in `test/model.test.mjs`. They are not wired into the app, have not run in the browser build, and have not been driven by a model.

## What the model has to support

From `decisions.md`: each commitment needs an owner, a deadline where known, a status, the source passage, capture and source dates, and links to dependencies and to statements that supersede earlier ones. Extracted suggestions must stay distinguishable from facts the user confirmed. Ambiguous owners or dates become review items.

The four core questions:

1. What do I owe before Friday?
2. Which commitments are waiting on someone else?
3. What changed since the last client meeting?
4. Why does the app think this is my responsibility?

Added on 2026-11-18, from the user's own notes: **What do others owe me?**
(`owedTo` in `src/model.js`): open commitments to the user owed by someone
else, each with the user's own open commitments it holds up (`BLOCKED_BY`).

**Why?** also shows the commitment's history (`historyItems` in
`src/review-data.js`): every change on it with its words, note and decision,
and, read through `BLOCKED_BY`, when something it waits for became done,
cancelled or open again. Those lines are derived, not stored on it.

## The rules the model is built on

1. **The commitment holds the accepted state, and only that.** Its owner, deadline, status and blockers are what the user accepted. A newly extracted commitment is the one exception: it is stored as it was read and marked `unreviewed`, since it replaces nothing.
2. **Every change is a record of its own.** A model's suggestion to change an existing commitment is a proposed change and does nothing until the user accepts it. The change records are also the history and the evidence.
3. **Each current value points at the change that set it.** Accepted history and applied state are not the same thing: a change can be accepted as true without becoming the current value. So the commitment carries an explicit reference, per value, to the change that established it.

## Nodes

| Label | Properties | Notes |
|---|---|---|
| `Person` | `id`, `name`, `aliases` (list), `isMe` (boolean) | Exactly one person has `isMe: true`. Matched by `id`, never by name alone |
| `Note` | `id`, `kind` (`meeting`, `message`, `note`), `text`, `textHash`, `capturedAt`, `occurredAt` (optional), `occurredPrecision` (`time`, `day`), `sourceUrl` (optional), `extractedBy` | One captured source. Every capture gets its own `id`, even when the text is identical to another note. `textHash` only drives a "you may have captured this already" prompt |
| `Commitment` | `id`, `what`, `status` (`open`, `done`, `cancelled`), `review` (`unreviewed`, `confirmed`), `due` (date, optional), `dueText`, `issues` (list) | Accepted state. One current deadline, by construction |
| `Change` | `id`, `kind`, `field`, `state` (`proposed`, `accepted`, `rejected`), `applied` (boolean), `source` (`extracted`, `manual`), `basedOn`, `key`, `recordedAt`, `decidedAt`, `effectiveAt` (optional), `effectivePrecision`, `quote`, and the new value where there is one (`due`, `dueText`) | One assertion about one commitment |

Change kinds, and the current value each replaces (`field`):

| Kind | Replaces |
|---|---|
| `created` | Sets owner, deadline and status of a new commitment |
| `deadline` | `due`. With `clear`, removes the deadline |
| `owner` | `owner`. Cannot be cleared: a commitment always has an owner |
| `recipient` | `to`. With `clear`, removes the recipient |
| `completed`, `cancelled`, `reopened` | `status` |
| `blocked`, `unblocked` | One dependency, tracked per pair of commitments as `blocker:<id>`, removals included |
| `evidence` | Nothing: another passage supporting an existing commitment |

Fields of a change that carry the rules:

- `applied`: whether it became a current value. An accepted change with `applied: false` is history only.
- `basedOn`: the id of the change that had set that value when this one was proposed. If the commitment now points at a different change, the proposal is stale.
- `key`: what makes two assertions from the same note the same assertion, for example `deadline|<commitment id>|2026-11-24`.
- `recordedAt` is when the app learned it. `effectiveAt` is when it happened: the note's `occurredAt` for an extracted change, the time of the user's action for a manual one.

## Relationships

| Pattern | Meaning |
|---|---|
| `(:Person)-[:OWES]->(:Commitment)` | Who has to do it (accepted state) |
| `(:Commitment)-[:TO]->(:Person)` | Who it is owed to (accepted state) |
| `(:Commitment)-[:BLOCKED_BY {setBy}]->(:Commitment)` | It cannot be done until the other one is (accepted state). `setBy` is the id of the change that added it |
| `(:Commitment)-[:ESTABLISHED_BY {field}]->(:Change)` | The change that set the current `owner`, `to`, `due` or `status`, or that last added or removed the dependency on one blocker (`blocker:<id>`). At most one per field |
| `(:Change)-[:ON]->(:Commitment)` | The commitment the change is about |
| `(:Change)-[:FROM]->(:Note)` | The note it was read from. Absent for a manual change |
| `(:Change)-[:NAMES]->(:Person)` or `(:Commitment)` | The owner a `created` or `owner` change asserts, or the blocker a `blocked` or `unblocked` change refers to |
| `(:Note)-[:INVOLVES]->(:Person)` | Who the conversation was with |

Each change carries the exact quote for the one thing it asserts, so ownership, a deadline and a dependency each have their own passage.

## Write rules

Implemented in `src/model.js`.

**A decision is never applied on top of state it did not see.** Two mechanisms, both tested:

- Write operations on the same database handle run one after another, start to finish.
- The statement that applies a change also checks, inside that statement, that the change is still proposed and that the current value is still the one the decision was made against. If not, nothing is written and the decision is made again. This holds even for callers that do not share the queue.

**Accepting a proposed change** has one of these outcomes:

| Outcome | What happened |
|---|---|
| `applied` | The commitment carries the new value and its `ESTABLISHED_BY` reference now points at this change |
| `recorded` | Accepted as true but not made current: supporting evidence, or a change older than the current value |
| `stale` | The value it was proposed against has been replaced since. Nothing changed. The user has to look at the current value and confirm again |
| `cycle` | The dependency would loop. Nothing changed |

- **Competing proposals:** two proposals for the same value are both shown in review, marked as conflicting. Accepting one makes the other stale, so it cannot replace the newly accepted value without a second, explicit confirmation.
- **Backdated notes:** a change whose `effectiveAt` is known to be earlier than that of the change that set the current value is recorded as history only. The user can choose to apply it anyway.
- **Ordering of manual changes:** a manual change is ordered by the time the user made it. A note from before that time does not undo it.
- **Unknown order:** a note with no source date, or two times on the same day where one is known only to the day, has no known order. Such a change applies when accepted; it is never silently treated as older.
- **Dependencies follow the same checks.** Adding and removing a dependency on one blocker are changes to the same value, so a proposal to add it is stale once that dependency has been added or removed since, and a note older than a manual removal does not bring it back.
- **Rejecting** keeps the change as `rejected`. Rejecting a `created` change removes the commitment, which was never confirmed, and rejects everything proposed on it.
- **Removal is guarded.** If the user has already made a decision on that commitment (a manual correction, an accepted change), or another commitment depends on it, rejecting it removes nothing and returns those consequences. Only an explicit second confirmation removes it; each dependent then gets an `unblocked` change in its own history with the reason. That confirmed path is several statements and is not atomic.
- **Manual actions** (ticking done, correcting an owner) are changes with `source: 'manual'` and no note, applied at once. They appear in the history like any other.
- **Dependencies:** a blocker that is done stops blocking, and a chain is not followed through it. A cancelled blocker is reported as cancelled, and nothing behind it is.

**Reading a note again** (for example with the other model):

- An assertion is matched to an earlier one from the same note by its `key`. If it was already made with the same values, in any state, it is skipped. So an accepted or rejected decision stands and nothing is proposed twice.
- **The same new commitment read with a different deadline or recipient** is not skipped. If nobody has acted on the earlier proposal, the proposal is refreshed to the new reading. If the user has already confirmed or edited it, the difference is proposed as a separate correction and nothing moves until that is accepted.
- **Each new commitment in a reading is its own commitment**, even when two have the same wording and owner ("send report" to Dana on Friday and to Lee on Monday). Its key is the wording and owner plus a number. When the note is read again, new commitments are matched within the same wording and owner: first to an earlier one with the same recipient and deadline, then to the closest remaining one, with recipient counting for more than deadline, in reading order. One left over is new. The order the model lists them in does not matter.
- **A deadline is compared by its resolved date, or by its words when there is no date.** "Tuesday" after "Friday" is a different reading even though neither has a date yet.
- **A reading that drops a confirmed deadline or recipient** proposes its removal as a reviewable change (`clear`). Nothing is removed until that is accepted, and a rejected removal is not proposed again.
- A proposal from the earlier reading that the new reading no longer makes is withdrawn. A new commitment is never withdrawn once the user has acted on it or something depends on it; it is reported as kept.
- **A refused assertion is not an omission.** The reading may have meant an earlier proposal and got a reference wrong. A reading with anything invalid in it withdraws nothing; the proposals it did not repeat are reported as kept, with that reason.
- Matching is within one note. The same words in another conversation are another note with its own assertions.
- **Every reference in an assertion is validated before anything is written.** A commitment, whether the subject of a change or a blocker, has to be in the candidate list sent to the model, or be a new commitment of the same reading, which the reading names by a local `ref`. People have to exist. Two new commitments cannot claim the same `ref`. Anything else is refused with a reason.

## The demo scenario in this model

1. Monday meeting, "I'll send Dana the proposal Friday, once Lee confirms pricing."
   Two new commitments, unreviewed until confirmed: Me owes "Send the proposal" to Dana, due Friday. Lee owes "Confirm pricing" to Me. The first is blocked by the second.
2. Wednesday message, "Lee's pricing is delayed until Monday."
   A proposed `deadline` change on "Confirm pricing". Nothing moves until it is accepted.
3. Thursday meeting, "Dana agreed we can send the proposal Tuesday."
   A proposed `deadline` change on "Send the proposal". Until it is accepted the proposal still shows as due Friday, with a pending change beside it.

## The core questions as queries

The full queries are in `src/model.js`. Every one returns the ids of the records it describes, so a review action targets the right record and two commitments with the same wording stay separate rows.

**1. What do I owe before a date** (`owedBefore`)

```cypher
MATCH (:Person {id: $personId})-[:OWES]->(c:Commitment {status: 'open'})
WHERE c.due <= date($date) OR c.due IS NULL
OPTIONAL MATCH (p:Change {state: 'proposed'})-[:ON]->(c) WHERE p.kind <> 'created'
RETURN c.id, c.what, c.due, c.dueText, c.review, count(p) AS pendingChanges
```

Commitments without a resolved date are returned too and shown apart.

**2. Waiting on someone else** (`waitingOn`)

```cypher
MATCH (:Person {id: $personId})-[:OWES]->(c:Commitment {status: 'open'})
MATCH path = (c)-[:BLOCKED_BY]->+(b:Commitment)
WHERE b.status <> 'done' AND all(step IN nodes(path)[1..-1] WHERE step.status = 'open')
MATCH (w:Person)-[:OWES]->(b) WHERE w.id <> $personId
RETURN DISTINCT c.id, c.what, c.review, b.id, b.what, b.status, b.review, b.due, w.id, w.name
```

Every blocker passed through on the way has to be open. The last one may be cancelled, and is then reported as such.

**3. What changed since the last meeting** (`meetingBaseline`, `changesSince`)

The baseline is the latest note of kind `meeting` with that person that had happened when the question is asked, with "the previous meeting" as an explicit option.

The changes are everything the app learned after that meeting took place, leaving out what the meeting's own note said:

```cypher
MATCH (ch:Change)-[:ON]->(c:Commitment)
WHERE ch.recordedAt > datetime($since) AND ch.state <> 'rejected' AND ch.kind <> 'evidence'
OPTIONAL MATCH (ch)-[:FROM]->(n:Note)
WITH ch, c, n WHERE n IS NULL OR $baselineNoteId IS NULL OR n.id <> $baselineNoteId
RETURN ch.id, c.id, c.what, ch.kind, ch.state, ch.applied, ch.source, ch.due, ch.quote, n.id,
       ch.recordedAt AS learned, ch.effectiveAt AS happened
```

- "Changed" means **what the app learned since**, not what happened since. The UI has to say so in those words, and show the source time beside each row.
- The filter is on `recordedAt`, which every change has, so undated notes and old notes pasted in late are not lost.
- Proposed changes are listed and marked as proposed. Supporting evidence is not a change and is listed with the commitment.
- **A meeting known only to the day** keeps that precision. Its boundary is the start of the day, the result is flagged `boundaryUncertain`, and the UI has to say the answer includes everything learned that day. No time of day is invented.

**4. Why is this mine** (`whyOwner`)

```cypher
MATCH (p:Person)-[:OWES]->(c:Commitment {id: $commitmentId})-[:ESTABLISHED_BY {field: 'owner'}]->(ch:Change)
OPTIONAL MATCH (ch)-[:FROM]->(n:Note)
RETURN c.id, p.id, p.name, ch.id, ch.kind, ch.source, ch.state, ch.quote, n.id, n.text, n.occurredAt
```

The answer is the change that established the current owner: a quote from a note, or "you set this yourself". Ownership proposals still waiting are returned separately and never mixed into the explanation.

## What has been run

`npm test` in the repository root runs 45 model tests against `@relate/relate` 1.0.1, the Node binding (plus 12 for the scoring of the linking experiment, below). All 45 passed on 2026-11-15 on Windows. Each test builds its store through the rule functions, not by hand. Eleven come from the third review, eight from the fourth and five from the fifth.

| Case | What the test establishes |
|---|---|
| Unreviewed deadline | The proposal stays due Friday with one pending change; it moves only when accepted |
| Unreviewed "done", then rejected | The commitment stays listed; rejecting changes nothing and the change cannot be accepted afterwards |
| Ownership explanation | With Me as owner and a pending proposal for Lee, the answer is Me with Me's quote, and Lee's proposal is listed apart. After accepting, the answer is Lee with Lee's quote |
| Manual owner correction | The explanation is the manual change, with no note |
| Competing deadlines | Both marked conflicting; after accepting one, the other is stale, is refused, and applies only with explicit confirmation. One change is current for the deadline at the end |
| Backdated note | Accepted as history, current value unchanged, still shown as newly learned with its source date. Applies when the user says so |
| Manual completion | Applied at once, appears in the change feed with no note; an older note saying "cancelled" does not undo it; an undated note applies |
| Same wording twice | Two rows, each with its own pending count |
| A blocked by B blocked by C, B done | A no longer waits on C's owner |
| Cancelled blocker | Reported as cancelled; what lay behind it is not |
| Dependency loop | Refused, no relationship added |
| Same note read twice | Nothing proposed twice; accepted and rejected decisions stand; a rejected new commitment is not recreated |
| Second reading says less | The dropped proposals are withdrawn |
| Identical text, another conversation | A separate note; a rejection in one does not block the other |
| Unknown commitment id | Refused |
| Meeting baseline | Between two meetings it is the earlier one; a message is not a meeting; "previous" works |
| Same-day changes | A change later on the meeting's day counts; the meeting's own content and supporting evidence do not |
| Meeting known only to the day | Flagged uncertain; includes everything learned that day |
| Day-precision note, same day | Not treated as older |
| Rejecting a new commitment | Removes it and rejects what was proposed on it |
| Re-reading after a manual owner correction | The commitment is kept, the correction still explains the owner, no change is left without a commitment |
| Rejecting a provisional blocker another commitment depends on | Refused with the dependent listed; nothing changes. After confirmation the blocker is gone and the dependent's history shows why |
| Rejecting a new commitment the user edited | Refused with the edit listed, until confirmed |
| Two competing accepts at once | One applies, the other is stale; one change is current |
| The same without a shared queue | Same result. With the in-statement check removed, this test fails, so the check is what stops it |
| The same change accepted twice at once | Applied once |
| Dependency proposed, then added and removed by hand | The proposal is stale; confirmed, it is recorded as history and the dependency stays removed |
| Dependency from a note older than a manual removal | Recorded only; a newer note can add it again |
| New commitment re-read with another date and recipient, untouched | Refreshed in place: one commitment, new values |
| The same after the user confirmed | Two corrections proposed; values unchanged until accepted; a third reading adds nothing |
| The same after a manual edit | A correction is proposed; the manual value stays |
| Deadline words change, no resolved date | Untouched: refreshed. Confirmed: a correction is proposed and applies only when accepted. The same words in another case are the same reading |
| Reading drops a confirmed recipient and deadline | Two removals proposed; both values stay until accepted, then both are gone |
| Removal rejected | The recipient stays and the removal is not proposed again |
| Clearing by hand | Recipient and deadline can be cleared; an owner cannot; a recipient change with nobody named is refused |
| Blocker not in the candidate list | Refused, also for removal and for a made-up id; proposed once the blocker is in the list |
| Change refers to a new commitment of the same reading | Resolved in any order; unknown refs refused; a second reading adds nothing |
| Change refers to a rejected new commitment | Refused |
| Unknown person in a reading | Refused, and nothing is written |
| Two new commitments, same wording and owner | Two commitments; their refs resolve to different records; the dependency between them is not a loop; reading them again in the other order adds nothing |
| The same, one of them changed on re-reading | The right one is refreshed, the other is untouched; an extra one is added as new |
| The same, one of them rejected | It stays rejected and the other stays |
| Two new commitments with the same ref | The second is refused |
| Invalid re-reading of a valid proposal | Nothing is withdrawn or deleted; a later clean reading that omits them does withdraw them |

Limits of this evidence:

- Run on the Node binding only. The browser build of Relate may differ.
- On Windows, `npm ci --ignore-scripts` in the repository root works and `npm test` passes with that install. The `postinstall` script itself uses `mkdir -p` and `cp`, so on Windows the Relate browser files have to be copied by hand from Git Bash.
- Concurrency was tested with interleaved calls in one process. Two tabs cannot both open the store, so that case does not arise.
- Rejecting a commitment with consequences, once confirmed, is several statements. A crash in the middle could leave it half done. It needs a transaction or a recoverable operation before it is relied on for private data. Whether Relate's browser build offers transactions has not been checked.
- A rejected new commitment stays rejected when the note is read again with a different date: the commitment was refused, not its date.
- Matching same-worded commitments across readings is a rule of thumb. When neither recipient nor deadline matches, the pairing falls back to reading order and can pair the wrong two. The cost is a refreshed proposal or a proposed correction, both of which the user reviews; nothing confirmed changes without review.
- No model was involved. The assertions were written by the tests.

## Review state and dates

- The app, not the model, decides what needs a look, and writes the reasons to `issues`: owner missing or not a known person, a name that matches two people, a date that could not be resolved, a blocker with nobody to wait on, a note with no source date, a cancelled blocker. Writing these issues is not implemented yet.
- The model returns the words of the note ("Friday"). Application code resolves them against the note's `occurredAt`, or `capturedAt` when that is missing, in which case the result is flagged. Not implemented yet.

## Decisions

All agreed across the two reviews:

1. **Demo and private data in separate stores** (`opfs://kept-demo`, `opfs://kept-private`), with the inference policy bound to the active workspace: the demo workspace may fall back to the cloud, the private one is only-on-device.
2. **A later note attaches to an existing commitment through a candidate list**, confirmed in review. The model can answer "none of these, create a new one". Every returned id is validated against the list (done in `recordExtraction`).
3. **No project or client nodes.** Meetings are notes with `kind: 'meeting'`.
4. **`Evidence` is renamed `Note`.** The note is the source; each quote on a change is the evidence for one assertion.
5. **`Deadline` nodes are replaced by `Change` records** and a current deadline on the commitment.
6. **"What changed" means what the app learned since**, named that way in the UI, with the source time shown.

## Next

The candidate-linking experiment has been run on the device with two prompts and in the cloud, including notes held out from tuning. The results are in `linking-experiment.md`. In short: the cloud model was right or asked on every note; the device model proposed something wrong on between a third and just over half of the runs and never said it was unsure. So linking belongs in the cloud where the cloud is allowed, and on the device every link is provisional and review is mandatory. One run each.

Before private-data use, both closed on 2026-11-18 (see `decisions.md`):

1. The model tests run against the browser build: `npm run test:wasm`, all passing.
2. The confirmed-rejection path is one statement, so it is atomic.

## Not covered yet

- Uniqueness constraints and indexes. Which constraints Relate supports has not been checked.
- Issues and date resolution, as noted above.
- Handling the second tab, which fails with `storage locked`.
- Splitting a note with several commitments, which the device model handled badly in the slice.
