// Dependencies a note states: "I'll send the proposal once Lee confirms
// pricing". Read by a second, small model call, so the linking prompt that was
// measured (docs/linking-experiment.md) stays as it was. Pure functions: the
// page makes the call, capture.js records the result.

import { norm } from './reading.js';

// Words a stated dependency comes with. Without one, no call is made.
const CUES = /\b(once|after|until|till|unless|before|as soon as|when|waiting (on|for)|wait(s)? (on|for)|depends? on|dependent on|blocked|first)\b/i;
export const hasCue = (text) => CUES.test(String(text ?? ''));
// The main clause without the dependency: "I'll send Dana the proposal" out of
// "I'll send Dana the proposal, once Lee confirms pricing", and "I'll send out
// the invitations" out of "Once Omar books the venue, I'll send out the
// invitations".
export const beforeCue = (text) => {
  const s = String(text ?? '');
  const at = s.search(CUES);
  if (at > 0) return s.slice(0, at);
  if (at === 0) {
    const comma = s.indexOf(',');
    return comma > 0 ? s.slice(comma + 1) : s;
  }
  return s;
};

const text = { type: 'string' };
const line = (c) => `[${c.label}] ${c.what}. Owner: ${c.owner || 'not known'}. For: ${c.to || 'not set'}.${c.isNew ? ' (New in this note.)' : ''}`;

// list: the commitments the dependency can be between, each {label, what,
// owner, to, isNew}: the open commitments the linking call was given, and the
// new ones it found in this note.
export function buildPrompt(note, list) {
  return `Some commitments can only be done after another one is. Read the note and list each such dependency it states.

Commitments:
${list.map(line).join('\n')}

For each dependency the note states, give one item:
- "quote": the exact words of the note that state it.
- "waiting": the label of the commitment that has to wait.
- "waitsFor": the label of the commitment it waits for, or "new" if that is not in the list.
- "newWhat": only if "waitsFor" is "new": what has to happen first, as a short imperative phrase without the person, e.g. "Confirm pricing". Otherwise "".
- "newOwner": only if "waitsFor" is "new": the name of the person who has to do it, "me" for the writer of the note. Otherwise "".

Rules:
- Only dependencies the note states, with words such as "once", "after", "until" or "waiting on". Do not infer one from two commitments being related.
- Use a label for what has to happen first only if it is the same action by the same person. Sharing a word is not enough: "Priya checks the numbers" is not "Check the numbers" owned by me. Otherwise use "new".
- A commitment never waits for itself.
- A note that states no dependency gives an empty list.

Examples. They use a different list:
[A1] Ship the report. Owner: me. For: Sam.
[B2] Sign off the numbers. Owner: Priya. For: me.
[C3] Check the budget. Owner: me. For: Priya.
Note: I'll ship the report to Sam once Priya signs off the numbers.
{"items":[{"quote":"once Priya signs off the numbers","waiting":"A1","waitsFor":"B2","newWhat":"","newOwner":""}]}
Note: I'll ship the report to Sam after Priya approves the budget.
{"items":[{"quote":"after Priya approves the budget","waiting":"A1","waitsFor":"new","newWhat":"Approve the budget","newOwner":"Priya"}]}

Note:
${note}`;
}

export function buildSchema(list) {
  const labels = list.map((c) => c.label);
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            quote: text,
            waiting: { type: 'string', enum: labels },
            waitsFor: { type: 'string', enum: [...labels, 'new'] },
            newWhat: text,
            newOwner: text,
          },
          required: ['quote', 'waiting', 'waitsFor', 'newWhat', 'newOwner'],
        },
      },
    },
    required: ['items'],
  };
}

const FIELDS = ['quote', 'waiting', 'waitsFor', 'newWhat', 'newOwner'];

// The same words in any order, small words aside: "budget review" and
// "Review the budget".
const SMALL = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'my', 'his', 'her', 'their', 'our']);
const bag = (text) => norm(text).split(' ').filter((w) => w && !SMALL.has(w)).sort().join(' ');
const sameWords = (a, b) => bag(a).length > 0 && bag(a) === bag(b);
// b is a's words and exactly one more.
const oneMore = (a, b) => {
  const [x, y] = [bag(a).split(' ').filter(Boolean), bag(b).split(' ').filter(Boolean)];
  const left = [...y];
  for (const w of x) { const at = left.indexOf(w); if (at < 0) return false; left.splice(at, 1); }
  return x.length > 0 && left.length === 1;
};
const MAX_ITEMS = 10;

// Checks the answer. Returns
//   dependencies  {quote, waiting: label, waitsFor: label} or
//                 {quote, waiting: label, waitsFor: 'new', newWhat, newOwner}
//   problems      what was refused, for the log
// A refused entry is not proposed: a dependency the note may state is only
// lost, never invented.
export function readDependencies(answer, { list, note }) {
  const problems = [];
  if (!answer || typeof answer !== 'object' || !Array.isArray(answer.items)) {
    return { ok: false, dependencies: [], problems: [{ reason: 'the answer has no list of items' }] };
  }
  if (answer.items.length > MAX_ITEMS) {
    return { ok: false, dependencies: [], problems: [{ reason: `it has ${answer.items.length} dependencies for one note` }] };
  }
  const labels = new Map(list.map((c) => [c.label, c]));
  const noteText = norm(note);
  const found = new Map();
  // The device model also reads a listed commitment as new ("budget review"
  // for "Review the budget"). A dependency on that copy is one on the listed
  // commitment: same words in any order, and the same person if it names one.
  const copyOf = new Map();
  for (const n of list.filter((c) => c.isNew)) {
    // One word more ("Send the budget review") only when it names the same person.
    const samePerson = (c) => norm(n.to) && norm(n.to) === norm(c.to);
    const same = list.filter((c) => !c.isNew && (sameWords(c.what, n.what) ? (!norm(n.to) || samePerson(c)) : (oneMore(c.what, n.what) && samePerson(c))));
    if (same.length === 1) copyOf.set(n.label, same[0].label);
  }
  const people = [...new Set(list.flatMap((c) => [c.owner, c.to]).map(norm).filter((p) => p && p !== 'me'))];
  // Only the words about what waits: "I can only send the proposal" out of
  // "... once Lee confirms pricing", where Lee is the one it waits for.
  const waitingWords = ` ${norm(beforeCue(note))} `;
  const named = people.filter((p) => waitingWords.includes(` ${p} `));
  for (const entry of answer.items) {
    const refuse = (reason) => problems.push({ reason, entry });
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { refuse('not an object'); continue; }
    const unknown = Object.keys(entry).find((key) => !FIELDS.includes(key));
    if (unknown) { refuse(`unknown field "${unknown}"`); continue; }
    const missing = FIELDS.find((key) => typeof entry[key] !== 'string');
    if (missing) { refuse(`"${missing}" is missing or not text`); continue; }
    if (copyOf.has(entry.waiting)) entry.waiting = copyOf.get(entry.waiting);
    if (copyOf.has(entry.waitsFor)) entry.waitsFor = copyOf.get(entry.waitsFor);
    // "The proposal for Lee waits ..." given as the proposal for Dana: the
    // words name people, none of them the waiting one's. The one of the same
    // wording that has a person named is what waits; with none, it is refused.
    const waitingOne = labels.get(entry.waiting);
    if (waitingOne && !waitingOne.isNew && named.length && !named.some((p) => [waitingOne.owner, waitingOne.to].map(norm).includes(p))) {
      const twins = list.filter((c) => c.label !== entry.waiting && !c.isNew && norm(c.what) === norm(waitingOne.what)
        && named.some((p) => [c.owner, c.to].map(norm).includes(p)));
      if (twins.length !== 1) { refuse(`the words name nobody "${waitingOne.what}" is for`); continue; }
      entry.waiting = twins[0].label;
    }
    if (!labels.has(entry.waiting)) { refuse(`"${entry.waiting}" is not a commitment the model was given`); continue; }
    let { waitsFor } = entry;
    const newWhat = entry.newWhat.trim();
    if (waitsFor === 'new') {
      if (!norm(newWhat)) { refuse('a new commitment to wait for does not say what it is'); continue; }
      if (!norm(entry.newOwner)) { refuse('a new commitment to wait for does not say who does it'); continue; }
      // Something the note also reads as new, said with the same words, is that one.
      const same = list.find((c) => c.isNew && norm(c.what) === norm(newWhat));
      if (same) waitsFor = same.label;
    } else if (!labels.has(waitsFor)) { refuse(`"${waitsFor}" is not a commitment the model was given`); continue; }
    if (waitsFor === entry.waiting) { refuse('a commitment cannot wait for itself'); continue; }
    // Nor for a copy of itself: the same wording, listed or new in this note
    // ("I'll send Dana the proposal tomorrow" read as the proposal waiting on
    // a new "Send the proposal").
    const whatOf = (label) => (label === 'new' ? newWhat : labels.get(label).what);
    if (norm(whatOf(waitsFor)) === norm(labels.get(entry.waiting).what)) { refuse('a commitment cannot wait for a copy of itself'); continue; }
    if (!norm(entry.quote) || !noteText.includes(norm(entry.quote))) { refuse('the quote is not in the note'); continue; }
    const dependency = waitsFor === 'new'
      ? { quote: entry.quote.trim(), waiting: entry.waiting, waitsFor, newWhat, newOwner: entry.newOwner.trim() }
      : { quote: entry.quote.trim(), waiting: entry.waiting, waitsFor };
    const key = [dependency.waiting, dependency.waitsFor, norm(dependency.newWhat)].join('|');
    if (found.has(key)) problems.push({ reason: 'a repeated dependency was dropped', entry });
    else found.set(key, dependency);
  }
  return { ok: true, dependencies: [...found.values()], problems };
}
