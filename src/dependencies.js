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
- If what has to happen first is in the list, use its label, not "new".
- A commitment never waits for itself.
- A note that states no dependency gives an empty list.

Example. It uses a different list:
[A1] Ship the report. Owner: me. For: Sam.
[B2] Sign off the numbers. Owner: Priya. For: me.
Note: I'll ship the report to Sam once Priya signs off the numbers, and the slides after Omar sends the logo.
{"items":[{"quote":"once Priya signs off the numbers","waiting":"A1","waitsFor":"B2","newWhat":"","newOwner":""}]}

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
  for (const entry of answer.items) {
    const refuse = (reason) => problems.push({ reason, entry });
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { refuse('not an object'); continue; }
    const unknown = Object.keys(entry).find((key) => !FIELDS.includes(key));
    if (unknown) { refuse(`unknown field "${unknown}"`); continue; }
    const missing = FIELDS.find((key) => typeof entry[key] !== 'string');
    if (missing) { refuse(`"${missing}" is missing or not text`); continue; }
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
