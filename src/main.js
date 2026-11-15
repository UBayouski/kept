import * as db from './db.js';

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
