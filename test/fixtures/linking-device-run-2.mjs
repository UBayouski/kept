// What the device model returned in the second linking run, transcribed from
// the result the user pasted. Gemma 4 (self-reported), Chrome 157 on Windows,
// only-on-device, prompt variant v2, 2026-11-15T19:59Z. One run per row.
// Row: [case id, list order, items]   item: [about, change, due]
// Every answer had exactly one item per statement; quotes are left out and
// each item is given its own, since no two items shared one.

const D = 'new deadline';

export const rows = [
  ['deadline-proposal', 'listed', [['K7', D, 'Tuesday']]],
  ['deadline-proposal', 'reversed', [['K7', D, 'Tuesday']]],
  ['deadline-contract', 'listed', [['R2', D, 'Wednesday']]],
  ['deadline-contract', 'reversed', [['M5', D, 'Wednesday']]],
  ['done-contract', 'listed', [['R2', 'done', '']]],
  ['done-contract', 'reversed', [['R2', 'done', '']]],
  ['deadline-pricing', 'listed', [['M5', D, 'Monday']]],
  ['deadline-pricing', 'reversed', [['M5', D, 'Monday']]],
  ['done-pricing', 'listed', [['M5', 'done', '']]],
  ['done-pricing', 'reversed', [['M5', 'done', '']]],
  ['cancel-proposal', 'listed', [['K7', 'done', '']]],
  ['cancel-proposal', 'reversed', [['K7', 'done', '']]],
  ['two-updates', 'listed', [['K7', D, 'Tuesday'], ['R2', D, 'Thursday']]],
  ['two-updates', 'reversed', [['K7', D, 'Tuesday'], ['R2', D, 'Thursday']]],
  ['none-new-similar', 'listed', [['new', 'new commitment', 'Friday']]],
  ['none-new-similar', 'reversed', [['new', 'new commitment', 'Friday']]],
  ['none-new-different', 'listed', [['new', 'new commitment', 'Thursday']]],
  ['none-new-different', 'reversed', [['new', 'new commitment', 'Thursday']]],
  ['nothing', 'listed', []],
  ['nothing', 'reversed', []],
  ['ambiguous-it', 'listed', [['K7', D, 'Tuesday']]],
  ['ambiguous-it', 'reversed', [['R2', D, 'Tuesday']]],
  ['ambiguous-both', 'listed', [['K7', D, 'Wednesday']]],
  ['ambiguous-both', 'reversed', [['R2', D, 'Wednesday']]],
  ['twin-lee', 'listed', [['T9', D, 'Monday']]],
  ['twin-lee', 'reversed', [['T9', D, 'Monday']]],
  ['twin-dana', 'listed', [['K7', D, 'Tuesday']]],
  ['twin-dana', 'reversed', [['K7', D, 'Tuesday']]],
  ['twin-ambiguous', 'listed', [['K7', D, 'next week']]],
  ['twin-ambiguous', 'reversed', [['T9', D, 'next week']]],
].map(([id, order, items]) => ({
  id,
  order,
  parsed: { items: items.map(([about, change, due], index) => ({ quote: `statement ${index + 1}`, about, change, due, what: about === 'new' ? 'something new' : '' })) },
}));

// The summary the page reported, identical as returned and after the app rules.
export const reported = { runs: 30, passed: 21, unsafe: 9, wrongCommitment: 3, guessedWhenAmbiguous: 6, missedUpdate: 3, wrongDate: 0, wrongNewCount: 0 };
