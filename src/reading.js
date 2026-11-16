// From a model's answer about one note to proposals the user can review.
//
//   model answer -> validateReading -> applyRules -> readNote result
//
// Nothing here writes anything. The result is proposals, questions and
// statements to link by hand; accepted state changes only when the user
// confirms a proposal (see model.js). A model saying "unclear", or a model
// answering cleanly, is never a reason to skip that confirmation.
//
// See docs/linking-experiment.md for why each check exists: every one
// answers something a model actually returned.

// Words that make a clause a dependency, not a date: "after Dana signs off",
// "once Lee confirms". Not "until" or "before", which also give deadlines
// ("can wait until next month").
// Words a model writes for "no date".
const NO_DATE = /^(not set|none|no date|n\/?a|unknown|unspecified|tbd|null|-)$/i;
export const DEPENDS = /\b(once|after|when|as soon as|waiting (on|for)|waits? (on|for)|depends? on|dependent on|blocked)\b/i;

export const norm = (text) => String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
export const wellFormed = (parsed) => Boolean(parsed) && Array.isArray(parsed.updates) && Array.isArray(parsed.newCommitments);

const CHANGES = ['new deadline', 'done', 'cancelled'];
const MAX_ITEMS = 12;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The fields each kind of entry must have: exactly these, all strings.
const FIELDS = {
  v1update: ['quote', 'commitment', 'change', 'due'],
  v1new: ['quote', 'what', 'owner', 'to', 'due'],
  v2item: ['quote', 'about', 'change', 'due', 'what'],
};

function fieldProblem(entry, names) {
  if (!isObject(entry)) return 'not an object';
  const unknown = Object.keys(entry).filter((key) => !names.includes(key));
  if (unknown.length) return `unknown field "${unknown[0]}"`;
  const bad = names.find((key) => typeof entry[key] !== 'string');
  return bad ? `"${bad}" is missing or not text` : null;
}

// Checks a model's answer before anything is made of it. `shape` is 'v1' (two
// lists) or 'v2' (one list); `candidates` are the commitments the model was
// given, each with a `label`; `note` is the text it read.
//
// Returns the entries that passed, in one shape whatever the prompt was:
//   updates          {quote, commitment: label | 'unclear', change, due}
//   newCommitments   {quote, what, owner, to, due}
//   manual           statements the user has to link by hand, each with the reason
//   problems         everything that was refused or ignored, for the log
// ok is false when the answer as a whole cannot be used; `manual` then holds
// the whole note.
//
// What is checked:
//   - the answer and each entry have the fields of the schema, and no others
//   - a commitment named is one the model was given
//   - the kind of change fits what it is about: a listed commitment gets a new
//     deadline, done or cancelled; only something new is a "new commitment"
//   - a new deadline has a date, and a new commitment says what it is
//   - the quote is in the note
//   - one commitment is not given two different changes
export function validateReading(answer, { shape, candidates, note }) {
  const problems = [];
  const manual = [];
  const unusable = (reason) => ({
    ok: false, updates: [], newCommitments: [], problems: [...problems, { reason }],
    manual: [{ quote: note, reason: `The answer could not be used: ${reason}.` }],
  });

  if (!isObject(answer)) return unusable('it is not an object');
  const lists = shape === 'v2' ? ['items'] : ['updates', 'newCommitments'];
  for (const key of lists) if (!Array.isArray(answer[key])) return unusable(`"${key}" is missing or not a list`);
  for (const key of Object.keys(answer)) {
    if (!lists.includes(key)) problems.push({ reason: `ignored unknown key "${key}" in the answer` });
  }

  // Every entry in one form: {target, change, due, quote, what, owner, to}.
  const entries = [];
  const take = (raw, names, read) => {
    const problem = fieldProblem(raw, names);
    entries.push(problem ? { raw, problem } : { raw, ...read(raw) });
  };
  if (shape === 'v2') {
    for (const raw of answer.items) take(raw, FIELDS.v2item, (e) => ({ target: e.about, change: e.change, due: e.due, quote: e.quote, what: e.what, owner: '', to: '' }));
  } else {
    for (const raw of answer.updates) take(raw, FIELDS.v1update, (e) => ({ target: e.commitment, change: e.change, due: e.due, quote: e.quote, what: '', owner: '', to: '' }));
    for (const raw of answer.newCommitments) take(raw, FIELDS.v1new, (e) => ({ target: 'new', change: 'new commitment', due: e.due, quote: e.quote, what: e.what, owner: e.owner, to: e.to }));
  }
  if (entries.length > MAX_ITEMS) return unusable(`it has ${entries.length} entries for one note`);

  const labels = new Set(candidates.map((c) => c.label));
  const noteText = norm(note);
  const inNote = (quote) => norm(quote).length > 0 && noteText.includes(norm(quote));
  const check = (e) => {
    if (e.problem) return e.problem;
    if (e.target !== 'new' && e.target !== 'unclear' && !labels.has(e.target)) return `"${e.target}" is not a commitment the model was given`;
    if (e.target === 'new') {
      if (e.change !== 'new commitment') return `something new cannot be "${e.change}"`;
      if (!norm(e.what)) return 'a new commitment does not say what it is';
    } else if (!CHANGES.includes(e.change)) {
      return `an existing commitment cannot be "${e.change}"`;
    }
    if (e.change === 'new deadline' && !norm(e.due)) return 'a new deadline has no date';
    if (!inNote(e.quote)) return norm(e.quote) ? 'the quote is not in the note' : 'there is no quote';
    return null;
  };

  const updates = [];
  const newCommitments = [];
  for (const e of entries) {
    // A new deadline whose date is a dependency ("after Dana signs off on it")
    // keeps only the part before it ("tomorrow after lunch" -> "tomorrow"). If
    // nothing is left and the note states a dependency, it was the dependency
    // read as a deadline: the dependency reading has it, so it is not proposed
    // and not left for the user to link.
    // A model may fill an empty date with a placeholder ("not set", "none").
    if (!e.problem && typeof e.due === 'string' && NO_DATE.test(e.due.trim())) e.due = '';
    if (!e.problem && e.change === 'new deadline' && e.target !== 'new') {
      const at = e.due.search(DEPENDS);
      if (at >= 0) e.due = e.due.slice(0, at).replace(/[\s,;]+$/, '');
      if (!norm(e.due) && DEPENDS.test(note)) {
        problems.push({ reason: 'a dependency read as a deadline was left to the dependency reading', entry: e.raw });
        continue;
      }
    }
    const reason = check(e);
    if (reason) {
      problems.push({ reason, entry: e.raw });
      // Keep the words if they really are in the note, so the user sees what to link.
      // A well-formed entry that contradicts itself ("about" a listed commitment,
      // but "new commitment") is still refused; what it said is kept, so the
      // user can take its reading with one click instead of typing it again.
      manual.push({ quote: !e.problem && inNote(e.quote) ? e.quote.trim() : note, reason: `An entry was refused: ${reason}.`,
        newLike: !e.problem && e.change === 'new commitment',
        ...(!e.problem && e.change === 'new commitment' && norm(e.what) ? { saidNew: { what: e.what.trim(), owner: e.owner, to: e.to, due: e.due.trim(), quote: e.quote.trim() } } : {}) });
      continue;
    }
    const quote = e.quote.trim();
    if (e.target === 'new') {
      newCommitments.push({ quote, what: e.what.trim(), owner: e.owner.trim(), to: e.to.trim(), due: e.due.trim() });
    } else {
      // A date on "done" or "cancelled" means nothing; the model sometimes adds one.
      updates.push({ quote, commitment: e.target, change: e.change, due: e.change === 'new deadline' ? e.due.trim() : '' });
    }
  }

  // The same entry twice is one entry. Two different changes to one commitment
  // are a conflict: neither is proposed, and the user decides.
  const unique = (list, key) => [...new Map(list.map((item) => [key(item), item])).values()];
  const deduped = unique(updates, (u) => `${u.commitment}|${u.change}|${norm(u.due)}|${norm(u.quote)}`);
  if (deduped.length < updates.length) problems.push({ reason: `${updates.length - deduped.length} repeated entries dropped` });
  const kept = [];
  const byCommitment = new Map();
  for (const u of deduped) {
    if (u.commitment === 'unclear') kept.push(u);
    else byCommitment.set(u.commitment, [...(byCommitment.get(u.commitment) ?? []), u]);
  }
  for (const [label, group] of byCommitment) {
    const distinct = unique(group, (u) => `${u.change}|${norm(u.due)}`);
    if (distinct.length === 1) {
      kept.push(distinct[0]);
      continue;
    }
    const said = distinct.map((u) => (u.due ? `${u.change} (${u.due})` : u.change)).join(', ');
    problems.push({ reason: `conflicting changes to ${label}: ${said}` });
    manual.push({ quote: distinct[0].quote, commitment: label, options: distinct.map(({ change, due, quote }) => ({ change, due, quote })),
      reason: `The answer gives ${label} conflicting changes: ${said}.` });
  }

  // A refused "new commitment" whose words a valid new commitment of the same
  // reading already covers is that one said twice, not something to link by hand.
  const overlaps = (a, b) => {
    const [x, y] = [norm(a), norm(b)];
    return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
  };
  // Likewise one with the wording of a listed commitment this reading updates
  // ("Lee asked for the proposal by Monday": a new deadline on "Send the
  // proposal" to Lee, and the same proposal again as new).
  const updated = kept.filter((u) => u.commitment !== 'unclear').map((u) => candidates.find((c) => c.label === u.commitment)).filter(Boolean);
  const repeatsUpdate = (said) => said && updated.some((c) => norm(c.what) === norm(said.what) && (!norm(said.to) || norm(said.to) === norm(c.to)));
  for (let i = manual.length - 1; i >= 0; i--) {
    if (manual[i].newLike && newCommitments.some((n) => overlaps(n.quote, manual[i].quote))) {
      problems.push({ reason: 'a refused new commitment repeated a valid one and was dropped' });
      manual.splice(i, 1);
    } else if (manual[i].newLike && repeatsUpdate(manual[i].saidNew)) {
      problems.push({ reason: 'a refused new commitment repeated a commitment this reading updates and was dropped' });
      manual.splice(i, 1);
    }
  }
  for (const item of manual) delete item.newLike;

  return {
    ok: true,
    updates: kept,
    // Only an entry identical in every field is a repeat. "Lee and Sam will each
    // send the report" is two commitments that differ in the owner alone.
    newCommitments: unique(newCommitments, (n) => [n.what, n.owner, n.to, n.due, n.quote].map(norm).join('|')),
    manual,
    problems,
  };
}

// Rules the app applies to a reading before anything is proposed. They never
// pick an answer and never discard a change: they turn something that needs a
// second look into a question for the user. An update with commitment
// 'unclear' and `among` is that question. It keeps the change and its date,
// and its options are the listed commitments, 'new' where the reading also
// gave it as new, and 'all', because the same words may well apply to each of
// them ("both move to Tuesday"). A new commitment that a rule folds into a
// question is kept whole on it, in `newCommitments`, so that choosing "new"
// gives back exactly what was read.
//   1. A new commitment with the wording and recipient of a listed commitment
//      the same reading updates may be that update said twice, or may really
//      be new ("sent the contract; another contract on Friday"). It is not
//      proposed as new and not dropped: it becomes a question, new or the same.
//      The update itself stands.
//   2. The same words attached to several commitments as the same change is
//      not several changes. It becomes one question among those commitments.
//   3. The same words given both as a change to a listed commitment and as a
//      new commitment cannot be both. It becomes one question: that
//      commitment, or new.
export function applyRules(parsed, list) {
  if (!wellFormed(parsed)) return parsed;
  const byLabel = new Map(list.map((c) => [c.label, c]));
  let updates = parsed.updates.map((u) => ({ ...u }));
  const notes = [];
  const restated = [];

  let created = parsed.newCommitments.filter((n) => {
    const same = updates.find((u) => {
      const c = byLabel.get(u.commitment);
      return c && norm(c.what) === norm(n.what) && (!norm(n.to) || norm(n.to) === norm(c.to));
    });
    if (!same) return true;
    restated.push({ quote: n.quote, commitment: 'unclear', change: 'new commitment', due: n.due, what: n.what, among: ['new', 'same'], restates: same.commitment, newCommitments: [n] });
    notes.push(`rule 1: new "${n.what}" has the wording of ${same.commitment}, which this reading also updates`);
    return false;
  });

  const groups = new Map();
  for (const u of updates) {
    if (u.commitment === 'unclear') continue;
    const key = `${norm(u.quote)}|${u.change}|${norm(u.due)}`;
    groups.set(key, [...(groups.get(key) ?? []), u]);
  }
  for (const group of groups.values()) {
    const labels = [...new Set(group.map((u) => u.commitment))];
    if (labels.length < 2) continue;
    updates = updates.filter((u) => !group.includes(u));
    updates.push({ ...group[0], commitment: 'unclear', among: [...labels, 'all'] });
    notes.push(`rule 2: ${labels.join(' and ')} given the same change from the same words`);
  }

  const sameWords = (a, b) => {
    const [x, y] = [norm(a), norm(b)];
    return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
  };
  // Rule 4: the model's own "unclear" over the same words as a new commitment
  // it also gave is one question, not a question and a card. With nothing
  // listed, the only answer is "new", so the new commitment stands alone.
  for (const u of [...updates]) {
    if (u.commitment !== 'unclear' || u.among) continue;
    const same = created.filter((n) => sameWords(u.quote, n.quote));
    if (!same.length) continue;
    if (!list.length) {
      updates = updates.filter((x) => x !== u);
      notes.push(`rule 4: "unclear" with nothing listed is the new "${same[0].what}"`);
      continue;
    }
    u.among = [...list.map((c) => c.label), 'new', 'all'];
    u.newCommitments = same;
    created = created.filter((n) => !same.includes(n));
    notes.push(`rule 4: "unclear" and new "${same[0].what}" are one question`);
  }

  created = created.filter((n) => {
    const clash = updates.find((u) => sameWords(u.quote, n.quote) && (u.commitment !== 'unclear' || u.among));
    if (!clash) return true;
    if (clash.commitment !== 'unclear') {
      clash.among = [clash.commitment, 'all'];
      clash.commitment = 'unclear';
    }
    if (!clash.among.includes('new')) clash.among.splice(clash.among.indexOf('all'), 0, 'new');
    clash.newCommitments = [...(clash.newCommitments ?? []), n];
    notes.push(`rule 3: "${n.what}" is given as new and as a change to ${clash.among.filter((x) => x !== 'new' && x !== 'all').join(' or ')}`);
    return false;
  });

  // Rule 5: a new commitment with the wording and recipient of a listed one
  // this reading does not update ("The proposal for Lee waits until ..." with
  // "Send the proposal" to Lee listed) is most likely that one, mentioned
  // again. It becomes the same question as rule 1: new, or the same.
  created = created.filter((n) => {
    const same = list.find((c) => norm(c.what) === norm(n.what) && (!norm(n.to) || norm(n.to) === norm(c.to)));
    if (!same) return true;
    restated.push({ quote: n.quote, commitment: 'unclear', change: 'new commitment', due: n.due, what: n.what, among: ['new', 'same'], restates: same.label, newCommitments: [n] });
    notes.push(`rule 5: new "${n.what}" has the wording of ${same.label}, already listed`);
    return false;
  });

  return { updates: [...updates, ...restated], newCommitments: created, notes };
}

// One note's answer, ready for review. Nothing in it is accepted.
//   proposals  changes to listed commitments: {commitmentId, label, change, due, quote}
//   created    new commitments: {what, owner, to, due, quote}; owner and to are
//              names as the model wrote them, not yet matched to people
//   questions  the user has to choose: {quote, options, from}. Each option is a
//              complete answer, so choosing it needs no second reading:
//                {type: 'commitment', commitmentId, label, change, due, quote}
//                {type: 'new', what, owner, to, due, quote}; `incomplete` when the
//                  model named nothing new and the user has to say what it is
//                {type: 'all'}   every commitment option at once
//                {type: 'same'}  it is the update already proposed, said twice
//              A question the model asked itself ("unclear") offers every
//              listed commitment, 'new' and 'all'.
//   manual     statements that failed validation; the user links them by hand
//   alternatives  for each proposal, the other listed commitments. They are
//              always given: a clean answer does not show that the link is
//              unambiguous, and the review screen has to keep them one click away.
export function readNote(answer, { shape, candidates, note }) {
  const checked = validateReading(answer, { shape, candidates, note });
  if (!checked.ok) return { ok: false, proposals: [], created: [], questions: [], manual: checked.manual, problems: checked.problems, notes: [] };
  // The device model (v1) nearly always adds a change to some listed
  // commitment, even for a note about something new ("I'll send Sam the
  // slides": "unclear", or a deadline on "Review the budget", beside the right
  // new commitment). A change whose sentence mentions none of the commitments
  // it could be about, over the same words as a new commitment of this
  // reading, is that new commitment said twice; the change is dropped.
  let updates = checked.updates;
  if (shape === 'v1') {
    const near = (a, b) => {
      const [x, y] = [norm(a), norm(b)];
      return x.length > 0 && y.length > 0 && (x.includes(y) || y.includes(x));
    };
    updates = updates.filter((u) => {
      const sentence = sentenceOf(note, u.quote);
      const about = u.commitment === 'unclear' ? candidates : candidates.filter((c) => c.label === u.commitment);
      if (about.some((c) => mentions(sentence, c.what))) return true;
      return !checked.newCommitments.some((n) => near(sentenceOf(note, n.quote), sentence));
    });
  }
  const ruled = applyRules({ updates, newCommitments: checked.newCommitments }, candidates);
  const byLabel = new Map(candidates.map((c) => [c.label, c]));
  // Every option of a question as a complete answer.
  const optionsOf = (u, among) => among.flatMap((name) => {
    if (byLabel.has(name)) return [{ type: 'commitment', commitmentId: byLabel.get(name).id, label: name, change: u.change, due: u.due, quote: u.quote }];
    if (name === 'new') {
      const read = u.newCommitments ?? [];
      return read.length
        ? read.map((n) => ({ type: 'new', what: n.what, owner: n.owner, to: n.to, due: n.due, quote: n.quote }))
        : [{ type: 'new', what: '', owner: '', to: '', due: u.due, quote: u.quote, incomplete: true }];
    }
    if (name === 'same') return [{ type: 'same', commitmentId: byLabel.get(u.restates).id, label: u.restates }];
    return [{ type: name }];
  });

  const proposals = [];
  const questions = [];
  const manual = [...checked.manual];
  for (const u of ruled.updates) {
    // "The venue can't be booked until Dana confirms" says it waits, not that it
    // is done or cancelled. Such a reading is not proposed; the user links it.
    if ((u.change === 'done' || u.change === 'cancelled') && (WAITS.test(u.quote) || isCondition(note, u.quote))) {
      manual.push({ quote: u.quote, reason: `It was read as "${u.change}", but the words say it waits for something. Link it by hand if it is either.` });
      continue;
    }
    // Words that do not mention the commitment ("I'll send Dana the contract"
    // for "Send the proposal") may be about something not in the list: the
    // model picks the nearest one. It becomes a question: that one, or new.
    if (u.commitment !== 'unclear' && !mentions(sentenceOf(note, u.quote), byLabel.get(u.commitment).what)) {
      questions.push({ quote: u.quote, options: optionsOf(u, [u.commitment, 'new']), from: 'app rule' });
      continue;
    }
    if (u.commitment !== 'unclear') {
      proposals.push({
        commitmentId: byLabel.get(u.commitment).id, label: u.commitment, change: u.change, due: u.due, quote: u.quote,
        alternatives: candidates.filter((c) => c.label !== u.commitment).map((c) => ({ commitmentId: c.id, label: c.label })),
      });
    } else {
      const among = u.among ?? [...candidates.map((c) => c.label), 'new', 'all'];
      questions.push({ quote: u.quote, options: optionsOf(u, among), from: u.among ? 'app rule' : 'model' });
    }
  }
  return { ok: true, proposals, created: ruled.newCommitments, questions, manual, problems: checked.problems, notes: ruled.notes };
}

// Words that say the thing has not happened yet: a negation followed by
// "until", "unless" or "before"; the future ("will", "I'll"); or waiting.
// True when the words mention what a commitment is about: a word of it other
// than its verb ("Send the proposal" -> "proposal"), plurals aside.
const SMALL_WORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'out', 'off']);
export function mentions(text, what) {
  const stem = (w) => w.replace(/(es|s)$/, '');
  const said = new Set(norm(text).split(' ').filter(Boolean).map(stem));
  const named = norm(what).split(' ').filter(Boolean).slice(1).filter((w) => w.length > 2 && !SMALL_WORDS.has(w));
  return !named.length || named.some((w) => said.has(stem(w)));
}

// The sentence of the note the quoted words are in, or the words themselves.
// A model may quote only part of it ("delayed until Monday").
function sentenceOf(note, quote) {
  const q = String(quote ?? '').trim().toLowerCase();
  return note.split(/(?<=[.!?;])\s+/).find((s) => s.toLowerCase().includes(q)) ?? quote;
}

// The quoted words come right after "until", "once", "after" and the like:
// "until Lee confirms pricing" is a condition, not news that Lee did.
function isCondition(note, quote) {
  const at = note.toLowerCase().indexOf(String(quote ?? '').trim().toLowerCase());
  return at > 0 && /\b(until|till|unless|once|after|when|before|as soon as|if)\s*$/i.test(note.slice(0, at));
}
const WAITS = /\b(can'?t|cannot|can not|won'?t|will not|not|no|never)\b[^.;]*\b(until|till|unless|before)\b|\bwill\b|\w'll\b|\b(waits?|waiting|blocked)\b/i;

// What goes to model.js recordExtraction for one reading: the proposals as
// assertions, and whether they are everything the note says.
//
// `complete` is false whenever something from this reading is not among the
// assertions: an entry was refused, a question is waiting for an answer, or a
// new commitment still needs its people matched. recordExtraction withdraws
// earlier proposals the new reading no longer makes, and must not do that for
// a reading that is only part of the answer. So this object, not the bare list
// of assertions, is what crosses the write boundary.
const KIND = { 'new deadline': 'deadline', done: 'completed', cancelled: 'cancelled' };
export function toExtraction(reading) {
  const withheld = [
    !reading.ok && 'the answer could not be used',
    reading.manual.length && `${reading.manual.length} to link by hand`,
    reading.questions.length && `${reading.questions.length} question(s) to answer`,
    reading.created.length && `${reading.created.length} new commitment(s) not yet matched to people`,
  ].filter(Boolean);
  return {
    assertions: reading.proposals.map((p) => ({
      kind: KIND[p.change], commitmentId: p.commitmentId, quote: p.quote,
      ...(p.change === 'new deadline' ? { dueText: p.due } : {}),
    })),
    complete: withheld.length === 0,
    withheld,
  };
}
