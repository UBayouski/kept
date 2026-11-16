// Capture: from a pasted note and a model's answer to proposals in the store.
//
//   prepare        people and the commitments to offer the model
//   (the page calls the model with those candidates)
//   capture        stores the note, validates the answer (reading.js), records
//                  what can be proposed, and returns what still needs the user
//   proposeChange  the user's answer to a question, or a link made by hand
//   proposeNew     a new commitment, once the user has said who owes it to whom
//
// No DOM and no model call here, so it runs against the Node binding in tests.
// Everything recorded is a proposal: nothing here accepts anything. The dates
// and people it fills in are the app's reading of the words, shown to the user
// on the proposal before they confirm it.

import * as m from './model.js';
import { readNote, toExtraction, norm } from './reading.js';
import { readDependencies, beforeCue } from './dependencies.js';

// --- Dates ---

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WEEKDAY_SHORT = { sun: 0, mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5, sat: 6 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
// Words around a date that do not change which day it is.
const FILLER = new Set(['by', 'on', 'until', 'till', 'before', 'due', 'this', 'the', 'of', 'morning', 'afternoon', 'evening', 'night', 'noon', 'eod',
  'lunch', 'breakfast', 'dinner', 'latest', 'at']);

const iso = (y, month, d) => {
  const date = new Date(Date.UTC(y, month, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === month && date.getUTCDate() === d ? date.toISOString().slice(0, 10) : null;
};
const weekdayOf = (word) => (WEEKDAYS.includes(word) ? WEEKDAYS.indexOf(word) : WEEKDAY_SHORT[word] ?? -1);
const monthOf = (word) => MONTHS.findIndex((name) => word.length >= 3 && (name === word || name.slice(0, 3) === word || (word === 'sept' && name === 'september')));
const dayOfMonth = (word) => {
  const match = /^(\d{1,2})(st|nd|rd|th)?$/.exec(word ?? '');
  return match ? Number(match[1]) : null;
};

// The day the words of a note mean, as YYYY-MM-DD, counted from the day the
// note is from (`base`, YYYY-MM-DD). Returns null unless there is one reading:
//   - "2026-11-20"; "today", "tonight", "tomorrow"
//   - a weekday: the next such day after the note's. On that weekday itself it
//     could be today or a week on, so it is left unresolved
//   - a month and a day, with or without a year: without one, the next such date
//   - "next Friday", "next week", "the 3rd", "end of month" are left unresolved
// An unresolved deadline keeps its words; the model stores both.
export function resolveDate(text, base) {
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(base ?? '')) return null;
  const [y, mo, d] = base.split('-').map(Number);
  const explicit = /^\s*(\d{4})-(\d{2})-(\d{2})\s*$/.exec(text);
  if (explicit) return iso(Number(explicit[1]), Number(explicit[2]) - 1, Number(explicit[3]));

  const words = norm(text).split(' ').filter((word) => word && !FILLER.has(word));
  const offset = (days) => iso(y, mo - 1, d) && new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
  if (words.length === 1) {
    const [word] = words;
    if (word === 'today' || word === 'tonight') return offset(0);
    if (word === 'tomorrow') return offset(1);
    const weekday = weekdayOf(word);
    if (weekday < 0) return null;
    const ahead = (weekday - new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 7) % 7;
    return ahead === 0 ? null : offset(ahead);
  }
  if (words.length === 2 || words.length === 3) {
    // "Nov 20", "20 November", either with a year after it.
    const year = words.length === 3 && /^\d{4}$/.test(words[2]) ? Number(words[2]) : null;
    if (words.length === 3 && year === null) return null;
    const [a, b] = words;
    const [month, day] = monthOf(a) >= 0 ? [monthOf(a), dayOfMonth(b)] : [monthOf(b), dayOfMonth(a)];
    if (month < 0 || day === null) return null;
    if (year !== null) return iso(year, month, day);
    const thisYear = iso(y, month, day);
    return thisYear && thisYear >= base ? thisYear : iso(y + 1, month, day);
  }
  return null;
}

// --- People ---

const ME = new Set(['me', 'i', 'myself']);
const tokens = (text) => norm(text).split(' ').filter(Boolean);

// The person a name refers to, or null when nobody or more than one fits.
// people: [{id, name, aliases, isMe}]
export function matchPerson(name, people) {
  const wanted = norm(name);
  if (!wanted) return null;
  if (ME.has(wanted)) return people.find((p) => p.isMe)?.id ?? null;
  const exact = people.filter((p) => norm(p.name) === wanted || (p.aliases ?? []).some((alias) => norm(alias) === wanted));
  if (exact.length) return exact.length === 1 ? exact[0].id : null;
  const byFirstName = people.filter((p) => tokens(p.name)[0] === wanted);
  return byFirstName.length === 1 ? byFirstName[0].id : null;
}

// The people other than the user whose name or alias appears in a text, in the
// order they first appear. A possessive counts ("Lee's pricing").
export function peopleNamed(text, people) {
  const padded = ` ${norm(text)} `;
  const found = [];
  for (const person of people) {
    if (person.isMe) continue;
    const positions = [person.name, ...(person.aliases ?? [])].map(norm).filter(Boolean)
      .map((name) => padded.indexOf(` ${name} `)).filter((at) => at >= 0);
    if (positions.length) found.push({ id: person.id, at: Math.min(...positions) });
  }
  return found.sort((a, b) => a.at - b.at).map((p) => p.id);
}

// Who probably owes a new commitment to whom, from the words alone. Used when
// the model gave no names, or names that match nobody. It is a starting point
// for the user to correct, never recorded without them:
//   - "I ..." or "we ...": the user owes it, to the one other person named
//   - otherwise the first person named owes it, to the user if the words say
//     "me" or "us", else to the one other person named
// Only the words before a dependency count: in "..., once Lee confirms
// pricing" Lee is who it waits for, not who it is for.
export function guessPeople(fullQuote, people) {
  const quote = beforeCue(fullQuote);
  const me = people.find((p) => p.isMe)?.id ?? null;
  const words = new Set(tokens(quote));
  const named = peopleNamed(quote, people);
  // "Dana asked me to draft it": a request to the user, who then owes it to Dana.
  if (named.length === 1 && /\b(asked|asks|wants|wanted|needs|needed|told|tells|reminded|expects|expected) (me|us) to\b/i.test(quote)) {
    return { ownerId: me, toId: named[0] };
  }
  if (words.has('i') || words.has('we')) return { ownerId: me, toId: named.length === 1 ? named[0] : null };
  if (!named.length) return { ownerId: null, toId: null };
  // "Sam will review my draft": with one other person, "my" means it comes back to the user.
  const toMe = words.has('me') || words.has('us') || (named.length === 1 && (words.has('my') || words.has('our')));
  return { ownerId: named[0], toId: toMe ? me : named.length === 2 ? named[1] : null };
}

// The wording of a commitment without its recipient, who has a field of their
// own: "Send Dana the invoice" and "Send the invoice to Dana" both become
// "Send the invoice". Only the recipient's name is taken out, and only where
// it names the person the thing goes to: "to/for Dana" anywhere, or Dana as
// the word right after the verb. "Review Dana's draft" is left alone.
export function withoutRecipient(what, recipient) {
  const text = String(what ?? '').trim();
  const names = recipient ? [recipient.name, ...(recipient.aliases ?? [])].map((n) => String(n ?? '').trim()).filter(Boolean) : [];
  if (!text || !names.length) return text;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = names.map(escape).join('|');
  let out = text
    .replace(new RegExp(`\\s+(?:to|for)\\s+(?:${alternatives})(?![\\p{L}\\p{N}'’])`, 'giu'), '')
    .replace(new RegExp(`^(\\S+)\\s+(?:${alternatives})(?![\\p{L}\\p{N}'’])\\s+`, 'iu'), '$1 ');
  out = out.replace(/\s+/g, ' ').trim();
  // Never leave less than a verb and an object.
  if (out.split(' ').length < 2) return text;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

// --- Candidates ---

// A short label for a commitment, the same every time it is offered, so a
// label never depends on where the commitment is in the list.
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function labelsFor(ids) {
  const taken = new Set();
  return ids.map((id) => {
    let n = parseInt(m.textHash(id), 16);
    let label;
    do {
      label = `${LETTERS[n % LETTERS.length]}${Math.floor(n / LETTERS.length) % 10}`;
      n += 1;
    } while (taken.has(label));
    taken.add(label);
    return label;
  });
}

const SMALL = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'will', 'can', 'not', 'are', 'was']);

// The open commitments to offer the model for one note, at most `max`. When
// there are more, the ones sharing words or people with the note come first;
// `leftOut` says how many were not offered, so the page can say so.
// commitments: rows of review-data.js commitments().
export function candidatesFor(commitments, text, { max = 8 } = {}) {
  const noteWords = new Set(tokens(text));
  const open = commitments.filter((c) => c.status === 'open');
  const relevance = (c) => tokens(`${c.what} ${c.mine ? '' : c.owner} ${c.to ?? ''}`)
    .filter((word) => word.length > 2 && !SMALL.has(word) && noteWords.has(word)).length;
  const chosen = open.map((c, index) => ({ c, index, score: relevance(c) }))
    .sort((a, b) => b.score - a.score || a.index - b.index).slice(0, max)
    .sort((a, b) => a.index - b.index).map((x) => x.c);
  const labels = labelsFor(chosen.map((c) => c.id));
  return {
    candidates: chosen.map((c, i) => ({
      id: c.id, label: labels[i], what: c.what, owner: c.mine ? 'me' : c.owner, to: c.toMine ? 'me' : c.to ?? '', due: c.dueText || c.due || '',
    })),
    leftOut: open.length - chosen.length,
  };
}

// --- Store ---

export function people(q) {
  return q('MATCH (p:Person) RETURN p.id AS id, p.name AS name, p.aliases AS aliases, p.isMe AS isMe ORDER BY isMe DESC, name');
}

const openCommitments = (q) => q(
  `MATCH (o:Person)-[:OWES]->(c:Commitment {status: 'open'})
   OPTIONAL MATCH (c)-[:TO]->(t:Person)
   RETURN c.id AS id, c.what AS what, c.status AS status, toString(c.due) AS due, c.dueText AS dueText,
          o.name AS owner, o.isMe AS mine, t.name AS to, t.isMe AS toMine
   ORDER BY due, what, id`,
);

// What the model call for a note needs: the people in the store (with the
// user, who is created on the first capture into an empty store), and the
// commitments to offer.
export async function prepare(q, text, { max } = {}) {
  let persons = await people(q);
  if (!persons.some((p) => p.isMe)) {
    await m.createPerson(q, { name: 'Me', isMe: true });
    persons = await people(q);
  }
  return { people: persons, ...candidatesFor(await openCommitments(q), text, { max }) };
}

export async function addPerson(q, name) {
  const clean = String(name ?? '').trim();
  if (!clean) return { outcome: 'empty' };
  const existing = matchPerson(clean, await people(q));
  if (existing) return { outcome: 'exists', id: existing };
  return { outcome: 'added', id: await m.createPerson(q, { name: clean }) };
}

const KIND = { 'new deadline': 'deadline', done: 'completed', cancelled: 'cancelled' };
const changeAssertion = ({ commitmentId, change, due, quote }, baseDate) => ({
  kind: KIND[change], commitmentId, quote,
  ...(change === 'new deadline' ? { dueText: due, due: resolveDate(due, baseDate) } : {}),
});

// Everything proposed from one note so far goes to recordExtraction together
// each time, never the latest piece alone: read on its own, a second new
// commitment with the wording and owner of the first would be taken for the
// first one read again. The reading is never complete while the user is still
// answering, so nothing is withdrawn.
async function record(q, session, more) {
  const assertions = [...session.assertions, ...more.map((a) => ({ ...a, tag: crypto.randomUUID() }))];
  const result = await m.recordExtraction(q, session.noteId, assertions,
    { candidateIds: [...session.candidateIds], complete: false, ...(session.now ? { now: session.now } : {}) });
  // A refused assertion is not sent again with the next answer.
  const refused = new Set(result.invalid.map((bad) => bad.tag));
  session.assertions = assertions.filter((a) => !refused.has(a.tag));
  return result;
}

// Stores a note and what a model read from it.
//   answer, shape  the model's parsed answer and its prompt variant ('v1' | 'v2')
//   candidates     the list the model was given (from prepare)
//   occurredAt     when the note is from (ISO); baseDate is that day as the
//                  user's calendar has it (YYYY-MM-DD), for "Friday"
// Returns
//   session   what later answers for this note need; pass it to proposeChange and proposeNew
//   recorded  the outcome of recordExtraction for the proposals made now
//   pending   what needs the user, each with a `type`:
//               new       a new commitment and the app's guess at its people
//               question  the reading could not choose; options as in reading.js
//               manual    an entry that failed validation, to link by hand
//   problems, notes  what validation refused and which app rules fired, for the log
export async function capture(q, { text, kind = 'note', occurredAt, baseDate, answer, shape, candidates, people: persons,
  extractedBy = 'model', now }) {
  const reading = readNote(answer, { shape, candidates, note: text });
  const noteId = await m.createNote(q, {
    kind, text, occurredAt, involves: peopleNamed(text, persons), extractedBy, ...(now ? { now } : {}),
  });
  const session = { noteId, baseDate, now, candidateIds: new Set(candidates.map((c) => c.id)), assertions: [] };
  const first = toExtraction(reading).assertions.map((a) => ({ ...a, ...(a.kind === 'deadline' ? { due: resolveDate(a.dueText, baseDate) } : {}) }));
  const recorded = await record(q, session, first);

  const asNew = (n) => {
    const guess = guessPeople(n.quote, persons);
    const toId = matchPerson(n.to, persons) ?? guess.toId;
    const recipient = persons.find((p) => p.id === toId && !p.isMe);
    return {
      type: 'new', what: withoutRecipient(n.what, recipient), quote: n.quote, dueText: n.due, due: resolveDate(n.due, baseDate),
      ownerName: n.owner, toName: n.to,
      ownerId: matchPerson(n.owner, persons) ?? guess.ownerId,
      toId,
    };
  };
  // Each new commitment gets a ref, so a dependency read later from the same
  // note can point at it before it is in the store.
  const pending = [
    ...reading.created.map((n, i) => ({ ...asNew(n), ref: `new-${i + 1}` })),
    ...reading.questions.map((question) => ({
      type: 'question', quote: question.quote, from: question.from,
      options: question.options.map((option) => (option.type === 'new' ? { ...option, ...asNew(option), type: 'new', incomplete: Boolean(option.incomplete) } : option)),
    })),
    ...reading.manual.map((item) => ({ type: 'manual', quote: item.quote, reason: item.reason,
      ...(item.saidNew ? { saidNew: asNew(item.saidNew) } : {}) })),
  ];
  return { session, recorded, pending, usable: reading.ok, problems: reading.problems, notes: reading.notes };
}

// The user says which commitment a statement changes, and how: an answer to a
// question, or a link made by hand. It becomes a proposal like any other.
// changes: [{commitmentId, change: 'new deadline' | 'done' | 'cancelled', due, quote}]
export function proposeChange(q, session, changes) {
  for (const change of changes) {
    if (!KIND[change.change]) throw new Error(`"${change.change}" is not a change to a commitment`);
    session.candidateIds.add(change.commitmentId);
  }
  return record(q, session, changes.map((change) => changeAssertion(change, session.baseDate)));
}

// A new commitment, with the people the user chose. Stored unconfirmed, with a
// proposal in the review queue.
export function proposeNew(q, session, { what, ownerId, toId = null, dueText = '', quote, ref }) {
  const clean = String(what ?? '').trim();
  if (!clean) throw new Error('Say what is promised');
  if (!ownerId) throw new Error('Choose who owes it');
  return record(q, session, [{
    kind: 'created', what: clean, ownerId, toId: toId || null, quote,
    dueText: dueText || null, due: resolveDate(dueText, session.baseDate),
    ...(ref ? { ref } : {}),
  }]);
}

// --- What still needs the user, kept with the note ---

// The cards a note still has, stored on the note itself, so a reload or a
// closed tab does not lose them and emptying the store removes them. One
// session per note: the cards of a note share it, because each answer adds to
// what that note has proposed so far.
export async function savePending(q, session, items) {
  const pending = items.length
    ? JSON.stringify({ session: { ...session, candidateIds: [...session.candidateIds] }, items })
    : null;
  await q('MATCH (n:Note {id: $id}) SET n.pending = $pending', { id: session.noteId, pending });
}

// Every note's cards, oldest note first: [{session, noteText, item}].
export async function loadPending(q) {
  const rows = await q(
    `MATCH (n:Note) WHERE n.pending IS NOT NULL
     RETURN n.text AS text, n.pending AS pending ORDER BY toString(n.capturedAt), n.id`,
  );
  return rows.flatMap((row) => {
    let saved;
    try {
      saved = JSON.parse(row.pending);
    } catch {
      return [];
    }
    const session = { ...saved.session, candidateIds: new Set(saved.session.candidateIds) };
    return saved.items.map((item) => ({ session, noteText: row.text, item }));
  });
}

// --- Dependencies ---

// What a dependency can be between: the commitments the linking call was
// given, and the new ones it found in this note (they are not in the store
// until the user proposes them, so they are named by their ref).
export function dependencyList(candidates, pending) {
  const fresh = pending.filter((item) => item.type === 'new' && item.ref);
  return [
    ...candidates.map((c) => ({ label: c.label, what: c.what, owner: c.owner, to: c.to, commitmentId: c.id })),
    ...fresh.map((item, i) => ({ label: `N${i + 1}`, what: item.what, owner: item.ownerName || '', to: item.toName || '', isNew: true, ref: item.ref, ownerId: item.ownerId })),
  ];
}

const sideOf = (entry) => (entry.ref ? { ref: entry.ref, what: entry.what } : { commitmentId: entry.commitmentId, what: entry.what });

// Records what the dependency call read. A dependency between two commitments
// already in the store is proposed at once. One that involves a commitment
// new in this note waits for the user: they propose that commitment first.
// Something to wait for that the note names but nobody listed becomes a new
// commitment to propose, owed to whoever waits.
// Returns {recorded, pending, problems}.
export async function addDependencies(q, session, { answer, list, note, people: persons, nextRef = 1 }) {
  const read = readDependencies(answer, { list, note });
  const byLabel = new Map(list.map((c) => [c.label, c]));
  const pending = [];
  const direct = [];
  let n = nextRef;
  const problems = [...read.problems];
  const meId = persons.find((p) => p.isMe)?.id ?? null;
  // Who does what waits: the subject of the note's main clause, "I" or a person
  // named first. "Dana can't sign the contract until ..." is Dana's, so it is
  // not my own "Send the contract". Only for a note with one dependency.
  const subject = (() => {
    const first = norm(beforeCue(note)).split(' ')[0] ?? '';
    if (first === 'i' || first === 'we') return meId;
    return persons.find((p) => !p.isMe && norm(p.name).split(' ')[0] === first)?.id ?? null;
  })();
  for (const dep of read.dependencies) {
    const waiting = byLabel.get(dep.waiting);
    let blocker = byLabel.get(dep.waitsFor);
    if (read.dependencies.length === 1 && !waiting.isNew && subject) {
      const ownerId = matchPerson(waiting.owner, persons);
      if (ownerId && ownerId !== subject) {
        problems.push({ reason: `"${waiting.what}" is not the action of the person who waits`, entry: dep });
        continue;
      }
    }
    // The words name who has to act first. A listed commitment owed by someone
    // else is not that: "after Priya approves the budget" is not my own
    // "Review the budget". The link is refused, not guessed again.
    if (dep.waitsFor !== 'new' && !blocker.isNew) {
      const named = peopleNamed(dep.quote, persons);
      const acting = named.length === 1 ? named[0] : /\b(i|we)\b/i.test(dep.quote) && !named.length ? meId : null;
      const ownerId = matchPerson(blocker.owner, persons);
      if (acting && ownerId && acting !== ownerId) {
        problems.push({ reason: `"${blocker.what}" is not the action of the person the words name`, entry: dep });
        continue;
      }
    }
    if (dep.waitsFor === 'new') {
      // The thing waited for is owed to whoever waits.
      const waiterId = waiting.ownerId ?? matchPerson(waiting.owner, persons);
      const ref = `dep-${n++}`;
      const ownerId = matchPerson(dep.newOwner, persons);
      pending.push({
        type: 'new', what: withoutRecipient(dep.newWhat, null), quote: dep.quote, dueText: '', due: null,
        ownerName: dep.newOwner, toName: waiting.owner, ownerId, toId: waiterId, ref,
      });
      blocker = { ref, what: dep.newWhat };
    }
    if (!waiting.ref && !blocker.ref) {
      direct.push({ kind: 'blocked', commitmentId: waiting.commitmentId, namesId: blocker.commitmentId, quote: dep.quote });
    } else {
      pending.push({ type: 'dependency', quote: dep.quote, waiting: sideOf(waiting), waitsFor: sideOf(blocker) });
    }
  }
  const recorded = direct.length ? await record(q, session, direct) : null;
  return { ok: read.ok, recorded, pending, problems };
}

// The user confirms a dependency that involves a commitment new in this note.
// That commitment has to be proposed first.
export function proposeDependency(q, session, { waiting, waitsFor, quote }) {
  for (const side of [waiting, waitsFor]) {
    if (side.ref && !session.assertions.some((a) => a.kind === 'created' && a.ref === side.ref)) {
      throw new Error(`Propose the new commitment "${side.what}" first, then this.`);
    }
  }
  return record(q, session, [{
    kind: 'blocked', quote,
    ...(waiting.ref ? { commitmentRef: waiting.ref } : { commitmentId: waiting.commitmentId }),
    ...(waitsFor.ref ? { namesRef: waitsFor.ref } : { namesId: waitsFor.commitmentId }),
  }]);
}
