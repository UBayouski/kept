import * as db from './db.js';
import * as ai from './ai.js';
import * as graph from './graph.js';

const $ = (id) => document.getElementById(id);
const out = (value) => {
  $('out').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};

async function showStatus() {
  const [{ version }] = await db.query(
    "CALL dbms.components() YIELD name, versions WHERE name = 'Relate' RETURN versions[0] AS version",
  );
  const [{ n }] = await db.query('MATCH (c:Commitment) RETURN count(c) AS n');
  $('db-status').innerHTML = `<span class="ok">Relate ${version} open, ${n} commitment(s) stored.</span>`;
}

db.init(async (msg) => {
  if (msg.type === 'open-failed') {
    $('db-status').innerHTML = `<span class="bad">Store failed to open: ${msg.error}</span>`;
    return;
  }
  try {
    await showStatus();
  } catch (err) {
    $('db-status').innerHTML = `<span class="bad">${err.message}</span>`;
  }
});

async function listCommitments() {
  const rows = await db.query(
    `MATCH (c:Commitment)-[:EVIDENCED_BY]->(e:Evidence)
     RETURN c.id AS id, c.status AS status, e.text AS evidence, e.capturedAt AS capturedAt
     ORDER BY capturedAt`,
  );
  out(rows);
}

$('add').onclick = async () => {
  try {
    // One statement, so the commitment and its evidence land together.
    await db.query(
      `CREATE (c:Commitment {id: $id, status: 'unreviewed'})
       CREATE (e:Evidence {text: $text, capturedAt: $now})
       CREATE (c)-[:EVIDENCED_BY]->(e)`,
      { id: crypto.randomUUID(), text: $('note').value, now: new Date().toISOString() },
    );
    await showStatus();
    await listCommitments();
  } catch (err) {
    out(`Error: ${err.message}`);
  }
};

$('list').onclick = () => listCommitments().catch((err) => out(`Error: ${err.message}`));

$('restart').onclick = () => {
  $('db-status').textContent = 'Restarting worker…';
  db.restart();
};

$('reset').onclick = async () => {
  try {
    await db.reset();
    await showStatus();
    out('Store emptied.');
  } catch (err) {
    out(`Error: ${err.message}`);
  }
};

// Exposed for checks from the console.
window.kept = { query: db.query };

// --- Hybrid extraction ---

// Record every request the page makes to a Google API host, so an
// only-on-device run can show that nothing left the browser.
const cloudCalls = [];
const realFetch = window.fetch.bind(window);
window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input.url ?? String(input);
  if (/googleapis\.com/.test(url)) cloudCalls.push(new URL(url).host + new URL(url).pathname);
  return realFetch(input, init);
};

const aiOut = (value) => {
  $('ai-out').textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
};

const stateText = {
  available: 'Device model: ready.',
  downloadable: 'Device model: not downloaded. Until it is, only the cloud can answer.',
  downloading: 'Device model: downloading…',
  unavailable: 'Device model: not supported in this browser. Only the cloud can answer.',
};

async function showAvailability() {
  const state = await ai.deviceModelState();
  $('ai-status').textContent = stateText[state] ?? `Device model: ${state}.`;
  // The download needs a click: Chrome refuses to start it without a user gesture.
  $('download').hidden = state !== 'downloadable' && state !== 'downloading';
  $('download').textContent = state === 'downloading' ? 'Show download progress' : 'Download device model';
  return state;
}
const availabilityFailed = (err) => ($('ai-status').textContent = `Availability check failed: ${err.message}`);
showAvailability().catch(availabilityFailed);

$('download').onclick = async () => {
  const bar = $('download-progress');
  $('download').disabled = true;
  bar.hidden = false;
  bar.value = 0;
  $('ai-status').textContent = 'Device model: downloading… 0%';
  try {
    await ai.prepareDeviceModel((fraction) => {
      bar.value = fraction;
      $('ai-status').textContent = `Device model: downloading… ${Math.round(fraction * 100)}%`;
    });
    const state = await showAvailability();
    if (state !== 'available') $('ai-status').textContent += ' The download did not finish; try again.';
  } catch (err) {
    $('ai-status').textContent = `Download failed: ${err.message}`;
  } finally {
    bar.hidden = true;
    $('download').disabled = false;
  }
};

async function runExtraction(save) {
  const mode = $('mode').value;
  const note = $('note').value;
  const before = cloudCalls.length;
  aiOut('Running…');
  try {
    const result = await ai.extract(note, mode);
    const report = { mode, ...result, cloudRequests: cloudCalls.slice(before) };
    if (save) {
      report.saved = await graph.saveExtraction(note, result);
      await showStatus();
      await showAttention();
    }
    aiOut(report);
  } catch (err) {
    aiOut({ mode, error: err.message, cloudRequests: cloudCalls.slice(before) });
  }
}

$('extract').onclick = () => runExtraction(false);
$('extract-save').onclick = () => runExtraction(true);

// --- The graph answers; no model involved ---

async function showAttention() {
  const rows = await graph.attention();
  const target = $('attention-out');
  target.replaceChildren();
  if (rows.length === 0) {
    target.textContent = 'Nothing open.';
    return;
  }
  // The worker returns row keys in alphabetical order; show them in reading order.
  const columns = ['what', 'status', 'due', 'previouslyDue', 'blockedBy', 'waitingOn'];
  const table = document.createElement('table');
  const head = table.insertRow();
  for (const name of columns) head.appendChild(document.createElement('th')).textContent = name;
  for (const row of rows) {
    const tr = table.insertRow();
    for (const name of columns) tr.insertCell().textContent = row[name] ?? '';
  }
  target.appendChild(table);
}

const reportError = (err) => ($('attention-out').textContent = `Error: ${err.message}`);

$('attention').onclick = () => showAttention().catch(reportError);

$('seed').onclick = async () => {
  try {
    await graph.loadSeed();
    await showStatus();
    await showAttention();
  } catch (err) {
    reportError(err);
  }
};

if (ai.debugToken) {
  $('appcheck').textContent = `App Check debug token for this browser (register it in the Firebase console): ${ai.debugToken}`;
}

window.kept.extract = ai.extract;
window.kept.graph = graph;
