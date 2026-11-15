// Page for the candidate-linking experiment. Runs every case through Firebase
// AI Logic, on the device or in the cloud, and scores which commitment the
// model selected: once as returned, and once after the app rules.

import * as ai from './ai.js';
import { cases, orders, candidateList, variants, applyRules, score, summarise } from './linking-cases.js';

const $ = (id) => document.getElementById(id);

for (const [key, variant] of Object.entries(variants)) {
  $('variant').appendChild(new Option(variant.name, key));
}
$('variant').value = 'v2';

// Ask the built-in model what it is, through the raw Prompt API, so the result
// records whether Gemma 4 or Nano 3 answered. Self-report only.
async function deviceModelName() {
  if (!('LanguageModel' in self)) return 'no Prompt API in this browser';
  const state = await ai.deviceModelState();
  if (state !== 'available') return `not ready (${state})`;
  try {
    const session = await LanguageModel.create({
      expectedInputs: [{ type: 'text', languages: ['en'] }],
      expectedOutputs: [{ type: 'text', languages: ['en'] }],
    });
    const answer = await session.prompt('Which model are you, exactly? Give the model family and version only. If unsure of the version, say "unsure".');
    session.destroy();
    return answer.trim().slice(0, 200);
  } catch (err) {
    return `could not ask: ${err.message}`;
  }
}

let modelName = 'not asked';
deviceModelName().then((name) => {
  modelName = name;
  $('model-status').textContent = `Device model says: ${name}`;
});

if (ai.debugToken) {
  $('appcheck').textContent = `The cloud run needs this browser's App Check debug token registered in the Firebase console (App Check > Apps > Manage debug tokens): ${ai.debugToken}`;
}

const verdict = (s, error) => {
  if (error) return 'error';
  if (s.invalid) return 'invalid JSON';
  if (s.pass) return 'pass';
  return s.safe ? 'question' : 'unsafe';
};

function problems(s) {
  return [
    s.wrong.length && `wrong commitment: ${s.wrong.join(', ')}`,
    s.guessed.length && `guessed: ${s.guessed.join(', ')}`,
    s.missed.length && `missed: ${s.missed.join(', ')}`,
    s.badDue.length && `wrong date: ${s.badDue.join(', ')}`,
    !s.invalid && s.newCount !== s.newExpected && `new: ${s.newCount}, expected ${s.newExpected}`,
    s.unclear > 0 && `asks: ${s.unclear}`,
  ].filter(Boolean).join('; ');
}

function showRows(rows) {
  const table = document.createElement('table');
  const head = table.insertRow();
  for (const name of ['case', 'order', 'note', 'as returned', 'after app rules', 'model returned', 'ms']) {
    head.appendChild(document.createElement('th')).textContent = name;
  }
  for (const row of rows) {
    const tr = table.insertRow();
    const returned = row.read
      ? [...row.read.updates.map((u) => `${u.commitment}: ${u.change}${u.due ? ` (${u.due})` : ''}`),
        ...row.read.newCommitments.map((n) => `new: ${n.what}`)].join('; ') || 'nothing'
      : row.error ?? row.raw ?? '';
    const cell = (s) => `${verdict(s, row.error)}${s.pass || row.error ? '' : `: ${problems(s)}`}`;
    for (const text of [row.id, row.order, row.note, cell(row.score), cell(row.ruled), returned, row.ms ?? '']) {
      tr.insertCell().textContent = text;
    }
    for (const [index, s] of [[3, row.score], [4, row.ruled]]) {
      tr.cells[index].className = s.pass ? 'ok' : s.safe && !row.error ? '' : 'bad';
    }
  }
  $('rows').replaceChildren(table);
}

// The cloud model's free tier allows 15 requests a minute. Cloud calls are
// spaced out to stay under that, and a call refused for quota waits and is
// tried again. Device calls are not delayed.
const CLOUD_GAP_MS = 4500;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let lastCloudCall = 0;

async function paced(mode, label, call) {
  if (mode !== ai.InferenceMode.ONLY_IN_CLOUD) return call();
  for (let attempt = 1; ; attempt++) {
    const since = Date.now() - lastCloudCall;
    if (since < CLOUD_GAP_MS) await wait(CLOUD_GAP_MS - since);
    lastCloudCall = Date.now();
    try {
      return await call();
    } catch (err) {
      if (attempt >= 3 || !/\b429\b|quota/i.test(err.message)) throw err;
      const seconds = Number(/retry in ([\d.]+)s/i.exec(err.message)?.[1] ?? 30) + 2;
      $('progress').textContent = `${label}: over the rate limit, waiting ${Math.ceil(seconds)} s`;
      await wait(seconds * 1000);
    }
  }
}

async function run(mode, label) {
  const controls = ['run-device', 'run-cloud', 'variant'];
  for (const id of controls) $(id).disabled = true;
  const variantKey = $('variant').value;
  const variant = variants[variantKey];
  const rows = [];
  const total = cases.length * orders.length;
  try {
    for (const testCase of cases) {
      for (const order of orders) {
        $('progress').textContent = `${label}: ${rows.length + 1} of ${total}`;
        const list = candidateList(testCase, order);
        const row = { id: testCase.id, order, note: testCase.note, labels: list.map((c) => c.label) };
        try {
          const result = await paced(mode, label, () =>
            ai.generateStructured(variant.buildPrompt(testCase.note, list), variant.buildSchema(list), mode));
          Object.assign(row, { source: result.source, ms: result.ms, parsed: result.parsed, raw: result.parsed ? undefined : result.raw });
          row.read = variant.read(result.parsed);
        } catch (err) {
          row.error = err.message;
        }
        row.score = score(row.read, testCase);
        const ruled = applyRules(row.read, list);
        row.ruled = score(ruled, testCase);
        row.ruleNotes = ruled?.notes ?? [];
        rows.push(row);
        showRows(rows);
      }
    }
  } finally {
    for (const id of controls) $(id).disabled = false;
  }
  // The held-out cases are reported apart: nothing was tuned against them.
  const summary = {};
  for (const set of ['dev', 'holdout']) {
    const ids = new Set(cases.filter((c) => c.set === set).map((c) => c.id));
    const part = rows.filter((r) => ids.has(r.id));
    summary[set] = { asReturned: summarise(part), afterAppRules: summarise(part, 'ruled') };
  }
  const firstError = rows.find((r) => r.error)?.error;
  const report = {
    experiment: 'candidate-linking',
    variant: variantKey,
    ranAt: new Date().toISOString(),
    mode,
    deviceModelSays: modelName,
    cloudModel: ai.CLOUD_MODEL,
    userAgent: navigator.userAgent,
    sources: [...new Set(rows.map((r) => r.source ?? 'error'))],
    summary,
    firstError,
    // Kept short: the answers can be scored again from "parsed". Errors repeat,
    // so one copy of the message is kept above.
    rows: rows.map((r) => ({
      id: r.id, order: r.order, ms: r.ms, parsed: r.parsed, raw: r.raw,
      asReturned: verdict(r.score, r.error), afterAppRules: verdict(r.ruled, r.error), ruleNotes: r.ruleNotes.length ? r.ruleNotes : undefined,
    })),
  };
  $('progress').textContent = `${label}: done`;
  $('summary').textContent = JSON.stringify(firstError ? { ...summary, firstError } : summary, null, 2);
  $('report').value = JSON.stringify(report);
}

$('run-device').onclick = () => run(ai.InferenceMode.ONLY_ON_DEVICE, 'Device');
$('run-cloud').onclick = () => run(ai.InferenceMode.ONLY_IN_CLOUD, 'Cloud');
// The raw report of a run is the only record of what the model returned.
$('save').onclick = () => {
  const text = $('report').value;
  if (!text) return;
  const { variant, mode, ranAt } = JSON.parse(text);
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = `linking-${variant}-${mode}-${ranAt.replace(/[:.]/g, '-')}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
};
$('copy').onclick = async () => {
  $('report').select();
  await navigator.clipboard.writeText($('report').value);
};
