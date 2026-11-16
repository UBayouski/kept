// A second look at "done" and "cancelled" readings: one small model call that
// asks, for each, whether the note says it happened, that it will not happen,
// or neither. Its answer never makes a proposal by itself (see reading.js):
// it can only hold a reading back, or turn one the words do not support into
// a question. Pure functions; the pipeline makes the call.

import { norm } from './reading.js';

export const ANSWERS = ['happened', 'off', 'neither'];

// items: [{id, quote, what}]
export function buildPrompt(note, items) {
  return `Read the note. For each statement below, say what the note says about it:
- "happened": the note says it has been done ("I sent it", "Omar booked the venue").
- "off": the note says it will not be done any more ("called off", "no longer needed").
- "neither": the note only mentions it, talks about it, describes it, or says it will happen later.

Statements:
${items.map((i) => `[${i.id}] ${i.what}`).join('\n')}

Note:
${note}`;
}

export function buildSchema(items) {
  return {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: { id: { type: 'string', enum: items.map((i) => i.id) }, answer: { type: 'string', enum: ANSWERS } },
          required: ['id', 'answer'],
        },
      },
    },
    required: ['items'],
  };
}

// The key a reading is looked up by: its commitment label and quote.
export const keyOf = (label, quote) => `${label}|${norm(quote)}`;

// Map key -> 'happened' | 'off' | 'neither'. Anything not understood is left
// out, and the word rules decide for it.
export function readAnswer(answer, items) {
  const out = new Map();
  if (!answer || !Array.isArray(answer.items)) return out;
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const entry of answer.items) {
    const item = entry && byId.get(entry.id);
    if (!item || !ANSWERS.includes(entry.answer) || out.has(item.key)) continue;
    out.set(item.key, entry.answer);
  }
  return out;
}
