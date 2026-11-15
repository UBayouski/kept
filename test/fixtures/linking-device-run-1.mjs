// What the device model returned in the first linking run, transcribed from
// the result the user pasted. Gemma 4 (self-reported), Chrome 157 on Windows,
// only-on-device, prompt variant v1, 2026-11-15T19:46Z. One run per row.
// Row: [case id, list order, updates, new commitments]
//   update: [commitment, change, due, quote]     new: [what, to, due, quote]

const N = {
  dp: 'Dana agreed we can send the proposal Tuesday.',
  dc: 'Dana says the contract can wait until Wednesday.',
  sc: 'Sent Dana the contract this morning.',
  lp: "Lee's pricing is delayed until Monday.",
  lc: 'Lee confirmed the pricing today.',
  cp: "Dana doesn't need the proposal any more.",
  tu: 'The proposal goes to Dana on Tuesday and the contract on Thursday.',
  inv: "I'll send Dana the invoice by Friday.",
  room: "I'll book a room for Thursday's workshop with Dana.",
  it: 'Dana moved it to Tuesday.',
  doc: 'Dana wants the document on Wednesday now.',
  tl: 'Lee needs the proposal by Monday.',
  td: 'Dana agreed the proposal can come Tuesday.',
  ta: 'The proposal is pushed back to next week.',
};
const D = 'new deadline';

export const rows = [
  ['deadline-proposal', 'listed', [['K7', D, 'Tuesday', N.dp]], [['Send the proposal', 'Dana', 'Tuesday', 'send the proposal']]],
  ['deadline-proposal', 'reversed', [['K7', D, 'Tuesday', N.dp]], []],
  ['deadline-contract', 'listed', [['R2', D, 'Wednesday', N.dc]], []],
  ['deadline-contract', 'reversed', [['R2', D, 'Wednesday', N.dc], ['K7', D, 'Wednesday', N.dc]], []],
  ['done-contract', 'listed', [['R2', 'done', '', N.sc]], []],
  ['done-contract', 'reversed', [['R2', 'done', '', N.sc], ['K7', 'done', '', N.sc]], []],
  ['deadline-pricing', 'listed', [['M5', D, 'Monday', N.lp]], []],
  ['deadline-pricing', 'reversed', [['M5', D, 'Monday', N.lp]], []],
  ['done-pricing', 'listed', [['M5', 'done', '', N.lc]], []],
  ['done-pricing', 'reversed', [['M5', 'done', '', N.lc]], []],
  ['cancel-proposal', 'listed', [['K7', 'done', '', N.cp]], []],
  ['cancel-proposal', 'reversed', [['K7', 'cancelled', '', N.cp]], []],
  ['two-updates', 'listed', [['K7', D, 'Tuesday', N.tu], ['R2', D, 'Thursday', N.tu]], []],
  ['two-updates', 'reversed', [['K7', D, 'Tuesday', N.tu], ['R2', D, 'Thursday', N.tu]],
    [['Proposal to go to Dana', 'Dana', 'Tuesday', N.tu], ['Contract to go', 'Dana', 'Thursday', N.tu]]],
  ['none-new-similar', 'listed', [['K7', D, 'Friday', N.inv]], [['send the invoice', 'Dana', 'Friday', "I'll send Dana the invoice"]]],
  ['none-new-similar', 'reversed', [['R2', D, 'Friday', N.inv]], [['send the invoice', 'Dana', 'Friday', N.inv]]],
  ['none-new-different', 'listed', [['K7', D, 'Thursday', N.room]],
    [["book a room for Thursday's workshop", 'Dana', 'Thursday', "book a room for Thursday's workshop with Dana"]]],
  ['none-new-different', 'reversed', [['K7', D, 'Thursday', N.room]], []],
  ['nothing', 'listed', [['unclear', 'done', '', 'Lunch with Dana was nice.']], []],
  ['nothing', 'reversed', [['unclear', 'done', '', 'Lunch with Dana was nice. The weather was awful.']], []],
  ['ambiguous-it', 'listed', [['K7', D, 'Tuesday', N.it], ['R2', D, 'Tuesday', N.it]], []],
  ['ambiguous-it', 'reversed', [['R2', D, 'Tuesday', N.it], ['K7', D, 'Tuesday', N.it]], []],
  ['ambiguous-both', 'listed', [['K7', D, 'Wednesday', N.doc], ['R2', D, 'Wednesday', N.doc]], []],
  ['ambiguous-both', 'reversed', [['R2', D, 'Wednesday', N.doc], ['K7', D, 'Wednesday', N.doc]], [['document', 'Dana', 'Wednesday', N.doc]]],
  ['twin-lee', 'listed', [['T9', D, 'Monday', N.tl]], []],
  ['twin-lee', 'reversed', [['T9', D, 'Monday', N.tl]], []],
  ['twin-dana', 'listed', [['K7', D, 'Tuesday', N.td]], [['Send the proposal', 'Dana', 'Tuesday', 'the proposal']]],
  ['twin-dana', 'reversed', [['K7', D, 'Tuesday', N.td]], []],
  ['twin-ambiguous', 'listed', [['K7', D, '', N.ta], ['T9', D, '', N.ta]], []],
  ['twin-ambiguous', 'reversed', [['T9', D, 'next week', N.ta], ['K7', D, 'next week', N.ta]], []],
].map(([id, order, updates, created]) => ({
  id,
  order,
  parsed: {
    updates: updates.map(([commitment, change, due, quote]) => ({ quote, commitment, change, due })),
    newCommitments: created.map(([what, to, due, quote]) => ({ quote, what, owner: 'me', to, due })),
  },
}));

// The summary the page reported for this run, before any app rules.
export const reported = { runs: 30, passed: 12, wrongCommitment: 7, guessedWhenAmbiguous: 6, missedUpdate: 1, wrongDate: 0, wrongNewCount: 5 };
