// The capture evaluation page: every note of evaluation.js through
// pipeline.readNote with the cloud model, each into a freshly built workspace.

import * as db from './db.js';
import * as ai from './ai.js';
import * as pipeline from './pipeline.js';
import * as e from './evaluation.js';

const STORE = 'opfs://kept-eval';
const $ = (id) => document.getElementById(id);
const q = (statement, params) => db.query(statement, params);

if (ai.debugToken) {
  $('appcheck').textContent = `On localhost the cloud model needs this browser's App Check debug token registered in the Firebase console: ${ai.debugToken}`;
}

// The free tier allows 15 requests a minute: calls are spaced out, and one
// refused for quota waits and is tried again.
const GAP_MS = 4500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let last = 0;
async function generate(prompt, schema) {
  for (let attempt = 1; ; attempt++) {
    const since = Date.now() - last;
    if (since < GAP_MS) await wait(GAP_MS - since);
    last = Date.now();
    try {
      // A call that never answers fails the note instead of stopping the run.
      return await Promise.race([
        ai.generateStructured(prompt, schema, ai.InferenceMode.ONLY_IN_CLOUD),
        wait(60000).then(() => { throw new Error('the model did not answer within 60 s'); }),
      ]);
    } catch (err) {
      if (attempt >= 3 || !/\b429\b|quota/i.test(err.message)) throw err;
      await wait((Number(/retry in ([\d.]+)s/i.exec(err.message)?.[1] ?? 30) + 2) * 1000);
    }
  }
}

function show(rows) {
  const table = document.createElement('table');
  const head = table.insertRow();
  for (const name of ['note', 'group', 'verdict', 'what went wrong', 'came out']) head.appendChild(document.createElement('th')).textContent = name;
  for (const row of rows) {
    const tr = table.insertRow();
    const s = row.score;
    const problems = row.error ? row.error : [
      ...s.wrong.map((x) => `wrong: ${x}`), ...s.guessed.map((x) => `guessed: ${x}`), ...s.missed.map((x) => `missed: ${x}`),
      ...s.missedCreated.map((x) => `new not found: ${x}`), ...s.extraCreated.map((x) => `new, not expected: ${x}`),
      ...s.cardErrors.map((x) => `card: ${x}`), ...s.wrongDeps.map((x) => `dependency not stated: ${x}`),
      ...s.missedDeps.map((x) => `dependency missed: ${x}`), s.needlessQuestions ? `${s.needlessQuestions} needless question(s)` : '',
      ...row.observed.manual.map((x) => `by hand: ${x}`),
    ].filter(Boolean).join('; ');
    const o = row.observed;
    const out = o ? [
      ...o.changes.map((x) => `${x.on}: ${x.kind}${x.due ? ` ${x.due}` : ''}`),
      ...o.created.map((x) => `new "${x.what}" ${x.owner ?? '?'} to ${x.to ?? 'nobody'}${x.due ? ` ${x.due}` : ''}${x.how === 'card' ? '' : ` (${x.how})`}`),
      ...o.deps.map((x) => `${x.waiting} waits for ${x.on}`),
      ...o.questions.map((x) => `asks: ${x.options.map((p) => p.on).join(' | ')}`),
    ].join('; ') || 'nothing' : '';
    for (const text of [row.note, row.group, row.error ? 'error' : s.verdict, problems, out]) tr.insertCell().textContent = text;
    tr.cells[2].className = row.error ? 'unsafe' : s.verdict;
  }
  $('rows').replaceChildren(table);
}

$('run').onclick = async () => {
  $('run').disabled = true;
  const rows = [];
  try {
    for (const [index, testCase] of e.cases.entries()) {
      $('progress').textContent = `${index + 1} of ${e.cases.length}`;
      const row = { id: testCase.id, group: testCase.group, note: testCase.note };
      try {
        // A reset that never finishes fails the note too.
        await Promise.race([db.reset(), wait(30000).then(() => { throw new Error('the store did not reset within 30 s'); })]);
        const ws = await e.seedWorkspace(q);
        const result = await pipeline.readNote(q, { text: testCase.note, ...e.NOTE_TIME, generate, extractedBy: `cloud:${ai.CLOUD_MODEL}` });
        row.observed = await e.observe(q, result, ws);
        row.score = e.score(row.observed, testCase.expect);
        row.raw = { linking: result.linking.parsed, linkingMs: result.linking.ms, source: result.linking.source, deps: result.deps };
      } catch (err) {
        row.error = err.message;
      }
      rows.push(row);
      show(rows);
    }
  } finally {
    $('run').disabled = false;
  }
  const summary = e.summarise(rows);
  $('summary').textContent = JSON.stringify(summary, null, 2);
  $('report').value = JSON.stringify({
    evaluation: 'capture', ranAt: new Date().toISOString(), cloudModel: ai.CLOUD_MODEL, linkingPrompt: 'v2',
    userAgent: navigator.userAgent, summary, rows,
  });
  $('progress').textContent = 'done';
};

$('copy').onclick = () => navigator.clipboard.writeText($('report').value);

db.init((msg) => {
  $('progress').textContent = msg.type === 'open-failed' ? `The store did not open: ${msg.error}` : 'ready';
}, STORE);
